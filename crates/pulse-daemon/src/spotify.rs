//! Spotify Web API access and Authorization Code with PKCE.
//!
//! The client intentionally does not accept or persist a client secret. A public client ID and
//! PKCE are sufficient for a desktop application and avoid putting a credential in the user's
//! config file. Refresh-token persistence is abstracted behind RefreshTokenStore so the
//! daemon can use GNOME Keyring/Secret Service without making tests depend on a desktop session.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::random;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::time::timeout;
use url::Url;
use uuid::Uuid;

use crate::error::{PulseError, Result};

const MAX_ATTEMPTS: u32 = 5;
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const CALLBACK_READ_LIMIT: usize = 16 * 1024;
const API_RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
const TOKEN_RESPONSE_LIMIT: usize = 1024 * 1024;
const ERROR_BODY_LIMIT: usize = 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
}

impl RetryPolicy {
    /// Construct a bounded retry policy. Values above the daemon's hard limits are clamped.
    #[must_use]
    pub fn new(max_attempts: u32, base_delay: Duration, max_delay: Duration) -> Self {
        let max_delay = max_delay.min(MAX_BACKOFF);
        Self {
            max_attempts: max_attempts.clamp(1, MAX_ATTEMPTS),
            base_delay: base_delay.min(max_delay),
            max_delay,
        }
    }

    #[must_use]
    fn delay_for(self, retry_number: u32) -> Duration {
        let multiplier = 2_u32.saturating_pow(retry_number.saturating_sub(1));
        self.base_delay
            .checked_mul(multiplier)
            .unwrap_or(self.max_delay)
            .min(self.max_delay)
    }
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self::new(3, Duration::from_millis(200), Duration::from_secs(5))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum RateLimitState {
    #[default]
    Clear,
    RateLimited {
        retry_after: Duration,
    },
    QuotaExceeded,
}

#[derive(Clone)]
pub struct TokenSet {
    pub access_token: String,
    pub token_type: String,
    pub refresh_token: Option<String>,
    pub expires_at: SystemTime,
}

impl std::fmt::Debug for TokenSet {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TokenSet")
            .field("access_token", &"<redacted>")
            .field("token_type", &self.token_type)
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl TokenSet {
    #[must_use]
    pub fn new(
        access_token: impl Into<String>,
        token_type: impl Into<String>,
        refresh_token: Option<String>,
        expires_in: u64,
    ) -> Self {
        // Refresh a little before Spotify's exact expiry to avoid racing an API request.
        let safe_lifetime = expires_in.saturating_sub(30);
        Self {
            access_token: access_token.into(),
            token_type: token_type.into(),
            refresh_token,
            expires_at: SystemTime::now() + Duration::from_secs(safe_lifetime),
        }
    }

    #[must_use]
    pub fn is_expired(&self) -> bool {
        SystemTime::now() >= self.expires_at
    }
}

/// Minimal persistence seam for refresh tokens. Implementations should use Secret Service rather
/// than a plain file or SQLite. The in-memory implementation is useful for tests and development.
pub trait RefreshTokenStore: Send + Sync {
    fn load(&self) -> Result<Option<String>>;
    fn save(&self, token: &str) -> Result<()>;
    fn clear(&self) -> Result<()>;
}

#[derive(Debug, Default)]
pub struct MemoryRefreshTokenStore {
    token: RwLock<Option<String>>,
}

/// Secret Service-backed refresh-token storage.
///
/// Fedora's `secret-tool` is a small command-line client for the desktop Secret Service API. It
/// keeps the Secret Service protocol (and its session/collection handling) out of the daemon while
/// ensuring tokens are sent on stdin, never in command-line arguments, logs, or SQLite.
#[derive(Debug, Clone)]
pub struct SecretServiceStore {
    client_id: String,
}

impl SecretServiceStore {
    #[must_use]
    pub fn new(client_id: impl Into<String>) -> Self {
        Self {
            client_id: client_id.into(),
        }
    }

