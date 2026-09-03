//! Versioned session-bus API consumed by the GNOME Shell extension.

use std::sync::{Arc, RwLock};
use std::time::Duration;

use tokio::sync::Mutex;
use zbus::object_server::SignalEmitter;

use crate::cache::{CacheRepository, unix_now};
use crate::error::{PulseError, Result};
use crate::model::{HealthSnapshot, HealthStatus, PlaybackSnapshot};
use crate::mpris::MprisClient;
use crate::spotify::{PkceLogin, RefreshTokenStore, SpotifyClient};

pub const BUS_NAME: &str = "io.kanterlabs.Pulse";
pub const OBJECT_PATH: &str = "/io/kanterlabs/Pulse";
pub const INTERFACE: &str = "io.kanterlabs.Pulse1";

#[derive(Clone)]
pub struct DaemonState {
    snapshot: Arc<RwLock<PlaybackSnapshot>>,
    health: Arc<RwLock<HealthSnapshot>>,
    active_view: Arc<RwLock<String>>,
    mpris: Option<MprisClient>,
    spotify: Option<SpotifyClient>,
    cache: Option<Arc<CacheRepository>>,
    refresh_store: Option<Arc<dyn RefreshTokenStore>>,
    login: Arc<Mutex<Option<PkceLogin>>>,
    snapshot_ttl_seconds: u64,
}

impl std::fmt::Debug for DaemonState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DaemonState")
            .field("snapshot", &self.snapshot())
            .field("health", &self.health())
            .field("active_view", &self.active_view())
            .field("has_mpris", &self.mpris.is_some())
            .field("has_spotify", &self.spotify.is_some())
            .field("has_cache", &self.cache.is_some())
            .finish_non_exhaustive()
    }
}

impl DaemonState {
    #[must_use]
    pub fn new(
        mpris: Option<MprisClient>,
        spotify: Option<SpotifyClient>,
        cache: Option<Arc<CacheRepository>>,
    ) -> Self {
        let mut cached_snapshot = cache
            .as_ref()
            .and_then(|cache| cache.load_snapshot().ok().flatten())
            .map(|cached| cached.snapshot)
            .unwrap_or_default();
        let has_mpris = mpris.is_some();
        if !has_mpris {
            cached_snapshot.offline = true;
        }
        let has_spotify = spotify
            .as_ref()
            .is_some_and(SpotifyClient::is_authenticated);
        let health = HealthSnapshot {
            status: if has_mpris {
                HealthStatus::Degraded
            } else {
                HealthStatus::Disconnected
            },
            mpris_available: has_mpris,
            spotify_authenticated: has_spotify,
            offline: !has_mpris,
            last_refresh: None,
            error: None,
        };
        Self {
            snapshot: Arc::new(RwLock::new(cached_snapshot)),
            health: Arc::new(RwLock::new(health)),
            active_view: Arc::new(RwLock::new("home".into())),
            mpris,
            spotify,
            cache,
            refresh_store: None,
            login: Arc::new(Mutex::new(None)),
            snapshot_ttl_seconds: 30,
        }
    }

    #[must_use]
    pub fn with_refresh_store(mut self, store: Arc<dyn RefreshTokenStore>) -> Self {
        self.refresh_store = Some(store);
        self
    }

    #[must_use]
    pub fn with_snapshot_ttl_seconds(mut self, ttl_seconds: u64) -> Self {
        self.snapshot_ttl_seconds = ttl_seconds.max(1);
        self
    }

    #[must_use]
    pub fn snapshot(&self) -> PlaybackSnapshot {
        self.snapshot
            .read()
            .map(|snapshot| snapshot.clone())
            .unwrap_or_default()
    }

    #[must_use]
    pub fn health(&self) -> HealthSnapshot {
        self.health
            .read()
            .map(|health| health.clone())
            .unwrap_or_default()
    }

    #[must_use]
    pub fn active_view(&self) -> String {
        self.active_view
            .read()
            .map_or_else(|_| "home".into(), |view| view.clone())
    }

