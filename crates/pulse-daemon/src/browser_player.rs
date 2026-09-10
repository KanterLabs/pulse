//! Restricted loopback transport for the standalone Pulse browser player.
//!
//! The helper publishes a short-lived descriptor in the user's runtime directory.  The
//! descriptor is intentionally rediscovered before every request so restarting or replacing the
//! helper retires the old endpoint and capability token immediately.

use std::env;
use std::fs::{self, File, Metadata, symlink_metadata};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::{Client, Method, StatusCode, redirect::Policy};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use url::Url;

use crate::error::{PulseError, Result};
use crate::model::PlaybackSnapshot;

const DESCRIPTOR_LIMIT: usize = 4 * 1024;
const RESPONSE_LIMIT: usize = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(7);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const RUNTIME_NAMESPACE: &str = "pulse-player";
const DESCRIPTOR_NAME: &str = "bridge.json";

/// Metadata returned by the helper's authentication endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub struct BrowserAuthState {
    pub configured: bool,
    pub authenticated: bool,
}

/// The short-lived access token exposed by the helper for Spotify Web API browsing.
///
/// This type deliberately has no `Debug` implementation: an access token must never appear in
/// daemon diagnostics or test failure output.
#[derive(Clone, Deserialize)]
pub struct BrowserToken {
    pub access_token: String,
    pub expires_in: u64,
    pub scope: String,
}

#[derive(Clone)]
pub struct BrowserPlayer {
    http: Client,
    runtime_dir: Option<PathBuf>,
}

impl std::fmt::Debug for BrowserPlayer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BrowserPlayer")
            .field("transport", &"127.0.0.1 loopback")
            .finish_non_exhaustive()
    }
}

impl BrowserPlayer {
    /// Build a helper client with a hard deadline and no redirects.
    pub fn new() -> Result<Self> {
        Self::build(None)
    }

    /// Build a client rooted at an explicit runtime directory. This is useful for isolated
    /// callers and tests; production callers should use [`Self::new`] so every request resolves
    /// the current `XDG_RUNTIME_DIR` value.
    pub fn new_with_runtime_dir(runtime_dir: impl Into<PathBuf>) -> Result<Self> {
        Self::build(Some(runtime_dir.into()))
    }