    fn command(&self, operation: &str) -> Command {
        let mut command = Command::new("secret-tool");
        command
            .arg(operation)
            .arg("application")
            .arg("pulse")
            .arg("client-id")
            .arg(&self.client_id)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        command
    }
}

impl RefreshTokenStore for SecretServiceStore {
    fn load(&self) -> Result<Option<String>> {
        let output = self.command("lookup").output()?;
        if !output.status.success() {
            return Ok(None);
        }
        let token = String::from_utf8(output.stdout)
            .map_err(|error| {
                PulseError::CacheUnavailable(format!(
                    "Secret Service returned invalid UTF-8: {error}"
                ))
            })?
            .trim()
            .to_owned();
        Ok((!token.is_empty()).then_some(token))
    }

    fn save(&self, token: &str) -> Result<()> {
        if token.is_empty() {
            return Err(PulseError::InvalidInput("refresh token is empty".into()));
        }
        let mut child = self
            .command("store")
            .arg("--label=Pulse Spotify refresh token")
            .spawn()?;
        let stdin = child.stdin.as_mut().ok_or_else(|| {
            PulseError::CacheUnavailable("Secret Service stdin unavailable".into())
        })?;
        stdin.write_all(token.as_bytes())?;
        stdin.write_all(b"\n")?;
        let status = child.wait()?;
        if status.success() {
            Ok(())
        } else {
            Err(PulseError::CacheUnavailable(
                "Secret Service rejected token".into(),
            ))
        }
    }

    fn clear(&self) -> Result<()> {
        let status = self.command("clear").status()?;
        if status.success() {
            Ok(())
        } else {
            Err(PulseError::CacheUnavailable(
                "Secret Service could not clear token".into(),
            ))
        }
    }
}

impl RefreshTokenStore for MemoryRefreshTokenStore {
    fn load(&self) -> Result<Option<String>> {
        self.token
            .read()
            .map(|token| token.clone())
            .map_err(|_| PulseError::CacheUnavailable("refresh token lock poisoned".into()))
    }

    fn save(&self, token: &str) -> Result<()> {
        self.token
            .write()
            .map(|mut current| *current = Some(token.to_owned()))
            .map_err(|_| PulseError::CacheUnavailable("refresh token lock poisoned".into()))
    }

    fn clear(&self) -> Result<()> {
        self.token
            .write()
            .map(|mut current| *current = None)
            .map_err(|_| PulseError::CacheUnavailable("refresh token lock poisoned".into()))
    }
}

#[derive(Clone)]
pub struct SpotifyClient {
    http: Client,
    client_id: String,
    api_base_url: Url,
    accounts_base_url: Url,
    scopes: Vec<String>,
    redirect_port: u16,
    token: Arc<RwLock<Option<TokenSet>>>,
    retry_policy: RetryPolicy,
    rate_limit_state: Arc<RwLock<RateLimitState>>,
}

impl std::fmt::Debug for SpotifyClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SpotifyClient")
            .field("client_id", &"<redacted>")
            .field("api_base_url", &self.api_base_url)
            .field("accounts_base_url", &self.accounts_base_url)
            .field("scopes", &self.scopes)
            .field("retry_policy", &self.retry_policy)
            .finish_non_exhaustive()
    }
}

impl SpotifyClient {
    pub fn new(client_id: impl Into<String>) -> Result<Self> {
        Self::with_urls(
            client_id,
            "https://api.spotify.com/v1",
            "https://accounts.spotify.com",
            Vec::new(),
        )
    }

    pub fn with_urls(
        client_id: impl Into<String>,
        api_base_url: &str,
        accounts_base_url: &str,
        scopes: Vec<String>,
    ) -> Result<Self> {
        let client_id = client_id.into();
        if client_id.trim().is_empty() {
            return Err(PulseError::InvalidInput(
                "Spotify client ID is empty".into(),
            ));
        }
        let api_base_url = parse_base_url(api_base_url, "Spotify API URL")?;
        let accounts_base_url = parse_base_url(accounts_base_url, "Spotify accounts URL")?;
        Ok(Self {
            http: Client::builder()
                .user_agent(concat!("pulse-daemon/", env!("CARGO_PKG_VERSION")))
                .build()?,
            client_id,
            api_base_url,
            accounts_base_url,
            scopes,
            redirect_port: 0,
            token: Arc::new(RwLock::new(None)),
            retry_policy: RetryPolicy::default(),
            rate_limit_state: Arc::new(RwLock::new(RateLimitState::Clear)),
        })
    }

