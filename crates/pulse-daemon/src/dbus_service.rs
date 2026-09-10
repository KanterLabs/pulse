//! Versioned session-bus API consumed by the GNOME Shell extension.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, Semaphore};
use zbus::object_server::SignalEmitter;

use crate::browser_player::{BrowserAuthState, BrowserPlayer};
use crate::cache::{ArtworkCache, CacheRepository, CachedResponse, unix_now};
use crate::error::{PulseError, Result};
use crate::model::{HealthSnapshot, HealthStatus, PlaybackSnapshot};
use crate::mpris::MprisClient;
use crate::spotify::{RefreshTokenStore, SpotifyClient, TokenSet};

pub const BUS_NAME: &str = "io.kanterlabs.Pulse";
pub const OBJECT_PATH: &str = "/io/kanterlabs/Pulse";
pub const INTERFACE: &str = "io.kanterlabs.Pulse1";

const PAGE_SIZE: u8 = 20;
const MAX_CURSOR_OFFSET: usize = 10_000;
const MAX_CURSOR_BYTES: usize = 64;
const MAX_QUERY_BYTES: usize = 512;
const MAX_PAGE_ITEMS: usize = 50;
const MAX_TEXT_BYTES: usize = 2_048;
const DEFAULT_API_TTL_SECONDS: u64 = 300;
const DEFAULT_PAYLOAD_LIMIT: usize = 4 * 1024 * 1024;