    pub fn set_active_view(&self, view: &str) -> Result<()> {
        if view.trim().is_empty() || view.len() > 64 {
            return Err(PulseError::InvalidInput(
                "active view is empty or too long".into(),
            ));
        }
        self.active_view
            .write()
            .map(|mut current| view.clone_into(&mut current))
            .map_err(|_| PulseError::CacheUnavailable("active view lock poisoned".into()))
    }

    pub async fn refresh(&self) -> Result<PlaybackSnapshot> {
        let snapshot = match &self.mpris {
            Some(mpris) => mpris.snapshot().await?,
            None => PlaybackSnapshot::default(),
        };
        let now = unix_now();
        if let Some(cache) = &self.cache {
            let ttl_seconds = i64::try_from(self.snapshot_ttl_seconds).unwrap_or(i64::MAX);
            cache.save_snapshot(&snapshot, now, now.saturating_add(ttl_seconds))?;
        }
        self.set_snapshot(snapshot.clone())?;
        self.set_health_from_snapshot(&snapshot, Some(now))?;
        Ok(snapshot)
    }

    pub async fn play_pause(&self) -> Result<PlaybackSnapshot> {
        let mpris = self
            .mpris
            .as_ref()
            .ok_or_else(|| PulseError::NotFound("Spotify MPRIS player is not configured".into()))?;
        mpris.play_pause().await?;
        self.refresh().await
    }

    pub async fn next(&self) -> Result<PlaybackSnapshot> {
        let mpris = self
            .mpris
            .as_ref()
            .ok_or_else(|| PulseError::NotFound("Spotify MPRIS player is not configured".into()))?;
        mpris.next().await?;
        self.refresh().await
    }

    pub async fn previous(&self) -> Result<PlaybackSnapshot> {
        let mpris = self
            .mpris
            .as_ref()
            .ok_or_else(|| PulseError::NotFound("Spotify MPRIS player is not configured".into()))?;
        mpris.previous().await?;
        self.refresh().await
    }

    pub async fn seek(&self, position_us: i64) -> Result<PlaybackSnapshot> {
        let mpris = self
            .mpris
            .as_ref()
            .ok_or_else(|| PulseError::NotFound("Spotify MPRIS player is not configured".into()))?;
        mpris.seek(position_us).await?;
        self.refresh().await
    }

    pub async fn open_uri(&self, uri: &str) -> Result<()> {
        if let Some(mpris) = &self.mpris {
            match mpris.open_uri(uri).await {
                Ok(()) => return Ok(()),
                Err(PulseError::NotFound(_)) => {}
                Err(error) => return Err(error),
            }
        }
        self.open_uri_external(uri).await
    }

    async fn open_uri_external(&self, uri: &str) -> Result<()> {
        // Opening a Spotify URI is useful when the application is not yet running. xdg-open
        // delegates to the user's configured Spotify handler without shell interpolation.
        let parsed = url::Url::parse(uri)
            .map_err(|error| PulseError::InvalidInput(format!("invalid URI: {error}")))?;
        if !matches!(parsed.scheme(), "spotify" | "http" | "https") {
            return Err(PulseError::InvalidInput(
                "only spotify, http, and https URIs are supported".into(),
            ));
        }
        let status = tokio::process::Command::new("xdg-open")
            .arg(uri)
            .status()
            .await?;
        if status.success() {
            Ok(())
        } else {
            Err(PulseError::NotFound(
                "no application handles the URI".into(),
            ))
        }
    }

    pub async fn search(&self, query: &str) -> Result<String> {
        let spotify = self
            .spotify
            .as_ref()
            .ok_or(PulseError::AuthenticationRequired)?;
        let response = spotify
            .search(query, "track,album,artist,playlist", 20)
            .await?;
        Ok(response.to_string())
    }