    fn build(runtime_dir: Option<PathBuf>) -> Result<Self> {
        let http = Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(Policy::none())
            .user_agent(concat!("pulse-daemon/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| PulseError::NotFound("browser player transport is unavailable".into()))?;
        Ok(Self { http, runtime_dir })
    }

    /// Poll the helper's authoritative playback state.
    ///
    /// A missing, replaced, or unreachable helper is represented as a disconnected snapshot so
    /// callers can keep their normal playback polling loop alive.  A reachable helper returning
    /// malformed JSON is surfaced to the caller instead of being silently converted to a stale
    /// state.
    pub async fn snapshot(&self) -> Result<PlaybackSnapshot> {
        match self
            .request::<PlaybackSnapshot, ()>(
                Method::GET,
                "/bridge/snapshot",
                None::<&()>,
                REQUEST_TIMEOUT,
            )
            .await
        {
            Ok(mut snapshot) => {
                snapshot.normalize();
                if matches!(snapshot.status, crate::model::PlaybackStatus::Disconnected)
                    && snapshot.error.is_none()
                {
                    snapshot.error = Some(
                        "Pulse player helper is offline; start or reconnect the player.".into(),
                    );
                }
                Ok(snapshot)
            }
            Err(error) if is_helper_unavailable(&error) => {
                Ok(PlaybackSnapshot::disconnected(Some(error.to_string())))
            }
            Err(error) => Err(error),
        }
    }

    pub async fn play_pause(&self) -> Result<()> {
        self.command(CommandRequest::simple("play_pause")).await
    }

    pub async fn next(&self) -> Result<()> {
        self.command(CommandRequest::simple("next")).await
    }

    pub async fn previous(&self) -> Result<()> {
        self.command(CommandRequest::simple("previous")).await
    }

    pub async fn seek(&self, position_us: i64) -> Result<()> {
        if position_us < 0 {
            return Err(PulseError::InvalidInput(
                "seek position cannot be negative".into(),
            ));
        }
        self.command(CommandRequest {
            command: "seek",
            position_us: Some(position_us),
            uri: None,
        })
        .await
    }

    pub async fn open_uri(&self, uri: &str) -> Result<()> {
        let parsed = Url::parse(uri)
            .map_err(|error| PulseError::InvalidInput(format!("invalid URI: {error}")))?;
        if parsed.scheme() != "spotify" || !is_supported_spotify_uri(uri) {
            return Err(PulseError::InvalidInput(
                "browser playback only accepts spotify URIs".into(),
            ));
        }
        self.command(CommandRequest {
            command: "open_uri",
            position_us: None,
            uri: Some(uri.to_owned()),
        })
        .await
    }

    pub async fn auth_state(&self) -> Result<BrowserAuthState> {
        self.request(Method::GET, "/bridge/auth", None::<&()>, REQUEST_TIMEOUT)
            .await
    }

    pub async fn token(&self) -> Result<BrowserToken> {
        self.request(Method::GET, "/bridge/token", None::<&()>, REQUEST_TIMEOUT)
            .await
    }

    /// Start the helper setup page. The caller is responsible for opening the returned URL in the
    /// user's browser through the existing desktop integration.
    pub async fn begin_login(&self) -> Result<String> {
        let response: LoginResponse = self
            .request(Method::POST, "/bridge/login", Some(&()), REQUEST_TIMEOUT)
            .await?;
        let parsed = Url::parse(&response.url).map_err(|_| {
            PulseError::AuthenticationFailed("browser player returned an invalid setup URL".into())
        })?;
        let valid = parsed.scheme() == "http"
            && parsed.host_str() == Some("127.0.0.1")
            && parsed.port().is_some()
            && parsed.path() == "/"
            && parsed.query().is_none()
            && parsed.fragment().is_none();
        if !valid {
            return Err(PulseError::AuthenticationFailed(
                "browser player returned an invalid setup URL".into(),
            ));
        }
        Ok(response.url)
    }

    pub async fn logout(&self) -> Result<()> {
        let response: AckResponse = self
            .request(Method::POST, "/bridge/logout", Some(&()), REQUEST_TIMEOUT)
            .await?;
        if !response.ok {
            return Err(PulseError::NotFound(
                "browser player rejected logout".into(),
            ));
        }
        Ok(())
    }

    async fn command(&self, command: CommandRequest) -> Result<()> {
        let response: AckResponse = self
            .request(
                Method::POST,
                "/bridge/command",
                Some(&command),
                COMMAND_TIMEOUT,
            )
            .await?;
        if !response.ok {
            return Err(PulseError::NotFound(
                "browser player rejected playback command".into(),
            ));
        }
        Ok(())
    }

    async fn request<T, B>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        timeout: Duration,
    ) -> Result<T>
    where
        T: DeserializeOwned,
        B: Serialize + ?Sized,
    {
        let descriptor = read_descriptor(self.runtime_dir.as_deref())?;
        let endpoint = format!("http://127.0.0.1:{}{path}", descriptor.port);
        let mut request = self.http.request(method, endpoint).header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", descriptor.secret),
        );
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = tokio::time::timeout(timeout, request.send())
            .await
            .map_err(|_| {
                PulseError::NotFound("browser player helper did not respond in time".into())
            })?
            .map_err(|_| PulseError::NotFound("browser player helper is unreachable".into()))?;
        let status = response.status();
        let body = read_response_bounded(response).await?;
        if !status.is_success() {
            return Err(http_status_error(status));
        }
        serde_json::from_slice(&body).map_err(Into::into)
    }
}

#[derive(Debug, Serialize)]
struct CommandRequest {
    command: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    position_us: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    uri: Option<String>,
}