struct PendingLogin {
    authorization_url: String,
    generation: u64,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
pub struct DaemonState {
    snapshot: Arc<RwLock<PlaybackSnapshot>>,
    health: Arc<RwLock<HealthSnapshot>>,
    active_view: Arc<RwLock<String>>,
    mpris: Option<MprisClient>,
    browser_player: Option<BrowserPlayer>,
    spotify: Option<SpotifyClient>,
    cache: Option<Arc<CacheRepository>>,
    artwork: Option<ArtworkCache>,
    artwork_http: reqwest::Client,
    artwork_limit: Arc<Semaphore>,
    refresh_store: Option<Arc<dyn RefreshTokenStore>>,
    login: Arc<Mutex<Option<PendingLogin>>>,
    login_generation: Arc<AtomicU64>,
    browser_auth: Arc<RwLock<Option<BrowserAuthState>>>,
    browser_session_fingerprint: Arc<RwLock<Option<[u8; 32]>>>,
    browser_session_generation: Arc<AtomicU64>,
    browser_sync: Arc<Mutex<()>>,
    player_setup_url: Arc<RwLock<Option<String>>>,
    snapshot_ttl_seconds: u64,
    api_ttl_seconds: u64,
}

impl std::fmt::Debug for DaemonState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DaemonState")
            .field("snapshot", &self.snapshot())
            .field("health", &self.health())
            .field("active_view", &self.active_view())
            .field("has_mpris", &self.mpris.is_some())
            .field("has_browser_player", &self.browser_player.is_some())
            .field("has_spotify", &self.spotify.is_some())
            .field("has_cache", &self.cache.is_some())
            .field("has_artwork_cache", &self.artwork.is_some())
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
            browser_player: None,
            spotify,
            cache,
            artwork: None,
            artwork_http: reqwest::Client::new(),
            artwork_limit: Arc::new(Semaphore::new(4)),
            refresh_store: None,
            login: Arc::new(Mutex::new(None)),
            login_generation: Arc::new(AtomicU64::new(0)),
            browser_auth: Arc::new(RwLock::new(None)),
            browser_session_fingerprint: Arc::new(RwLock::new(None)),
            browser_session_generation: Arc::new(AtomicU64::new(0)),
            browser_sync: Arc::new(Mutex::new(())),
            player_setup_url: Arc::new(RwLock::new(None)),
            snapshot_ttl_seconds: 30,
            api_ttl_seconds: DEFAULT_API_TTL_SECONDS,
        }
    }

    #[must_use]
    pub fn with_refresh_store(mut self, store: Arc<dyn RefreshTokenStore>) -> Self {
        self.refresh_store = Some(store);
        self
    }

    #[must_use]
    pub fn with_browser_player(mut self, browser_player: BrowserPlayer) -> Self {
        self.browser_player = Some(browser_player);
        self
    }

    #[must_use]
    pub fn with_snapshot_ttl_seconds(mut self, ttl_seconds: u64) -> Self {
        self.snapshot_ttl_seconds = ttl_seconds.max(1);
        self
    }

    #[must_use]
    pub fn with_api_ttl_seconds(mut self, ttl_seconds: u64) -> Self {
        self.api_ttl_seconds = ttl_seconds.max(1);
        self
    }

    #[must_use]
    pub fn with_artwork_cache(mut self, artwork: ArtworkCache) -> Self {
        self.artwork = Some(artwork);
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
        let mut health = self
            .health
            .read()
            .map(|health| health.clone())
            .unwrap_or_default();
        // The token is restored after DaemonState construction during startup, and can also be
        // refreshed lazily before an API request. Derive this field from the client so Health and
        // GetAuthState cannot disagree about the current authentication state.
        health.spotify_authenticated = if self.browser_player.is_some() {
            self.browser_auth
                .read()
                .ok()
                .and_then(|auth| auth.as_ref().copied())
                .is_some_and(|auth| auth.authenticated)
        } else {
            self.spotify
                .as_ref()
                .is_some_and(SpotifyClient::is_authenticated)
        };
        health
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
        let browser_sync_error = if self.browser_player.is_some() {
            self.ensure_browser_session().await.err()
        } else {
            None
        };
        let mut snapshot = if let Some(browser_player) = &self.browser_player {
            match browser_player.snapshot().await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    let mut snapshot = self.snapshot();
                    snapshot.offline = true;
                    snapshot.error = Some(error.to_string());
                    snapshot
                }
            }
        } else if let Some(mpris) = &self.mpris {
            match mpris.snapshot().await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    // A disappearing MPRIS owner should not erase the last useful playback
                    // state. Keep the cached snapshot and mark it offline until the next poll.
                    let mut snapshot = self.snapshot();
                    snapshot.offline = true;
                    snapshot.error = Some(error.to_string());
                    snapshot
                }
            }
        } else {
            let mut snapshot = self.snapshot();
            snapshot.offline = true;
            snapshot
        };
        if let Some(error) = browser_sync_error
            && snapshot.error.is_none()
        {
            snapshot.error = Some(error.to_string());
            snapshot.offline = true;
        }
        if matches!(snapshot.status, crate::model::PlaybackStatus::Disconnected) {
            let mut previous = self.snapshot();
            previous.status = crate::model::PlaybackStatus::Disconnected;
            previous.playing = false;
            previous.can_control = false;
            previous.can_go_next = false;
            previous.can_go_previous = false;
            previous.can_seek = false;
            previous.offline = true;
            previous.error.clone_from(&snapshot.error);
            snapshot = previous;
        }
        snapshot = self.materialize_snapshot_artwork(snapshot).await;
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
        if let Some(browser_player) = &self.browser_player {
            browser_player.play_pause().await?;
            return self.refresh().await;
        }
        let mpris = self
            .mpris
            .as_ref()
            .ok_or_else(|| PulseError::NotFound("Spotify MPRIS player is not configured".into()))?;
        mpris.play_pause().await?;
        self.refresh().await
    }

    pub async fn next(&self) -> Result<PlaybackSnapshot> {
        if let Some(browser_player) = &self.browser_player {
            browser_player.next().await?;
            return self.refresh().await;
        }
        let mpris = self
            .mpris
            .as_ref()
            .ok_or_else(|| PulseError::NotFound("Spotify MPRIS player is not configured".into()))?;
        mpris.next().await?;
        self.refresh().await
    }

    pub async fn previous(&self) -> Result<PlaybackSnapshot> {
        if let Some(browser_player) = &self.browser_player {
            browser_player.previous().await?;
            return self.refresh().await;
        }
        let mpris = self
            .mpris
            .as_ref()
            .ok_or_else(|| PulseError::NotFound("Spotify MPRIS player is not configured".into()))?;
        mpris.previous().await?;
        self.refresh().await
    }

    pub async fn seek(&self, position_us: i64) -> Result<PlaybackSnapshot> {
        if let Some(browser_player) = &self.browser_player {
            browser_player.seek(position_us).await?;
            return self.refresh().await;
        }
        let mpris = self
            .mpris
            .as_ref()
            .ok_or_else(|| PulseError::NotFound("Spotify MPRIS player is not configured".into()))?;
        mpris.seek(position_us).await?;
        self.refresh().await
    }

    pub async fn open_uri(&self, uri: &str) -> Result<()> {
        match route_uri(uri)? {
            UriRoute::Spotify => {
                if let Some(browser_player) = &self.browser_player {
                    return browser_player.open_uri(uri).await;
                }
                if let Some(mpris) = &self.mpris
                    && mpris.open_uri(uri).await.is_ok()
                {
                    return Ok(());
                }
                // Spotify may not be running yet. xdg-open then delegates to the installed
                // Spotify handler, if one exists.
                self.open_uri_external(uri).await
            }
            // HTTP(S), including OAuth authorization URLs, always goes to the system browser.
            // It is never sent to MPRIS.
            UriRoute::ExternalBrowser => self.open_uri_external(uri).await,
        }
    }

    async fn open_uri_external(&self, uri: &str) -> Result<()> {
        // Opening a Spotify URI is useful when the application is not yet running. xdg-open
        // delegates to the user's configured Spotify handler without shell interpolation.
        let _ = route_uri(uri)?;
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
        let query = query.trim();
        if query.is_empty() {
            return Err(PulseError::InvalidInput("search query is empty".into()));
        }
        if query.len() > MAX_QUERY_BYTES {
            return Err(PulseError::InvalidInput(format!(
                "search query exceeds {MAX_QUERY_BYTES} bytes"
            )));
        }

        let key = cache_key("search", &[query]);
        let browser_generation = if self.browser_player.is_some() {
            if let Err(error) = self.ensure_browser_session().await {
                return self.stale_or_error(&key, "search", &error);
            }
            Some(self.browser_session_generation.load(Ordering::SeqCst))
        } else {
            None
        };
        if let Some(payload) = self.fresh_cached_payload(&key) {
            return self.serialize_payload(&payload);
        }

        let Some(spotify) = self.spotify.as_ref() else {
            if let Some(mut payload) = self.stale_cached_payload(&key) {
                payload["stale"] = Value::Bool(true);
                payload["capability"] = Value::String("stale".into());
                payload["state"] = Value::String("stale".into());
                payload["error"] = json!({
                    "code": "NOT_CONFIGURED",
                    "message": "Spotify is not configured",
                });
                return self.serialize_payload(&payload);
            }
            return self.serialize_payload(&unavailable_payload(
                "search",
                "not_configured",
                "Spotify is not configured",
            ));
        };
        if self.browser_player.is_none()
            && let Err(error) = self.ensure_spotify_session(spotify).await
        {
            return self.stale_or_error(&key, "search", &error);
        }
        match spotify
            .search(query, "track,album,artist,playlist", PAGE_SIZE)
            .await
        {
            Ok(response) => {
                if browser_generation.is_some_and(|generation| {
                    generation != self.browser_session_generation.load(Ordering::SeqCst)
                }) {
                    return self.serialize_payload(&error_payload(
                        "search",
                        &PulseError::AuthenticationRequired,
                    ));
                }
                let payload = self.normalize_search(response).await;
                self.cache_and_serialize(&key, "https://api.spotify.com/v1/search", &payload)
            }
            Err(error) => self.stale_or_error(&key, "search", &error),
        }
    }

    /// Fetch one bounded page of a navigable view. Cursors are deliberately opaque to the UI but
    /// currently encode a bounded numeric offset so requests can be retried and cached safely.
    pub async fn get_view(&self, view: &str, cursor: &str) -> Result<String> {
        let view = normalize_view_name(view)?;
        let offset = parse_cursor(cursor)?;
        self.set_active_view(view)?;
        let offset_text = offset.to_string();
        let key = cache_key(&format!("view:{view}"), &[offset_text.as_str()]);
        let browser_generation = if self.browser_player.is_some() {
            if let Err(error) = self.ensure_browser_session().await {
                return self.stale_or_error(&key, view, &error);
            }
            Some(self.browser_session_generation.load(Ordering::SeqCst))
        } else {
            None
        };
        if let Some(payload) = self.fresh_cached_payload(&key) {
            return self.serialize_payload(&payload);
        }

        let Some(spotify) = self.spotify.as_ref() else {
            if let Some(mut payload) = self.stale_cached_payload(&key) {
                payload["stale"] = Value::Bool(true);
                payload["capability"] = Value::String("stale".into());
                payload["state"] = Value::String("stale".into());
                payload["error"] = json!({
                    "code": "NOT_CONFIGURED",
                    "message": "Spotify is not configured",
                });
                return self.serialize_payload(&payload);
            }
            return self.serialize_payload(&unavailable_payload(
                view,
                "not_configured",
                "Spotify is not configured",
            ));
        };
        if self.browser_player.is_none()
            && let Err(error) = self.ensure_spotify_session(spotify).await
        {
            return self.stale_or_error(&key, view, &error);
        }

        let result = match view {
            "home" => self.home_payload(spotify, offset).await,
            "library" => self.library_payload(spotify, offset).await,
            "queue" => self.queue_payload(spotify).await,
            _ => unreachable!("normalize_view_name validates view"),
        };
        match result {
            Ok(payload) => {
                if browser_generation.is_some_and(|generation| {
                    generation != self.browser_session_generation.load(Ordering::SeqCst)
                }) {
                    return self.serialize_payload(&error_payload(
                        view,
                        &PulseError::AuthenticationRequired,
                    ));
                }
                let source_url = format!("https://api.spotify.com/v1/me/{view}");
                self.cache_and_serialize(&key, &source_url, &payload)
            }
            Err(error) => self.stale_or_error(&key, view, &error),
        }
    }

    /// Return authentication state without exposing access or refresh tokens.
    #[must_use]
    pub fn auth_state_json(&self) -> String {
        if self.browser_player.is_some() {
            return self.browser_auth_state_json();
        }
        let configured = self.spotify.is_some();
        let authenticated = self
            .spotify
            .as_ref()
            .is_some_and(SpotifyClient::is_authenticated);
        let state = if !configured {
            "not_configured"
        } else if authenticated {
            "authenticated"
        } else {
            "logged_out"
        };
        let error = self.health().error;
        json!({
            "state": state,
            "configured": configured,
            "authenticated": authenticated,
            "capability": state,
            "error": error,
        })
        .to_string()
    }

    async fn auth_state_json_for_dbus(&self) -> String {
        if self.browser_player.is_some()
            && let Err(error) = self.refresh_browser_auth().await
        {
            self.set_browser_error(&error);
        }
        self.auth_state_json()
    }

    fn browser_auth_state_json(&self) -> String {
        let auth = self.browser_auth.read().ok().and_then(|auth| *auth);
        let authenticated = auth.is_some_and(|auth| auth.authenticated);
        let state = if auth.is_none() {
            "player_unavailable"
        } else if authenticated {
            "authenticated"
        } else {
            "logged_out"
        };
        let error = if auth.is_none() {
            Some("Start the Pulse player helper to connect Spotify.".to_owned())
        } else {
            self.health().error
        };
        let mut payload = json!({
            // Browser setup owns the real Spotify client ID. The extension should still expose
            // its Connect action so the helper setup page can collect it when needed.
            "client_id_configured": true,
            "configured": true,
            "authenticated": authenticated,
            "state": state,
            "capability": state,
            "playback_backend": "browser",
            "actual_configured": auth.map(|value| value.configured),
            "error": error,
        });
        if let Some(url) = self
            .player_setup_url
            .read()
            .ok()
            .and_then(|url| url.clone())
        {
            payload["player_setup_url"] = Value::String(url);
        }
        payload.to_string()
    }

    async fn home_payload(&self, spotify: &SpotifyClient, offset: usize) -> Result<Value> {
        let recent = spotify.recently_played(PAGE_SIZE).await;
        let playlists = spotify
            .user_playlists(PAGE_SIZE, u32::try_from(offset).unwrap_or(u32::MAX))
            .await;
        let playlist_has_more = playlists
            .as_ref()
            .is_ok_and(|value| collection_has_more(value, offset));
        if recent.is_err() && playlists.is_err() {
            return Err(recent
                .err()
                .or_else(|| playlists.err())
                .expect("one error exists"));
        }

        let mut errors = Vec::new();
        let recent_items = match recent {
            Ok(value) => self.normalize_recent(&value).await,
            Err(error) => {
                errors.push(error);
                Vec::new()
            }
        };
        let playlist_items = match playlists {
            Ok(value) => self.normalize_playlists(&value).await,
            Err(error) => {
                errors.push(error);
                Vec::new()
            }
        };
        let mut items = recent_items.clone();
        items.extend(playlist_items.iter().cloned());
        items.truncate(MAX_PAGE_ITEMS);
        let has_more = playlist_has_more || playlist_items.len() >= usize::from(PAGE_SIZE);
        let mut payload = base_payload(
            "home",
            if !errors.is_empty() {
                "degraded"
            } else if items.is_empty() {
                "empty"
            } else {
                "ready"
            },
        );
        payload["items"] = Value::Array(items);
        payload["sections"] = json!({
            "recent": recent_items,
            "playlists": playlist_items,
        });
        payload["next_cursor"] = next_cursor(offset, has_more);
        if !errors.is_empty() {
            payload["error"] = api_error_value(&errors[0]);
        }
        Ok(payload)
    }

    async fn library_payload(&self, spotify: &SpotifyClient, offset: usize) -> Result<Value> {
        let tracks = spotify
            .saved_tracks(PAGE_SIZE, u32::try_from(offset).unwrap_or(u32::MAX))
            .await;
        let playlists = spotify
            .user_playlists(PAGE_SIZE, u32::try_from(offset).unwrap_or(u32::MAX))
            .await;
        let tracks_have_more = tracks
            .as_ref()
            .is_ok_and(|value| collection_has_more(value, offset));
        let playlists_have_more = playlists
            .as_ref()
            .is_ok_and(|value| collection_has_more(value, offset));
        if tracks.is_err() && playlists.is_err() {
            return Err(tracks
                .err()
                .or_else(|| playlists.err())
                .expect("one error exists"));
        }

        let mut errors = Vec::new();
        let liked_items = match tracks {
            Ok(value) => self.normalize_saved_tracks(&value).await,
            Err(error) => {
                errors.push(error);
                Vec::new()
            }
        };
        let playlist_items = match playlists {
            Ok(value) => self.normalize_playlists(&value).await,
            Err(error) => {
                errors.push(error);
                Vec::new()
            }
        };
        let mut items = liked_items.clone();
        items.extend(playlist_items.iter().cloned());
        items.truncate(MAX_PAGE_ITEMS);
        let has_more = tracks_have_more
            || playlists_have_more
            || liked_items.len() >= usize::from(PAGE_SIZE)
            || playlist_items.len() >= usize::from(PAGE_SIZE);
        let mut payload = base_payload(
            "library",
            if !errors.is_empty() {
                "degraded"
            } else if items.is_empty() {
                "empty"
            } else {
                "ready"
            },
        );
        payload["items"] = Value::Array(items);
        payload["sections"] = json!({
            "liked": liked_items,
            "playlists": playlist_items,
        });
        payload["next_cursor"] = next_cursor(offset, has_more);
        if !errors.is_empty() {
            payload["error"] = api_error_value(&errors[0]);
        }
        Ok(payload)
    }

    async fn queue_payload(&self, spotify: &SpotifyClient) -> Result<Value> {
        let value = spotify.queue().await?;
        let mut items = Vec::new();
        if let Some(queue) = value.get("queue").and_then(Value::as_array) {
            for raw in queue.iter().take(MAX_PAGE_ITEMS) {
                let track = raw.get("track").unwrap_or(raw);
                if let Some(item) = normalize_item(track, "track") {
                    items.push(item);
                }
            }
        }
        let items = self.materialize_items(items).await;
        let currently_playing = value
            .get("currently_playing")
            .filter(|raw| !raw.is_null())
            .and_then(|raw| normalize_item(raw, "track"));
        let currently_playing = match currently_playing {
            Some(item) => Some(self.materialize_item_artwork(item).await),
            None => None,
        };
        let mut payload = base_payload("queue", if items.is_empty() { "empty" } else { "ready" });
        payload["items"] = Value::Array(items.clone());
        payload["queue"] = Value::Array(items);
        payload["currently_playing"] = currently_playing.map_or(Value::Null, Value::from);
        Ok(payload)
    }

    async fn normalize_search(&self, value: Value) -> Value {
        let mut items = Vec::new();
        for (collection, kind) in [
            ("tracks", "track"),
            ("albums", "album"),
            ("artists", "artist"),
            ("playlists", "playlist"),
        ] {
            if let Some(values) = value
                .get(collection)
                .and_then(|collection| collection.get("items"))
                .and_then(Value::as_array)
            {
                for raw in values {
                    if let Some(item) = normalize_item(raw, kind) {
                        items.push(item);
                        if items.len() >= MAX_PAGE_ITEMS {
                            break;
                        }
                    }
                }
            }
            if items.len() >= MAX_PAGE_ITEMS {
                break;
            }
        }
        // A local test endpoint or a future Spotify response may already return a single items
        // collection. Accept it while retaining the same normalized output contract.
        if items.is_empty()
            && let Some(values) = value.get("items").and_then(Value::as_array)
        {
            for raw in values.iter().take(MAX_PAGE_ITEMS) {
                if let Some(item) = normalize_item(raw, "track") {
                    items.push(item);
                }
            }
        }
        items = self.materialize_items(items).await;
        let mut payload = base_payload("search", if items.is_empty() { "empty" } else { "ready" });
        payload["items"] = Value::Array(items);
        payload
    }

    async fn normalize_recent(&self, value: &Value) -> Vec<Value> {
        let mut items = Vec::new();
        if let Some(values) = value.get("items").and_then(Value::as_array) {
            for raw in values.iter().take(usize::from(PAGE_SIZE)) {
                let track = raw.get("track").unwrap_or(raw);
                if let Some(mut item) = normalize_item(track, "track") {
                    if let Some(played_at) = raw.get("played_at").and_then(Value::as_str) {
                        item["played_at"] = Value::String(truncate_text(played_at));
                    }
                    items.push(item);
                }
            }
        }
        self.materialize_items(items).await
    }

    async fn normalize_saved_tracks(&self, value: &Value) -> Vec<Value> {
        let mut items = Vec::new();
        if let Some(values) = value.get("items").and_then(Value::as_array) {
            for raw in values.iter().take(usize::from(PAGE_SIZE)) {
                let track = raw.get("track").unwrap_or(raw);
                if let Some(item) = normalize_item(track, "track") {
                    items.push(item);
                }
            }
        }
        self.materialize_items(items).await
    }

    async fn normalize_playlists(&self, value: &Value) -> Vec<Value> {
        let mut items = Vec::new();
        if let Some(values) = value.get("items").and_then(Value::as_array) {
            for raw in values.iter().take(usize::from(PAGE_SIZE)) {
                if let Some(item) = normalize_item(raw, "playlist") {
                    items.push(item);
                }
            }
        }
        self.materialize_items(items).await
    }

    /// Materialize artwork with at most four in-flight requests. A view remains bounded even if
    /// every row has a cache miss, while preserving the API order for the extension.
    async fn materialize_items(&self, items: Vec<Value>) -> Vec<Value> {
        let mut tasks = tokio::task::JoinSet::new();
        for (index, item) in items.into_iter().enumerate() {
            let permit = Arc::clone(&self.artwork_limit).acquire_owned().await;
            let Ok(permit) = permit else {
                continue;
            };
            let state = self.clone();
            tasks.spawn(async move {
                let item = state.materialize_item_artwork(item).await;
                drop(permit);
                (index, item)
            });
        }
        let mut ordered = Vec::new();
        while let Some(result) = tasks.join_next().await {
            if let Ok((index, item)) = result {
                ordered.push((index, item));
            }
        }
        ordered.sort_by_key(|(index, _)| *index);
        ordered.into_iter().map(|(_, item)| item).collect()
    }

    async fn materialize_item_artwork(&self, mut item: Value) -> Value {
        let Some(source) = item
            .get("art_url")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return item;
        };
        item["source_art_url"] = Value::String(source.clone());
        item["art_url"] = self
            .materialize_artwork_source(&source)
            .await
            .map_or(Value::Null, Value::String);
        item
    }

    async fn materialize_snapshot_artwork(
        &self,
        mut snapshot: PlaybackSnapshot,
    ) -> PlaybackSnapshot {
        if let Some(source) = snapshot.art_url.clone() {
            snapshot.art_url = self.materialize_artwork_source(&source).await;
        }
        snapshot
    }

    async fn materialize_artwork_source(&self, source: &str) -> Option<String> {
        if source.starts_with('/') {
            return std::path::Path::new(source)
                .is_file()
                .then_some(source.to_owned());
        }
        let parsed = url::Url::parse(source).ok()?;
        if parsed.scheme() == "file" {
            let path = parsed.to_file_path().ok()?;
            return path.is_file().then_some(source.to_owned());
        }
        if parsed.scheme() != "https" {
            return None;
        }
        let artwork = self.artwork.as_ref()?;
        artwork
            .fetch(&self.artwork_http, source)
            .await
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    }

    fn fresh_cached_payload(&self, key: &str) -> Option<Value> {
        let response = self.cache.as_ref()?.get_response(key).ok()??;
        if response.is_stale_at(unix_now()) {
            return None;
        }
        parse_cached_payload(&response)
    }

    fn stale_cached_payload(&self, key: &str) -> Option<Value> {
        self.cache
            .as_ref()
            .and_then(|cache| cache.get_response(key).ok().flatten())
            .and_then(|response| parse_cached_payload(&response))
    }

    fn stale_or_error(&self, key: &str, name: &str, error: &PulseError) -> Result<String> {
        if let Some(mut payload) = self.stale_cached_payload(key) {
            payload["stale"] = Value::Bool(true);
            payload["capability"] = Value::String("stale".into());
            payload["state"] = Value::String("stale".into());
            payload["error"] = api_error_value(error);
            return self.serialize_payload(&payload);
        }
        self.serialize_payload(&error_payload(name, error))
    }

    async fn refresh_browser_auth(&self) -> Result<BrowserAuthState> {
        let _guard = self.browser_sync.lock().await;
        self.refresh_browser_auth_inner().await
    }

    async fn refresh_browser_auth_inner(&self) -> Result<BrowserAuthState> {
        let browser_player = self
            .browser_player
            .as_ref()
            .ok_or_else(|| PulseError::NotFound("browser player is not configured".into()))?;
        match browser_player.auth_state().await {
            Ok(auth) => {
                self.browser_auth
                    .write()
                    .map(|mut current| *current = Some(auth))
                    .map_err(|_| {
                        PulseError::CacheUnavailable("browser auth lock poisoned".into())
                    })?;
                if !auth.authenticated {
                    self.clear_browser_credentials_keep_auth()?;
                    if let Ok(mut health) = self.health.write() {
                        health.error = None;
                    }
                } else if let Ok(mut health) = self.health.write() {
                    health.error = None;
                }
                Ok(auth)
            }
            Err(error) => {
                self.clear_browser_session_cache()?;
                Err(error)
            }
        }
    }

    async fn ensure_browser_session(&self) -> Result<()> {
        let _guard = self.browser_sync.lock().await;
        let login_generation = self.login_generation.load(Ordering::SeqCst);
        let auth = self.refresh_browser_auth_inner().await?;
        if !auth.authenticated {
            return Err(PulseError::AuthenticationRequired);
        }
        let browser_player = self
            .browser_player
            .as_ref()
            .ok_or_else(|| PulseError::NotFound("browser player is not configured".into()))?;
        let token = browser_player.token().await.inspect_err(|_| {
            let _ = self.clear_browser_session_cache();
        })?;
        if self.login_generation.load(Ordering::SeqCst) != login_generation {
            let _ = self.clear_browser_session_cache();
            return Err(PulseError::AuthenticationRequired);
        }
        if token.access_token.trim().is_empty() || token.expires_in == 0 {
            self.clear_browser_session_cache()?;
            return Err(PulseError::AuthenticationFailed(
                "browser player returned an invalid access token".into(),
            ));
        }
        let spotify = self
            .spotify
            .as_ref()
            .ok_or_else(|| PulseError::NotFound("Spotify API client is not configured".into()))?;
        let fingerprint: [u8; 32] = Sha256::digest(token.access_token.as_bytes()).into();
        let changed = self
            .browser_session_fingerprint
            .read()
            .map_or(true, |current| current.as_ref() != Some(&fingerprint));
        if changed {
            if let Some(cache) = &self.cache {
                cache.clear_spotify_cache()?;
            }
            self.browser_session_fingerprint
                .write()
                .map(|mut current| *current = Some(fingerprint))
                .map_err(|_| {
                    PulseError::CacheUnavailable("browser session lock poisoned".into())
                })?;
            self.browser_session_generation
                .fetch_add(1, Ordering::SeqCst);
        }
        // The helper owns refresh persistence. The daemon receives only this short-lived access
        // token and deliberately creates no refresh-token-backed store in browser mode.
        spotify.set_token(TokenSet::new(
            token.access_token,
            "Bearer",
            None,
            token.expires_in,
        ))?;
        if let Ok(mut health) = self.health.write() {
            health.spotify_authenticated = true;
            health.error = None;
        }
        Ok(())
    }

    fn clear_browser_session_cache(&self) -> Result<()> {
        self.clear_browser_api_cache()?;
        if let Ok(mut auth) = self.browser_auth.write() {
            *auth = None;
        }
        if let Ok(mut fingerprint) = self.browser_session_fingerprint.write() {
            *fingerprint = None;
        }
        self.browser_session_generation
            .fetch_add(1, Ordering::SeqCst);
        if let Ok(mut health) = self.health.write() {
            health.spotify_authenticated = false;
        }
        Ok(())
    }

    fn clear_browser_credentials_keep_auth(&self) -> Result<()> {
        self.clear_browser_api_cache()?;
        if let Ok(mut fingerprint) = self.browser_session_fingerprint.write() {
            *fingerprint = None;
        }
        self.browser_session_generation
            .fetch_add(1, Ordering::SeqCst);
        if let Ok(mut health) = self.health.write() {
            health.spotify_authenticated = false;
        }
        Ok(())
    }

    fn clear_browser_api_cache(&self) -> Result<()> {
        if let Some(spotify) = &self.spotify {
            spotify.clear_token()?;
        }
        if let Some(cache) = &self.cache {
            cache.clear_spotify_cache()?;
        }
        Ok(())
    }

    fn set_browser_error(&self, error: &PulseError) {
        if let Ok(mut health) = self.health.write() {
            health.error = Some(error.to_string());
            health.status = HealthStatus::Degraded;
            health.spotify_authenticated = false;
        }
    }

    async fn ensure_spotify_session(&self, spotify: &SpotifyClient) -> Result<()> {
        if self.browser_player.is_some() {
            return self.ensure_browser_session().await;
        }
        if spotify.is_authenticated() {
            return Ok(());
        }
        let store = self
            .refresh_store
            .as_ref()
            .ok_or(PulseError::AuthenticationRequired)?;
        spotify.refresh_with_store(store.as_ref()).await?;
        Ok(())
    }

    fn cache_and_serialize(&self, key: &str, source_url: &str, payload: &Value) -> Result<String> {
        let serialized = self.serialize_payload(payload)?;
        if let Some(cache) = &self.cache {
            let now = unix_now();
            let ttl = i64::try_from(self.api_ttl_seconds).unwrap_or(i64::MAX);
            // Cache failures should not make a successful Spotify response unusable. In
            // particular, a read-only cache filesystem should degrade to network-only mode.
            let _ = cache.put_response(&CachedResponse {
                key: key.to_owned(),
                source_url: source_url.to_owned(),
                payload: serialized.as_bytes().to_vec(),
                etag: None,
                fetched_at: now,
                expires_at: now.saturating_add(ttl),
            });
        }
        Ok(serialized)
    }

    fn serialize_payload(&self, payload: &Value) -> Result<String> {
        let serialized = serde_json::to_string(&payload)?;
        let limit = self.cache.as_ref().map_or(DEFAULT_PAYLOAD_LIMIT, |cache| {
            cache.limits().max_payload_bytes
        });
        if serialized.len() > limit {
            return Err(PulseError::PayloadTooLarge {
                size: serialized.len(),
                limit,
            });
        }
        Ok(serialized)
    }

    pub async fn begin_login(self: &Arc<Self>) -> Result<String> {
        if let Some(browser_player) = &self.browser_player {
            let _guard = self.browser_sync.lock().await;
            self.login_generation.fetch_add(1, Ordering::SeqCst);
            let authorization_url = browser_player.begin_login().await?;
            self.player_setup_url
                .write()
                .map(|mut current| *current = Some(authorization_url.clone()))
                .map_err(|_| PulseError::CacheUnavailable("setup URL lock poisoned".into()))?;
            return Ok(authorization_url);
        }
        let spotify = self
            .spotify
            .as_ref()
            .ok_or_else(|| PulseError::InvalidInput("Spotify client ID is not configured".into()))?
            .clone();
        let mut pending = self.login.lock().await;
        if let Some(current) = pending.as_ref()
            && current.generation == self.login_generation.load(Ordering::SeqCst)
            && !current.task.is_finished()
        {
            // Reopen the current browser login instead of binding its fixed callback port twice.
            return Ok(current.authorization_url.clone());
        }
        if let Some(previous) = pending.take() {
            previous.task.abort();
            // Wait for cancellation to drop the old listener before reusing its port.
            let _ = previous.task.await;
        }
        let generation = self.login_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut login = spotify.begin_login().await?;
        if self.login_generation.load(Ordering::SeqCst) != generation {
            return Err(PulseError::AuthenticationFailed(
                "login was canceled".into(),
            ));
        }
        let authorization_url = login.authorization_url.to_string();
        let state = Arc::clone(self);
        // Keep the callback listener alive in the daemon and complete the token exchange in the
        // background. The browser-facing D-Bus method returns immediately.
        let task = tokio::spawn(async move {
            let result = async {
                let code = login.wait_for_callback(Duration::from_secs(300)).await?;
                if state.login_generation.load(Ordering::SeqCst) != generation {
                    return Err(PulseError::AuthenticationFailed(
                        "login was canceled".into(),
                    ));
                }
                let token = spotify.exchange_code(&login, &code).await?;
                if state.login_generation.load(Ordering::SeqCst) != generation {
                    spotify.clear_token()?;
                    return Err(PulseError::AuthenticationFailed(
                        "login was canceled".into(),
                    ));
                }
                if let Some(store) = &state.refresh_store
                    && let Some(refresh_token) = token.refresh_token.as_deref()
                {
                    store.save(refresh_token)?;
                }
                if state.login_generation.load(Ordering::SeqCst) != generation {
                    spotify.clear_token()?;
                    if let Some(store) = &state.refresh_store {
                        let _ = store.clear();
                    }
                    return Err(PulseError::AuthenticationFailed(
                        "login was canceled".into(),
                    ));
                }
                Ok::<(), PulseError>(())
            }
            .await;
            if let Err(error) = result {
                if state.login_generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                if let Ok(mut health) = state.health.write() {
                    health.error = Some(error.to_string());
                    health.status = HealthStatus::Degraded;
                }
            } else if let Ok(mut health) = state.health.write() {
                health.spotify_authenticated = true;
                health.error = None;
            }
        });
        *pending = Some(PendingLogin {
            authorization_url: authorization_url.clone(),
            generation,
            task,
        });
        Ok(authorization_url)
    }

    pub fn logout(&self) -> Result<()> {
        self.login_generation.fetch_add(1, Ordering::SeqCst);
        if let Some(spotify) = &self.spotify {
            spotify.clear_token()?;
        }
        if let Some(cache) = &self.cache {
            cache.clear_spotify_cache()?;
        }
        if let Ok(mut health) = self.health.write() {
            health.spotify_authenticated = false;
        }
        if let Ok(mut auth) = self.browser_auth.write() {
            *auth = None;
        }
        if let Ok(mut fingerprint) = self.browser_session_fingerprint.write() {
            *fingerprint = None;
        }
        self.browser_session_generation
            .fetch_add(1, Ordering::SeqCst);
        if let Ok(mut setup_url) = self.player_setup_url.write() {
            *setup_url = None;
        }
        self.refresh_store
            .as_ref()
            .map_or(Ok(()), |store| store.clear())
    }

    /// Retire local auth/cache state, then require the helper to clear its player session and
    /// persistent refresh token when browser mode is active.
    pub async fn logout_with_backend(&self) -> Result<()> {
        // Serialize with helper-token import. Whichever operation wins is
        // completed first; logout always clears a token imported just before it.
        let _guard = self.browser_sync.lock().await;
        let local_result = self.logout();
        let helper_result = if let Some(browser_player) = &self.browser_player {
            browser_player.logout().await
        } else {
            Ok(())
        };
        local_result?;
        if let Err(error) = helper_result {
            if let Ok(mut health) = self.health.write() {
                health.error = Some(error.to_string());
                health.status = HealthStatus::Degraded;
            }
            // The helper owns the persistent refresh token. Reporting success while it is
            // unreachable (or while Secret Service deletion failed) would let a service restart
            // silently restore the account the user just logged out of.
            return Err(error);
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

fn base_payload(name: &str, capability: &str) -> Value {
    json!({
        "view": name,
        "items": [],
        "next_cursor": Value::Null,
        "capability": capability,
        "state": capability,
        "stale": false,
        "error": Value::Null,
    })
}

fn unavailable_payload(name: &str, capability: &str, message: &str) -> Value {
    let mut payload = base_payload(name, capability);
    payload["error"] = json!({
        "code": "NOT_CONFIGURED",
        "message": truncate_text(message),
    });
    payload
}

fn error_payload(name: &str, error: &PulseError) -> Value {
    let mut payload = base_payload(name, capability_for_error(error));
    payload["error"] = api_error_value(error);
    payload
}

fn api_error_value(error: &PulseError) -> Value {
    json!({
        "code": error.code(),
        "message": truncate_text(&error.to_string()),
    })
}

fn capability_for_error(error: &PulseError) -> &'static str {
    match error {
        PulseError::AuthenticationRequired | PulseError::AuthenticationFailed(_) => {
            "authentication_required"
        }
        PulseError::PermissionDenied => "permission_denied",
        PulseError::NotFound(_) => "unsupported",
        PulseError::RateLimited { .. } => "rate_limited",
        PulseError::QuotaExceeded => "quota_exceeded",
        PulseError::Io(_)
        | PulseError::Json(_)
        | PulseError::Toml(_)
        | PulseError::TomlSerialize(_)
        | PulseError::Sqlite(_)
        | PulseError::Dbus(_)
        | PulseError::Http(_)
        | PulseError::MissingHome
        | PulseError::InvalidInput(_)
        | PulseError::RetryExhausted { .. }
        | PulseError::PayloadTooLarge { .. }
        | PulseError::CacheUnavailable(_) => "unavailable",
    }
}

fn parse_cached_payload(response: &CachedResponse) -> Option<Value> {
    let payload = serde_json::from_slice::<Value>(&response.payload).ok()?;
    (payload.is_object() && payload.get("items").is_some_and(Value::is_array)).then_some(payload)
}

fn cache_key(prefix: &str, parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prefix.as_bytes());
    for part in parts {
        hasher.update([0]);
        hasher.update(part.as_bytes());
    }
    format!("{prefix}:{:x}", hasher.finalize())
}