    pub async fn begin_login(self: &Arc<Self>) -> Result<String> {
        let spotify = self
            .spotify
            .as_ref()
            .ok_or_else(|| PulseError::InvalidInput("Spotify client ID is not configured".into()))?
            .clone();
        let login = spotify.begin_login().await?;
        let authorization_url = login.authorization_url.to_string();
        let state = Arc::clone(self);
        {
            let mut current = self.login.lock().await;
            *current = Some(login);
        }
        // Keep the callback listener alive in the daemon and complete the token exchange in the
        // background. The browser-facing D-Bus method returns immediately.
        tokio::spawn(async move {
            let login = {
                let mut current = state.login.lock().await;
                current.take()
            };
            let Some(mut login) = login else {
                return;
            };
            let result = async {
                let code = login.wait_for_callback(Duration::from_secs(300)).await?;
                let token = spotify.exchange_code(&login, &code).await?;
                if let Some(store) = &state.refresh_store
                    && let Some(refresh_token) = token.refresh_token.as_deref()
                {
                    store.save(refresh_token)?;
                }
                Ok::<(), PulseError>(())
            }
            .await;
            if let Err(error) = result {
                if let Ok(mut health) = state.health.write() {
                    health.error = Some(error.to_string());
                    health.status = HealthStatus::Degraded;
                }
            } else if let Ok(mut health) = state.health.write() {
                health.spotify_authenticated = true;
                health.error = None;
            }
        });
        Ok(authorization_url)
    }

    pub fn logout(&self) -> Result<()> {
        if let Some(spotify) = &self.spotify {
            spotify.clear_token()?;
        }
        if let Some(store) = &self.refresh_store {
            store.clear()?;
        }
        if let Some(cache) = &self.cache {
            cache.clear_spotify_cache()?;
        }
        if let Ok(mut health) = self.health.write() {
            health.spotify_authenticated = false;
        }
        Ok(())
    }

    fn set_snapshot(&self, snapshot: PlaybackSnapshot) -> Result<()> {
        self.snapshot
            .write()
            .map(|mut current| *current = snapshot)
            .map_err(|_| PulseError::CacheUnavailable("snapshot lock poisoned".into()))
    }

    fn set_health_from_snapshot(
        &self,
        snapshot: &PlaybackSnapshot,
        now: Option<i64>,
    ) -> Result<()> {
        let mut health = self
            .health
            .write()
            .map_err(|_| PulseError::CacheUnavailable("health lock poisoned".into()))?;
        health.mpris_available =
            !matches!(snapshot.status, crate::model::PlaybackStatus::Disconnected);
        health.offline = snapshot.offline;
        health.last_refresh = now;
        health.status = if snapshot.offline {
            HealthStatus::Disconnected
        } else if snapshot.error.is_some() {
            HealthStatus::Degraded
        } else {
            HealthStatus::Ready
        };
        health.error.clone_from(&snapshot.error);
        Ok(())
    }
}

pub struct PulseDbus {
    state: Arc<DaemonState>,
}

impl std::fmt::Debug for PulseDbus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PulseDbus")
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

impl PulseDbus {
    #[must_use]
    pub fn new(state: Arc<DaemonState>) -> Self {
        Self { state }
    }

    #[must_use]
    pub fn state(&self) -> &Arc<DaemonState> {
        &self.state
    }
}

#[zbus::interface(name = "io.kanterlabs.Pulse1")]
impl PulseDbus {
    #[zbus(property)]
    fn status(&self) -> String {
        serde_json::to_string(&self.state.snapshot().status)
            .unwrap_or_else(|_| "\"unknown\"".into())
            .trim_matches('\"')
            .to_owned()
    }

    #[zbus(property)]
    fn playback(&self) -> String {
        self.state.snapshot().to_json()
    }

    #[zbus(property)]
    fn active_view(&self) -> String {
        self.state.active_view()
    }

    #[zbus(property)]
    fn offline(&self) -> bool {
        self.state.snapshot().offline
    }

    #[zbus(property)]
    fn last_refresh(&self) -> i64 {
        self.state.health().last_refresh.unwrap_or(0)
    }