    #[must_use]
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    /// Choose the loopback port registered with Spotify. Zero requests a dynamic port.
    #[must_use]
    pub fn with_redirect_port(mut self, port: u16) -> Self {
        self.redirect_port = port;
        self
    }

    #[must_use]
    pub fn retry_policy(&self) -> RetryPolicy {
        self.retry_policy
    }

    #[must_use]
    pub fn rate_limit_state(&self) -> RateLimitState {
        self.rate_limit_state
            .read()
            .map(|state| state.clone())
            .unwrap_or_default()
    }

    pub fn set_retry_policy(&mut self, retry_policy: RetryPolicy) {
        self.retry_policy = RetryPolicy::new(
            retry_policy.max_attempts,
            retry_policy.base_delay,
            retry_policy.max_delay,
        );
    }

    pub fn set_token(&self, token: TokenSet) -> Result<()> {
        self.token
            .write()
            .map(|mut current| *current = Some(token))
            .map_err(|_| PulseError::CacheUnavailable("Spotify token lock poisoned".into()))
    }

    pub fn clear_token(&self) -> Result<()> {
        self.token
            .write()
            .map(|mut current| *current = None)
            .map_err(|_| PulseError::CacheUnavailable("Spotify token lock poisoned".into()))
    }

    #[must_use]
    pub fn is_authenticated(&self) -> bool {
        self.token
            .read()
            .ok()
            .and_then(|token| token.clone())
            .is_some_and(|token| !token.is_expired())
    }

    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.request_json(reqwest::Method::GET, path, &[]).await
    }

    pub async fn get_json_with_query<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T> {
        self.request_json(reqwest::Method::GET, path, query).await
    }

    pub async fn currently_playing(&self) -> Result<Value> {
        self.get_json("me/player").await
    }

    pub async fn recently_played(&self, limit: u8) -> Result<Value> {
        let limit = limit.clamp(1, 50).to_string();
        self.get_json_with_query("me/player/recently-played", &[("limit", &limit)])
            .await
    }

    /// Return the user's saved tracks for one bounded page.
    pub async fn saved_tracks(&self, limit: u8, offset: u32) -> Result<Value> {
        let limit = limit.clamp(1, 50).to_string();
        let offset = offset.to_string();
        self.get_json_with_query("me/tracks", &[("limit", &limit), ("offset", &offset)])
            .await
    }

    pub async fn user_playlists(&self, limit: u8, offset: u32) -> Result<Value> {
        let limit = limit.clamp(1, 50).to_string();
        let offset = offset.to_string();
        self.get_json_with_query("me/playlists", &[("limit", &limit), ("offset", &offset)])
            .await
    }

    /// Return the current read-only queue. Spotify may reject this endpoint for an account or
    /// development application; callers should expose that as a capability state rather than
    /// treating it as a daemon failure.
    pub async fn queue(&self) -> Result<Value> {
        self.get_json("me/player/queue").await
    }

    pub async fn search(&self, query: &str, types: &str, limit: u8) -> Result<Value> {
        if query.trim().is_empty() {
            return Err(PulseError::InvalidInput("search query is empty".into()));
        }
        let limit = limit.clamp(1, 50).to_string();
        self.get_json_with_query(
            "search",
            &[("q", query), ("type", types), ("limit", &limit)],
        )
        .await
    }

    pub fn begin_login(&self) -> impl std::future::Future<Output = Result<PkceLogin>> + '_ {
        let client_id = self.client_id.clone();
        let accounts_base_url = self.accounts_base_url.clone();
        let scopes = self.scopes.clone();
        let redirect_port = self.redirect_port;
        async move {
            PkceLogin::begin_on_port(&client_id, &accounts_base_url, &scopes, redirect_port).await
        }
    }

    pub async fn exchange_code(&self, login: &PkceLogin, code: &str) -> Result<TokenSet> {
        if code.trim().is_empty() {
            return Err(PulseError::InvalidInput(
                "authorization code is empty".into(),
            ));
        }
        let endpoint = login
            .accounts_base_url
            .join("/api/token")
            .map_err(|error| {
                PulseError::InvalidInput(format!("invalid token endpoint: {error}"))
            })?;
        let response = self
            .http
            .post(endpoint)
            .timeout(REQUEST_TIMEOUT)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", login.redirect_uri.as_str()),
                ("client_id", self.client_id.as_str()),
                ("code_verifier", login.verifier.as_str()),
            ])
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status();
            let body = read_text_prefix(response, ERROR_BODY_LIMIT)
                .await
                .unwrap_or_default();
            return Err(PulseError::AuthenticationFailed(format!(
                "token exchange returned {status}: {}",
                sanitize_error_body(&body)
            )));
        }
        let token: TokenResponse = decode_json_bounded(response, TOKEN_RESPONSE_LIMIT).await?;
        let token = token.into_token_set();
        self.set_token(token.clone())?;
        Ok(token)
    }

    pub async fn refresh_with_store<S: RefreshTokenStore + ?Sized>(
        &self,
        store: &S,
    ) -> Result<TokenSet> {
        let refresh_token = store.load()?.ok_or(PulseError::AuthenticationRequired)?;
        let endpoint = self.accounts_base_url.join("/api/token").map_err(|error| {
            PulseError::InvalidInput(format!("invalid token endpoint: {error}"))
        })?;
        let response = self
            .http
            .post(endpoint)
            .timeout(REQUEST_TIMEOUT)
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token.as_str()),
                ("client_id", self.client_id.as_str()),
            ])
            .send()
            .await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.clear_token()?;
            store.clear()?;
            return Err(PulseError::AuthenticationRequired);
        }
        if !response.status().is_success() {
            return Err(PulseError::AuthenticationFailed(format!(
                "refresh returned {}",
                response.status()
            )));
        }
        let token: TokenResponse = decode_json_bounded(response, TOKEN_RESPONSE_LIMIT).await?;
        let mut token = token.into_token_set();
        if token.refresh_token.is_none() {
            token.refresh_token = Some(refresh_token);
        }
        if let Some(new_refresh_token) = token.refresh_token.as_deref() {
            store.save(new_refresh_token)?;
        }
        self.set_token(token.clone())?;
        Ok(token)
    }

    async fn request_json<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T> {
        let url = self.api_url(path, query)?;
        let token = self
            .token
            .read()
            .map_err(|_| PulseError::CacheUnavailable("Spotify token lock poisoned".into()))?
            .clone()
            .filter(|token| !token.is_expired())
            .ok_or(PulseError::AuthenticationRequired)?;
        let mut last_error = None;
        for attempt in 1..=self.retry_policy.max_attempts {
            let response = self
                .http
                .request(method.clone(), url.clone())
                .timeout(REQUEST_TIMEOUT)
                .bearer_auth(&token.access_token)
                .send()
                .await;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    last_error = Some(error.to_string());
                    if attempt == self.retry_policy.max_attempts {
                        break;
                    }
                    self.sleep_before_retry(attempt).await;
                    continue;
                }
            };
            let status = response.status();
            if status.is_success() {
                self.set_rate_limit_state(RateLimitState::Clear);
                return decode_json_bounded(response, API_RESPONSE_LIMIT).await;
            }
            if status == StatusCode::UNAUTHORIZED {
                self.clear_token()?;
                return Err(PulseError::AuthenticationRequired);
            }
            if status == StatusCode::FORBIDDEN {
                return Err(PulseError::PermissionDenied);
            }
            if status == StatusCode::NOT_FOUND {
                return Err(PulseError::NotFound(path.to_owned()));
            }
            let retry_after_header = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .map(|seconds| Duration::from_secs(seconds).min(self.retry_policy.max_delay));
            let body = read_text_prefix(response, ERROR_BODY_LIMIT)
                .await
                .unwrap_or_default();
            if status == StatusCode::TOO_MANY_REQUESTS {
                if body.contains("QUOTA_EXCEEDED") {
                    self.set_rate_limit_state(RateLimitState::QuotaExceeded);
                    return Err(PulseError::QuotaExceeded);
                }
                let retry_after = retry_after_header
                    .unwrap_or_else(|| parse_retry_after(&body, self.retry_policy.max_delay));
                self.set_rate_limit_state(RateLimitState::RateLimited { retry_after });
                return Err(PulseError::RateLimited { retry_after });
            }
            if status.is_server_error() {
                last_error = Some(format!(
                    "Spotify returned {status}: {}",
                    sanitize_error_body(&body)
                ));
                if attempt < self.retry_policy.max_attempts {
                    self.sleep_before_retry(attempt).await;
                }
            } else {
                return Err(PulseError::RetryExhausted {
                    attempts: attempt,
                    message: format!("Spotify returned {status}: {}", sanitize_error_body(&body)),
                });
            }
        }
        Err(PulseError::RetryExhausted {
            attempts: self.retry_policy.max_attempts,
            message: last_error.unwrap_or_else(|| "request failed".into()),
        })
    }

    fn api_url(&self, path: &str, query: &[(&str, &str)]) -> Result<Url> {
        let path = path.trim_start_matches('/');
        let mut url = self
            .api_base_url
            .join(path)
            .map_err(|error| PulseError::InvalidInput(format!("invalid API path: {error}")))?;
        if !query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in query {
                pairs.append_pair(key, value);
            }
        }
        Ok(url)
    }

    async fn sleep_before_retry(&self, attempt: u32) {
        let delay = self.retry_policy.delay_for(attempt);
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
    }

    fn set_rate_limit_state(&self, state: RateLimitState) {
        if let Ok(mut current) = self.rate_limit_state.write() {
            *current = state;
        }
    }
}