fn normalize_view_name(view: &str) -> Result<&'static str> {
    let view = view.trim();
    if view.len() > 64 || view.is_empty() {
        return Err(PulseError::InvalidInput(
            "view name is empty or too long".into(),
        ));
    }
    match view.to_ascii_lowercase().as_str() {
        "home" => Ok("home"),
        "library" => Ok("library"),
        "queue" => Ok("queue"),
        _ => Err(PulseError::InvalidInput(format!(
            "unsupported view: {view}"
        ))),
    }
}

fn parse_cursor(cursor: &str) -> Result<usize> {
    if cursor.len() > MAX_CURSOR_BYTES {
        return Err(PulseError::InvalidInput("view cursor is too long".into()));
    }
    let cursor = cursor.trim();
    if cursor.is_empty() {
        return Ok(0);
    }
    let cursor = cursor.strip_prefix("offset:").unwrap_or(cursor);
    let offset = cursor
        .parse::<usize>()
        .map_err(|_| PulseError::InvalidInput("view cursor is invalid".into()))?;
    if offset > MAX_CURSOR_OFFSET {
        return Err(PulseError::InvalidInput(
            "view cursor is out of bounds".into(),
        ));
    }
    Ok(offset)
}

fn next_cursor(offset: usize, has_more: bool) -> Value {
    if !has_more {
        return Value::Null;
    }
    let next = offset.saturating_add(usize::from(PAGE_SIZE));
    if next > MAX_CURSOR_OFFSET {
        Value::Null
    } else {
        Value::String(next.to_string())
    }
}