    fn health(&self) -> zbus::fdo::Result<String> {
        serde_json::to_string(&self.state.health())
            .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))
    }

    fn get_snapshot(&self) -> String {
        self.state.snapshot().to_json()
    }

    async fn refresh(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let snapshot = self.state.refresh().await.map_err(to_dbus_error)?;
        Self::snapshot_changed(&emitter, snapshot.to_json())
            .await
            .map_err(to_dbus_zbus_error)
    }

    async fn search(&self, query: String) -> zbus::fdo::Result<String> {
        self.state.search(&query).await.map_err(to_dbus_error)
    }

    async fn open_uri(&self, uri: String) -> zbus::fdo::Result<()> {
        self.state.open_uri(&uri).await.map_err(to_dbus_error)
    }

    async fn play_pause(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let snapshot = self.state.play_pause().await.map_err(to_dbus_error)?;
        Self::snapshot_changed(&emitter, snapshot.to_json())
            .await
            .map_err(to_dbus_zbus_error)
    }

    async fn next(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let snapshot = self.state.next().await.map_err(to_dbus_error)?;
        Self::snapshot_changed(&emitter, snapshot.to_json())
            .await
            .map_err(to_dbus_zbus_error)
    }

    async fn previous(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let snapshot = self.state.previous().await.map_err(to_dbus_error)?;
        Self::snapshot_changed(&emitter, snapshot.to_json())
            .await
            .map_err(to_dbus_zbus_error)
    }

    async fn seek(
        &self,
        position_us: i64,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let snapshot = self.state.seek(position_us).await.map_err(to_dbus_error)?;
        Self::snapshot_changed(&emitter, snapshot.to_json())
            .await
            .map_err(to_dbus_zbus_error)
    }

    async fn begin_login(&self) -> zbus::fdo::Result<String> {
        self.state
            .clone()
            .begin_login()
            .await
            .map_err(to_dbus_error)
    }

    fn logout(&self) -> zbus::fdo::Result<()> {
        self.state.logout().map_err(to_dbus_error)
    }

    #[zbus(signal)]
    async fn snapshot_changed(emitter: &SignalEmitter<'_>, snapshot: String) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn login_state_changed(
        emitter: &SignalEmitter<'_>,
        authenticated: bool,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn error_changed(
        emitter: &SignalEmitter<'_>,
        code: String,
        message: String,
    ) -> zbus::Result<()>;
}

pub async fn serve(state: Arc<DaemonState>) -> Result<zbus::Connection> {
    let connection = zbus::Connection::session().await?;
    connection.request_name(BUS_NAME).await?;
    connection
        .object_server()
        .at(OBJECT_PATH, PulseDbus::new(state))
        .await?;
    Ok(connection)
}

#[allow(clippy::needless_pass_by_value)]
fn to_dbus_error(error: PulseError) -> zbus::fdo::Error {
    zbus::fdo::Error::Failed(format!("{}: {}", error.code(), error))
}

fn to_dbus_zbus_error(error: zbus::Error) -> zbus::fdo::Error {
    zbus::fdo::Error::ZBus(error)
}

#[cfg(test)]
mod tests {
    use super::{DaemonState, INTERFACE, OBJECT_PATH, PulseDbus};
    use crate::model::PlaybackStatus;
    use std::sync::Arc;

    #[test]
    fn service_constants_are_versioned_and_stable() {
        assert_eq!(INTERFACE, "io.kanterlabs.Pulse1");
        assert_eq!(OBJECT_PATH, "/io/kanterlabs/Pulse");
    }

    #[test]
    fn disconnected_state_is_safe_for_extension_startup() {
        let state = Arc::new(DaemonState::new(None, None, None));
        let dbus = PulseDbus::new(state);
        assert_eq!(dbus.status(), "disconnected");
        assert_eq!(dbus.state().snapshot().status, PlaybackStatus::Disconnected);
        assert!(dbus.state().snapshot().offline);
    }
}