fn parse_base_url(value: &str, label: &str) -> Result<Url> {
    let mut url = Url::parse(value)
        .map_err(|error| PulseError::InvalidInput(format!("{label} is invalid: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(PulseError::InvalidInput(format!(
            "{label} must be an http(s) URL"
        )));
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

async fn decode_json_bounded<T: DeserializeOwned>(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<T> {
    if let Some(length) = response.content_length()
        && length > limit as u64
    {
        return Err(PulseError::PayloadTooLarge {
            size: usize::try_from(length).unwrap_or(usize::MAX),
            limit,
        });
    }
    let mut body = Vec::with_capacity(
        response
            .content_length()
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or(0)
            .min(limit),
    );
    while let Some(chunk) = response.chunk().await? {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(PulseError::PayloadTooLarge {
                size: body.len().saturating_add(chunk.len()),
                limit,
            });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&body)?)
}

async fn read_text_prefix(mut response: reqwest::Response, limit: usize) -> Result<String> {
    let mut body = Vec::with_capacity(limit.min(1024));
    while let Some(chunk) = response.chunk().await? {
        let remaining = limit.saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if body.len() == limit {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

fn parse_retry_after(body: &str, cap: Duration) -> Duration {
    // Spotify returns a Retry-After response header. The request layer consumes the body here,
    // so also accept the documented JSON form in test servers and future API responses.
    let seconds = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("retry_after").and_then(Value::as_u64))
        .or_else(|| body.trim().parse::<u64>().ok())
        .unwrap_or(1);
    Duration::from_secs(seconds).min(cap)
}

fn sanitize_error_body(body: &str) -> String {
    let body = body.trim();
    if body.len() > 240 {
        let end = (0..=240)
            .rev()
            .find(|index| body.is_char_boundary(*index))
            .unwrap_or(0);
        body[..end].to_owned()
    } else {
        body.to_owned()
    }
}

#[derive(Debug)]
pub struct PkceLogin {
    pub authorization_url: Url,
    pub redirect_uri: Url,
    pub state: String,
    verifier: String,
    accounts_base_url: Url,
    listener: Option<TcpListener>,
}

impl PkceLogin {
    pub async fn begin(
        client_id: &str,
        accounts_base_url: &Url,
        scopes: &[String],
    ) -> Result<Self> {
        Self::begin_on_port(client_id, accounts_base_url, scopes, 0).await
    }

    async fn begin_on_port(
        client_id: &str,
        accounts_base_url: &Url,
        scopes: &[String],
        redirect_port: u16,
    ) -> Result<Self> {
        if client_id.trim().is_empty() {
            return Err(PulseError::InvalidInput(
                "Spotify client ID is empty".into(),
            ));
        }
        let listener = TcpListener::bind(("127.0.0.1", redirect_port))
            .await
            .map_err(|error| {
                std::io::Error::new(
                    error.kind(),
                    format!(
                        "cannot listen for Spotify login on 127.0.0.1:{redirect_port}: {error}"
                    ),
                )
            })?;
        let port = listener.local_addr()?.port();
        let redirect_uri = Url::parse(&format!("http://127.0.0.1:{port}/callback"))
            .map_err(|error| PulseError::InvalidInput(error.to_string()))?;
        let verifier = URL_SAFE_NO_PAD.encode(random::<[u8; 48]>());
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = Uuid::new_v4().simple().to_string();
        let mut authorization_url = accounts_base_url.join("/authorize").map_err(|error| {
            PulseError::InvalidInput(format!("invalid authorization endpoint: {error}"))
        })?;
        let scope = scopes.join(" ");
        authorization_url.query_pairs_mut().extend_pairs([
            ("response_type", "code"),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_challenge_method", "S256"),
            ("code_challenge", &challenge),
            ("state", &state),
            ("scope", &scope),
        ]);
        Ok(Self {
            authorization_url,
            redirect_uri,
            state,
            verifier,
            accounts_base_url: accounts_base_url.clone(),
            listener: Some(listener),
        })
    }

    /// Wait for one callback and reject mismatched state or non-callback requests.
    pub async fn wait_for_callback(&mut self, wait: Duration) -> Result<String> {
        let listener = self
            .listener
            .take()
            .ok_or_else(|| PulseError::InvalidInput("PKCE callback already consumed".into()))?;
        let accepted = timeout(wait, listener.accept())
            .await
            .map_err(|_| PulseError::AuthenticationFailed("login callback timed out".into()))??;
        let mut stream = accepted.0;
        let mut request = vec![0_u8; CALLBACK_READ_LIMIT];
        let bytes_read = timeout(Duration::from_secs(10), stream.read(&mut request))
            .await
            .map_err(|_| {
                PulseError::AuthenticationFailed("login callback read timed out".into())
            })??;
        let request = String::from_utf8_lossy(&request[..bytes_read]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("GET "))
            .and_then(|line| line.split_whitespace().next())
            .ok_or_else(|| PulseError::AuthenticationFailed("invalid login callback".into()))?;
        let callback = Url::parse(&format!("http://127.0.0.1{target}"))
            .map_err(|error| PulseError::AuthenticationFailed(error.to_string()))?;
        let state = callback
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.into_owned());
        let code = callback
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.into_owned());
        let (status_line, body) = if state.as_deref() == Some(self.state.as_str()) && code.is_some()
        {
            (
                "HTTP/1.1 200 OK",
                "Pulse login complete; you may close this tab.",
            )
        } else {
            ("HTTP/1.1 400 Bad Request", "Pulse login callback rejected.")
        };
        let response = format!(
            "{status_line}\r\nContent-Length: {}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await?;
        stream.shutdown().await?;
        code.filter(|_| state.as_deref() == Some(self.state.as_str()))
            .ok_or_else(|| PulseError::AuthenticationFailed("login state mismatch".into()))
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default = "default_token_type")]
    token_type: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: u64,
}

impl TokenResponse {
    fn into_token_set(self) -> TokenSet {
        TokenSet::new(
            self.access_token,
            self.token_type,
            self.refresh_token,
            self.expires_in,
        )
    }
}

fn default_token_type() -> String {
    "Bearer".into()
}

#[cfg(test)]
mod tests {
    use super::{
        PkceLogin, RateLimitState, RetryPolicy, SpotifyClient, TokenSet, sanitize_error_body,
    };
    use std::time::{Duration, SystemTime};
    use tokio::net::TcpListener;
    use url::Url;

    #[test]
    fn retry_policy_is_hard_bounded() {
        let policy = RetryPolicy::new(100, Duration::from_secs(60), Duration::from_secs(600));
        assert_eq!(policy.max_attempts, 5);
        assert_eq!(policy.max_delay, Duration::from_secs(30));
        assert_eq!(policy.base_delay, Duration::from_secs(30));
    }

    #[test]
    fn client_debug_and_rate_state_do_not_expose_token() {
        let client = SpotifyClient::new("public-client-id").unwrap();
        client
            .set_token(TokenSet {
                access_token: "secret-access-token".into(),
                token_type: "Bearer".into(),
                refresh_token: Some("secret-refresh-token".into()),
                expires_at: SystemTime::now() + Duration::from_secs(60),
            })
            .unwrap();
        assert!(!format!("{client:?}").contains("secret"));
        assert_eq!(client.rate_limit_state(), RateLimitState::Clear);
    }

    #[test]
    fn error_body_truncation_preserves_utf8_boundaries() {
        let input = format!("{}é", "x".repeat(239));
        assert_eq!(sanitize_error_body(&input), "x".repeat(239));
    }

    #[test]
    fn api_paths_are_appended_below_versioned_base_path() {
        let client = SpotifyClient::new("public-client-id").unwrap();
        assert_eq!(
            client.api_url("me/player", &[]).unwrap().as_str(),
            "https://api.spotify.com/v1/me/player"
        );
    }

    #[tokio::test]
    async fn pkce_uses_loopback_literal_and_s256() {
        let accounts = Url::parse("https://accounts.example.test").unwrap();
        let login = PkceLogin::begin("client", &accounts, &["user-read-playback-state".into()])
            .await
            .unwrap();
        assert_eq!(login.redirect_uri.host_str(), Some("127.0.0.1"));
        assert_ne!(login.redirect_uri.host_str(), Some("localhost"));
        assert_eq!(
            login
                .authorization_url
                .query_pairs()
                .find(|(k, _)| k == "code_challenge_method")
                .map(|(_, v)| v),
            Some("S256".into())
        );
        assert!(login.authorization_url.as_str().contains("127.0.0.1"));
    }

    #[tokio::test]
    async fn configured_pkce_port_handles_callbacks_and_rejects_port_conflicts() {
        let reserved = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = reserved.local_addr().unwrap().port();
        let client = SpotifyClient::new("fixture-client")
            .unwrap()
            .with_redirect_port(port);
        let error = client.begin_login().await.unwrap_err();
        assert!(matches!(
            error,
            crate::PulseError::Io(ref error) if error.kind() == std::io::ErrorKind::AddrInUse
        ));
        drop(reserved);

        // Exercise both a valid callback and state rejection through the actual loopback socket.
        for valid_state in [true, false] {
            let mut login = client.begin_login().await.unwrap();
            let expected_redirect = format!("http://127.0.0.1:{port}/callback");
            assert_eq!(login.redirect_uri.as_str(), expected_redirect);
            assert_eq!(
                login
                    .authorization_url
                    .query_pairs()
                    .find(|(key, _)| key == "redirect_uri")
                    .unwrap()
                    .1,
                expected_redirect
            );
            let mut callback = login.redirect_uri.clone();
            callback.query_pairs_mut().extend_pairs([
                (
                    "state",
                    if valid_state {
                        login.state.as_str()
                    } else {
                        "wrong-state"
                    },
                ),
                ("code", "fixture-code"),
            ]);
            let browser = async {
                reqwest::Client::new()
                    .get(callback)
                    .timeout(Duration::from_secs(5))
                    .send()
                    .await
                    .unwrap()
                    .status()
            };
            let (code, status) =
                tokio::join!(login.wait_for_callback(Duration::from_secs(5)), browser,);
            if valid_state {
                assert_eq!(code.unwrap(), "fixture-code");
                assert_eq!(status, reqwest::StatusCode::OK);
            } else {
                assert!(matches!(
                    code,
                    Err(crate::PulseError::AuthenticationFailed(_))
                ));
                assert_eq!(status, reqwest::StatusCode::BAD_REQUEST);
            }
        }
    }
}