fn collection_has_more(value: &Value, offset: usize) -> bool {
    value
        .get("total")
        .and_then(Value::as_u64)
        .and_then(|total| usize::try_from(total).ok())
        .is_some_and(|total| offset.saturating_add(usize::from(PAGE_SIZE)) < total)
        || value
            .get("items")
            .and_then(Value::as_array)
            .is_some_and(|items| items.len() >= usize::from(PAGE_SIZE))
}

fn normalize_item(raw: &Value, kind: &str) -> Option<Value> {
    let object = raw.as_object()?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(truncate_text)?;
    let title = object
        .get("name")
        .or_else(|| object.get("title"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map_or_else(|| id.clone(), truncate_text);

    let artists = object
        .get("artists")
        .and_then(Value::as_array)
        .map(|artists| {
            artists
                .iter()
                .filter_map(|artist| artist.get("name").and_then(Value::as_str))
                .map(truncate_text)
                .take(8)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let artist = if artists.is_empty() {
        None
    } else {
        Some(artists.join(", "))
    };
    let album = object
        .get("album")
        .and_then(Value::as_object)
        .and_then(|album| album.get("name"))
        .and_then(Value::as_str)
        .map(truncate_text);
    let owner = object
        .get("owner")
        .and_then(Value::as_object)
        .and_then(|owner| owner.get("display_name").or_else(|| owner.get("id")))
        .and_then(Value::as_str)
        .map(truncate_text);

    let art_url = object
        .get("album")
        .and_then(first_image_url)
        .or_else(|| first_image_url(raw));
    let uri = object
        .get("uri")
        .and_then(Value::as_str)
        .filter(|uri| uri.starts_with("spotify:"))
        .map_or_else(|| format!("spotify:{kind}:{id}"), truncate_text);
    let spotify_url = object
        .get("external_urls")
        .and_then(|urls| urls.get("spotify"))
        .and_then(Value::as_str)
        .filter(|url| is_spotify_url(url))
        .map_or_else(
            || format!("https://open.spotify.com/{kind}/{id}"),
            truncate_text,
        );

    let mut item = Map::new();
    item.insert("id".into(), Value::String(id));
    item.insert("type".into(), Value::String(kind.into()));
    item.insert("title".into(), Value::String(title.clone()));
    item.insert("name".into(), Value::String(title));
    item.insert("uri".into(), Value::String(uri));
    item.insert("spotify_url".into(), Value::String(spotify_url.clone()));
    item.insert("url".into(), Value::String(spotify_url));
    item.insert(
        "subtitle".into(),
        Value::String(
            artist
                .clone()
                .or(owner.clone())
                .unwrap_or_else(|| kind.to_owned()),
        ),
    );
    if let Some(artist) = artist {
        item.insert("artist".into(), Value::String(artist));
    }
    if !artists.is_empty() {
        item.insert(
            "artists".into(),
            Value::Array(artists.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(album) = album {
        item.insert("album".into(), Value::String(album));
    }
    if let Some(owner) = owner {
        item.insert("owner".into(), Value::String(owner));
    }
    if let Some(art_url) = art_url {
        item.insert("art_url".into(), Value::String(art_url));
    }
    Some(Value::Object(item))
}

fn first_image_url(value: &Value) -> Option<String> {
    value
        .get("images")
        .and_then(Value::as_array)
        .and_then(|images| images.first())
        .and_then(|image| image.get("url"))
        .and_then(Value::as_str)
        .filter(|url| url.starts_with("https://"))
        .map(truncate_text)
}

fn is_spotify_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host == "spotify.com" || host.ends_with(".spotify.com"))
}

fn truncate_text(value: &str) -> String {
    if value.len() <= MAX_TEXT_BYTES {
        return value.to_owned();
    }
    let max = MAX_TEXT_BYTES.saturating_sub(3);
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let next = index + character.len_utf8();
        if next > max {
            break;
        }
        end = next;
    }
    format!("{}...", &value[..end])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UriRoute {
    Spotify,
    ExternalBrowser,
}

fn route_uri(uri: &str) -> Result<UriRoute> {
    let parsed = url::Url::parse(uri)
        .map_err(|error| PulseError::InvalidInput(format!("invalid URI: {error}")))?;
    match parsed.scheme() {
        "spotify" => Ok(UriRoute::Spotify),
        "http" | "https" => Ok(UriRoute::ExternalBrowser),
        _ => Err(PulseError::InvalidInput(
            "only spotify, http, and https URIs are supported".into(),
        )),
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

    #[zbus(out_args("health_json"))]
    fn health(&self) -> zbus::fdo::Result<String> {
        serde_json::to_string(&self.state.health())
            .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))
    }

    #[zbus(out_args("snapshot_json"))]
    fn get_snapshot(&self) -> String {
        self.state.snapshot().to_json()
    }

    async fn refresh(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let snapshot = self.state.refresh().await.map_err(to_dbus_error)?;
        emit_snapshot_signals(&emitter, snapshot).await
    }

    #[zbus(out_args("results_json"))]
    async fn search(&self, query: String) -> zbus::fdo::Result<String> {
        self.state.search(&query).await.map_err(to_dbus_error)
    }

    #[zbus(out_args("view_json"))]
    async fn get_view(&self, view: String, cursor: String) -> zbus::fdo::Result<String> {
        self.state
            .get_view(&view, &cursor)
            .await
            .map_err(to_dbus_error)
    }

    #[zbus(out_args("auth_state_json"))]
    async fn get_auth_state(&self) -> String {
        self.state.auth_state_json_for_dbus().await
    }

    async fn open_uri(&self, uri: String) -> zbus::fdo::Result<()> {
        self.state.open_uri(&uri).await.map_err(to_dbus_error)
    }

    async fn play_pause(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let snapshot = self.state.play_pause().await.map_err(to_dbus_error)?;
        emit_snapshot_signals(&emitter, snapshot).await
    }

    async fn next(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let snapshot = self.state.next().await.map_err(to_dbus_error)?;
        emit_snapshot_signals(&emitter, snapshot).await
    }

    async fn previous(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let snapshot = self.state.previous().await.map_err(to_dbus_error)?;
        emit_snapshot_signals(&emitter, snapshot).await
    }

    async fn seek(
        &self,
        position_us: i64,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        let snapshot = self.state.seek(position_us).await.map_err(to_dbus_error)?;
        emit_snapshot_signals(&emitter, snapshot).await
    }

    #[zbus(out_args("authorization_url"))]
    async fn begin_login(&self) -> zbus::fdo::Result<String> {
        self.state
            .clone()
            .begin_login()
            .await
            .map_err(to_dbus_error)
    }

    async fn logout(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<()> {
        self.state
            .logout_with_backend()
            .await
            .map_err(to_dbus_error)?;
        Self::login_state_changed(&emitter, false)
            .await
            .map_err(to_dbus_zbus_error)
    }

    #[zbus(signal)]
    async fn snapshot_changed(
        emitter: &SignalEmitter<'_>,
        snapshot_json: String,
    ) -> zbus::Result<()>;

    #[zbus(signal, name = "PlaybackChanged")]
    async fn playback_signal_changed(
        emitter: &SignalEmitter<'_>,
        snapshot_json: String,
    ) -> zbus::Result<()>;

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

async fn emit_snapshot_signals(
    emitter: &SignalEmitter<'_>,
    snapshot: PlaybackSnapshot,
) -> zbus::fdo::Result<()> {
    let payload = snapshot.to_json();
    PulseDbus::snapshot_changed(emitter, payload.clone())
        .await
        .map_err(to_dbus_zbus_error)?;
    PulseDbus::playback_signal_changed(emitter, payload)
        .await
        .map_err(to_dbus_zbus_error)
}

/// Publish a snapshot refreshed outside a D-Bus method, such as the daemon's periodic MPRIS poll.
pub async fn emit_snapshot_update(
    connection: &zbus::Connection,
    snapshot: PlaybackSnapshot,
) -> Result<()> {
    let emitter = SignalEmitter::new(connection, OBJECT_PATH)?;
    emit_snapshot_signals(&emitter, snapshot).await?;
    Ok(())
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
    use crate::browser_player::BrowserPlayer;
    use crate::cache::{CacheLimits, CacheRepository};
    use crate::model::PlaybackStatus;
    use crate::spotify::{RetryPolicy, SpotifyClient, TokenSet};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tempfile::tempdir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::time::timeout;
    use zbus::object_server::Interface;

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

    #[test]
    fn health_reflects_a_token_restored_after_state_construction() {
        let spotify = SpotifyClient::new("test-client").unwrap();
        let state = DaemonState::new(None, Some(spotify.clone()), None);
        assert!(!state.health().spotify_authenticated);

        spotify
            .set_token(TokenSet::new("access-token", "Bearer", None, 3_600))
            .unwrap();

        assert!(state.health().spotify_authenticated);
        spotify.clear_token().unwrap();
        assert!(!state.health().spotify_authenticated);
    }

    #[tokio::test]
    async fn browser_logout_reports_missing_helper_after_retiring_local_token() {
        let spotify = SpotifyClient::new("test-client").unwrap();
        spotify
            .set_token(TokenSet::new("access-token", "Bearer", None, 3_600))
            .unwrap();
        let runtime = tempdir().unwrap();
        let player = BrowserPlayer::new_with_runtime_dir(runtime.path()).unwrap();
        let state = DaemonState::new(None, Some(spotify.clone()), None).with_browser_player(player);

        assert!(state.logout_with_backend().await.is_err());
        assert!(!spotify.is_authenticated());
        assert!(!state.health().spotify_authenticated);
    }

    #[tokio::test]
    async fn repeated_login_reuses_pending_attempt_and_logout_allows_the_same_port() {
        let reserved = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = reserved.local_addr().unwrap().port();
        drop(reserved);
        let spotify = SpotifyClient::new("fixture-client")
            .unwrap()
            .with_redirect_port(port);
        let state = Arc::new(DaemonState::new(None, Some(spotify), None));

        let first = state.begin_login().await.unwrap();
        assert_eq!(state.begin_login().await.unwrap(), first);
        state.logout().unwrap();
        let next = timeout(Duration::from_secs(5), state.begin_login())
            .await
            .unwrap()
            .unwrap();
        assert_ne!(next, first, "logout must retire the old PKCE state");
        let next = url::Url::parse(&next).unwrap();
        assert_eq!(
            next.query_pairs()
                .find(|(key, _)| key == "redirect_uri")
                .unwrap()
                .1,
            format!("http://127.0.0.1:{port}/callback")
        );
    }

    #[test]
    fn generated_introspection_keeps_the_checked_in_contract_in_sync() {
        let state = Arc::new(DaemonState::new(None, None, None));
        let dbus = PulseDbus::new(state);
        let mut generated = String::new();
        dbus.introspect_to_writer(&mut generated, 0);
        for declaration in [
            r#"<interface name="io.kanterlabs.Pulse1">"#,
            r#"<method name="Health">"#,
            r#"<arg name="health_json" type="s" direction="out"/>"#,
            r#"<method name="GetSnapshot">"#,
            r#"<arg name="snapshot_json" type="s" direction="out"/>"#,
            r#"<method name="Refresh">"#,
            r#"<method name="Search">"#,
            r#"<arg name="results_json" type="s" direction="out"/>"#,
            r#"<method name="GetView">"#,
            r#"<arg name="view" type="s" direction="in"/>"#,
            r#"<arg name="cursor" type="s" direction="in"/>"#,
            r#"<arg name="view_json" type="s" direction="out"/>"#,
            r#"<method name="GetAuthState">"#,
            r#"<arg name="auth_state_json" type="s" direction="out"/>"#,
            r#"<method name="OpenUri">"#,
            r#"<method name="PlayPause">"#,
            r#"<method name="Next">"#,
            r#"<method name="Previous">"#,
            r#"<method name="Seek">"#,
            r#"<method name="BeginLogin">"#,
            r#"<arg name="authorization_url" type="s" direction="out"/>"#,
            r#"<method name="Logout">"#,
            r#"<signal name="SnapshotChanged">"#,
            r#"<signal name="PlaybackChanged">"#,
            r#"<signal name="LoginStateChanged">"#,
            r#"<arg name="authenticated" type="b"/>"#,
            r#"<signal name="ErrorChanged">"#,
            r#"<arg name="code" type="s"/>"#,
            r#"<arg name="message" type="s"/>"#,
        ] {
            assert!(
                generated.contains(declaration),
                "missing {declaration} in {generated}"
            );
        }
        let canonical = include_str!("../../../dbus/io.kanterlabs.Pulse1.xml");
        for declaration in [
            r#"<method name="GetView">"#,
            r#"<method name="GetAuthState">"#,
            r#"<signal name="PlaybackChanged">"#,
            r#"<arg name="authenticated" type="b"/>"#,
            r#"<arg name="code" type="s"/>"#,
            r#"<arg name="message" type="s"/>"#,
        ] {
            assert!(
                canonical.contains(declaration),
                "missing {declaration} in XML"
            );
        }
    }

    #[tokio::test]
    async fn views_are_normalized_and_search_uses_stale_cache_on_failure() {
        let (api_url, failing, server) = spawn_mock_api().await;
        let mut spotify = SpotifyClient::with_urls(
            "test-client",
            &format!("{api_url}/v1"),
            &api_url,
            Vec::new(),
        )
        .unwrap();
        spotify.set_retry_policy(RetryPolicy::new(1, Duration::ZERO, Duration::ZERO));
        spotify
            .set_token(TokenSet::new("test-access-token", "Bearer", None, 3_600))
            .unwrap();
        let directory = tempdir().unwrap();
        let cache = Arc::new(
            CacheRepository::open(
                directory.path().join("pulse.sqlite3"),
                CacheLimits::default(),
            )
            .unwrap(),
        );
        let state = DaemonState::new(None, Some(spotify), Some(cache)).with_api_ttl_seconds(1);

        let search: serde_json::Value =
            serde_json::from_str(&state.search("jazz").await.unwrap()).unwrap();
        assert!(search["items"].is_array());
        assert_eq!(
            search["items"][0]["spotify_url"],
            "https://open.spotify.com/track/t1"
        );
        assert_eq!(search["items"][0]["uri"], "spotify:track:t1");
        assert!(search["items"][0]["source_art_url"].is_string());

        let home: serde_json::Value =
            serde_json::from_str(&state.get_view("home", "").await.unwrap()).unwrap();
        assert!(home["items"].is_array());
        assert!(home["sections"]["recent"].is_array());
        assert!(home["sections"]["playlists"].is_array());

        let library: serde_json::Value =
            serde_json::from_str(&state.get_view("library", "").await.unwrap()).unwrap();
        assert!(library["items"].is_array());
        assert!(library["sections"]["liked"].is_array());

        let queue: serde_json::Value =
            serde_json::from_str(&state.get_view("queue", "").await.unwrap()).unwrap();
        assert!(queue["items"].is_array());
        assert!(queue["currently_playing"]["spotify_url"].is_string());

        // Let the one-second response TTL elapse, then make the endpoint fail. The daemon should
        // retain the normalized page and annotate it as stale instead of returning an empty page.
        tokio::time::sleep(Duration::from_secs(2)).await;
        failing.store(true, Ordering::Release);
        let stale_payload: serde_json::Value =
            serde_json::from_str(&state.search("jazz").await.unwrap()).unwrap();
        assert_eq!(stale_payload["stale"], true);
        assert_eq!(stale_payload["items"][0]["id"], "t1");
        assert_eq!(stale_payload["error"]["code"], "NETWORK_ERROR");

        failing.store(false, Ordering::Release);
        server.abort();
    }

    #[tokio::test]
    async fn unconfigured_views_have_a_stable_capability_shape() {
        let state = DaemonState::new(None, None, None);
        let search: serde_json::Value =
            serde_json::from_str(&state.search("jazz").await.unwrap()).unwrap();
        assert_eq!(search["capability"], "not_configured");
        assert!(search["items"].is_array());
        let view: serde_json::Value =
            serde_json::from_str(&state.get_view("queue", "").await.unwrap()).unwrap();
        assert_eq!(view["capability"], "not_configured");
        assert!(view["items"].is_array());
        let auth: serde_json::Value = serde_json::from_str(&state.auth_state_json()).unwrap();
        assert_eq!(auth["state"], "not_configured");
        assert_eq!(auth["authenticated"], false);
    }

    async fn spawn_mock_api() -> (String, Arc<AtomicBool>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let failing = Arc::new(AtomicBool::new(false));
        let server_failing = Arc::clone(&failing);
        let server = tokio::spawn(async move {
            loop {
                let accepted = timeout(Duration::from_millis(50), listener.accept()).await;
                let Ok(Ok((mut stream, _))) = accepted else {
                    continue;
                };
                let mut request = [0_u8; 4 * 1024];
                let bytes = stream.read(&mut request).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&request[..bytes]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .and_then(|target| target.split('?').next())
                    .unwrap_or("");
                let (status, body) = if server_failing.load(Ordering::Acquire) {
                    ("503 Service Unavailable", "{}".to_owned())
                } else {
                    ("200 OK", mock_body(path).to_owned())
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (format!("http://{address}"), failing, server)
    }

    fn mock_body(path: &str) -> &'static str {
        match path {
            "/v1/search" => {
                r#"{"tracks":{"items":[{"id":"t1","name":"Song","uri":"spotify:track:t1","artists":[{"name":"Artist"}],"album":{"name":"Album","images":[{"url":"https://images.example/t.jpg"}]},"external_urls":{"spotify":"https://open.spotify.com/track/t1"}}],"total":1}}"#
            }
            "/v1/me/player/recently-played" => {
                r#"{"items":[{"played_at":"2026-09-03T00:00:00Z","track":{"id":"t1","name":"Song","uri":"spotify:track:t1","artists":[{"name":"Artist"}],"album":{"name":"Album"},"external_urls":{"spotify":"https://open.spotify.com/track/t1"}}}]}"#
            }
            "/v1/me/playlists" => {
                r#"{"items":[{"id":"p1","name":"Mix","uri":"spotify:playlist:p1","images":[],"owner":{"display_name":"Owner"},"external_urls":{"spotify":"https://open.spotify.com/playlist/p1"}}],"total":1}"#
            }
            "/v1/me/tracks" => {
                r#"{"items":[{"added_at":"2026-09-03T00:00:00Z","track":{"id":"t1","name":"Song","uri":"spotify:track:t1","artists":[{"name":"Artist"}],"album":{"name":"Album"},"external_urls":{"spotify":"https://open.spotify.com/track/t1"}}}],"total":1}"#
            }
            "/v1/me/player/queue" => {
                r#"{"currently_playing":{"id":"t1","name":"Song","uri":"spotify:track:t1","artists":[{"name":"Artist"}],"album":{"name":"Album"},"external_urls":{"spotify":"https://open.spotify.com/track/t1"}},"queue":[{"id":"t1","name":"Song","uri":"spotify:track:t1","artists":[{"name":"Artist"}],"album":{"name":"Album"},"external_urls":{"spotify":"https://open.spotify.com/track/t1"}}]}"#
            }
            _ => "{}",
        }
    }
}