impl CommandRequest {
    const fn simple(command: &'static str) -> Self {
        Self {
            command,
            position_us: None,
            uri: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct AckResponse {
    ok: bool,
}

#[derive(Debug, Deserialize)]
struct LoginResponse {
    url: String,
}

#[derive(Debug)]
struct Descriptor {
    port: u16,
    secret: String,
}

fn descriptor_path(runtime_dir: Option<&Path>) -> Result<PathBuf> {
    let runtime = runtime_dir.map_or_else(
        || {
            env::var_os("XDG_RUNTIME_DIR")
                .map(PathBuf::from)
                .ok_or_else(|| unavailable("XDG_RUNTIME_DIR is unavailable"))
        },
        |runtime| Ok(runtime.to_owned()),
    )?;
    if !runtime.is_absolute() {
        return Err(unavailable("XDG_RUNTIME_DIR is not an absolute path"));
    }
    Ok(runtime.join(RUNTIME_NAMESPACE).join(DESCRIPTOR_NAME))
}

fn read_descriptor(runtime_dir: Option<&Path>) -> Result<Descriptor> {
    let path = descriptor_path(runtime_dir)?;
    let parent = path
        .parent()
        .ok_or_else(|| unavailable("browser player descriptor is unavailable"))?;
    let parent_metadata = symlink_metadata(parent)
        .map_err(|_| unavailable("browser player helper is not running"))?;
    validate_directory(&parent_metadata)?;

    let metadata =
        symlink_metadata(&path).map_err(|_| unavailable("browser player helper is not running"))?;
    validate_file(&metadata)?;
    if metadata.len() > DESCRIPTOR_LIMIT as u64 {
        return Err(PulseError::PayloadTooLarge {
            size: usize::try_from(metadata.len()).unwrap_or(usize::MAX),
            limit: DESCRIPTOR_LIMIT,
        });
    }

    // The metadata check above rejects the ordinary symlink case and the bounded read rejects a
    // descriptor that grows after validation. The helper writes atomically, so no extra state is
    // retained between requests.
    let file =
        File::open(&path).map_err(|_| unavailable("browser player descriptor cannot be opened"))?;
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(DESCRIPTOR_LIMIT));
    file.take((DESCRIPTOR_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable("browser player descriptor cannot be read"))?;
    if bytes.len() > DESCRIPTOR_LIMIT {
        return Err(PulseError::PayloadTooLarge {
            size: bytes.len(),
            limit: DESCRIPTOR_LIMIT,
        });
    }
    let descriptor: RawDescriptor = serde_json::from_slice(&bytes)?;
    if descriptor.port == 0 {
        return Err(PulseError::InvalidInput(
            "browser player descriptor has an invalid port".into(),
        ));
    }
    if descriptor.secret.len() != 64
        || !descriptor
            .secret
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(PulseError::InvalidInput(
            "browser player descriptor has an invalid capability".into(),
        ));
    }
    Ok(Descriptor {
        port: descriptor.port,
        secret: descriptor.secret,
    })
}

#[derive(Debug, Deserialize)]
struct RawDescriptor {
    port: u16,
    secret: String,
}

fn validate_directory(metadata: &Metadata) -> Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    if !metadata.file_type().is_dir() {
        return Err(unavailable(
            "browser player descriptor directory is invalid",
        ));
    }
    if metadata.permissions().mode() & 0o777 != 0o700 {
        return Err(unavailable(
            "browser player descriptor directory permissions are unsafe",
        ));
    }
    if metadata.uid() != current_uid() {
        return Err(unavailable(
            "browser player descriptor directory ownership is unsafe",
        ));
    }
    Ok(())
}

fn validate_file(metadata: &Metadata) -> Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    if !metadata.file_type().is_file() {
        return Err(unavailable(
            "browser player descriptor is not a regular file",
        ));
    }
    if metadata.permissions().mode() & 0o777 != 0o600 {
        return Err(unavailable(
            "browser player descriptor permissions are unsafe",
        ));
    }
    if metadata.uid() != current_uid() {
        return Err(unavailable("browser player descriptor ownership is unsafe"));
    }
    Ok(())
}

fn current_uid() -> u32 {
    use std::os::unix::fs::MetadataExt;

    // Linux does not expose getuid through safe std APIs. /proc/self is owned by the effective
    // user and is available in every supported desktop environment; using metadata keeps this
    // crate free of an unsafe libc call.
    fs::metadata("/proc/self").map_or(u32::MAX, |metadata| metadata.uid())
}

async fn read_response_bounded(mut response: reqwest::Response) -> Result<Vec<u8>> {
    if let Some(length) = response.content_length()
        && length > RESPONSE_LIMIT as u64
    {
        return Err(PulseError::PayloadTooLarge {
            size: usize::try_from(length).unwrap_or(usize::MAX),
            limit: RESPONSE_LIMIT,
        });
    }
    let mut body = Vec::with_capacity(
        response
            .content_length()
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or(0)
            .min(RESPONSE_LIMIT),
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| PulseError::NotFound("browser player helper response failed".into()))?
    {
        if body.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
            return Err(PulseError::PayloadTooLarge {
                size: body.len().saturating_add(chunk.len()),
                limit: RESPONSE_LIMIT,
            });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn http_status_error(status: StatusCode) -> PulseError {
    PulseError::NotFound(format!(
        "browser player helper returned HTTP {}",
        status.as_u16()
    ))
}

fn is_supported_spotify_uri(uri: &str) -> bool {
    let Some((kind, id)) = uri
        .strip_prefix("spotify:")
        .and_then(|value| value.split_once(':'))
    else {
        return false;
    };
    matches!(kind, "track" | "album" | "artist" | "playlist")
        && id.len() == 22
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn is_helper_unavailable(error: &PulseError) -> bool {
    matches!(error, PulseError::NotFound(_))
}

fn unavailable(message: &str) -> PulseError {
    PulseError::NotFound(message.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{BrowserPlayer, read_descriptor};

    #[test]
    fn descriptor_path_is_not_exposed_in_errors() {
        let error = read_descriptor(None).unwrap_err();
        assert!(!error.to_string().contains("bridge.json"));
        assert!(!error.to_string().contains("XDG_RUNTIME_DIR="));
    }

    #[test]
    fn browser_player_debug_does_not_include_capabilities() {
        let player = BrowserPlayer::new().unwrap();
        let debug = format!("{player:?}");
        assert!(!debug.contains("secret"));
        assert!(!debug.contains("Bearer"));
    }
}
