use std::sync::Arc;
use std::time::Duration;

use pulse_daemon::{
    ArtworkCache, BrowserPlayer, CacheLimits, CacheRepository, DaemonState, MprisClient,
    PulseConfig, RefreshTokenStore, SecretServiceStore, SpotifyClient, XdgPaths,
    emit_snapshot_update, serve,
};

#[tokio::main]
async fn main() -> pulse_daemon::Result<()> {
    let paths = XdgPaths::from_environment()?;
    paths.ensure_dirs()?;
    let config = PulseConfig::load(&paths)?;
    config.validate()?;
    let limits = CacheLimits {
        max_api_rows: config.cache.max_api_rows,
        max_payload_bytes: config.cache.max_payload_bytes,
        max_artwork_bytes: config.cache.max_artwork_bytes,
        max_artwork_disk_bytes: config.cache.max_artwork_disk_bytes,
    };
    let cache = Arc::new(CacheRepository::open(&paths.database_file, limits)?);
    let artwork_cache = ArtworkCache::new(
        &paths.artwork_dir,
        config.cache.max_artwork_bytes,
        config.cache.max_artwork_disk_bytes,
    )?;
    let browser_mode = std::env::var("PULSE_PLAYBACK_BACKEND")
        .is_ok_and(|backend| backend.eq_ignore_ascii_case("browser"));
    let mpris = if browser_mode {
        None
    } else {
        match MprisClient::connect().await {
            Ok(client) => Some(client),
            Err(error) => {
                eprintln!("MPRIS unavailable; starting disconnected: {error}");
                None
            }
        }
    };
    let spotify = if browser_mode {
        // Browser OAuth and refresh persistence belong to the helper. This public-looking value
        // exists only so the daemon can address Spotify's Web API after receiving a short-lived
        // helper token; it is never sent to an OAuth endpoint.
        Some(
            SpotifyClient::with_urls(
                "00000000000000000000000000000000",
                &config.spotify.api_base_url,
                &config.spotify.accounts_base_url,
                config.spotify.scopes.clone(),
            )?
            .with_redirect_port(config.spotify.redirect_port),
        )
    } else {
        config
            .client_id()
            .map(|client_id| {
                SpotifyClient::with_urls(
                    client_id,
                    &config.spotify.api_base_url,
                    &config.spotify.accounts_base_url,
                    config.spotify.scopes.clone(),
                )
                .map(|client| client.with_redirect_port(config.spotify.redirect_port))
            })
            .transpose()?
    };
    let refresh_store = if browser_mode {
        None
    } else {
        config.client_id().map(|client_id| {
            Arc::new(SecretServiceStore::new(client_id)) as Arc<dyn RefreshTokenStore>
        })
    };
    let browser_player = browser_mode.then_some(BrowserPlayer::new()).transpose()?;
    let mut daemon_state = DaemonState::new(mpris, spotify.clone(), Some(cache))
        .with_artwork_cache(artwork_cache)
        .with_api_ttl_seconds(config.cache.api_ttl_seconds);
    if let Some(browser_player) = browser_player {
        daemon_state = daemon_state.with_browser_player(browser_player);
    }
    if let Some(store) = refresh_store.clone() {
        daemon_state = daemon_state.with_refresh_store(store);
    }
    let state = Arc::new(daemon_state.with_snapshot_ttl_seconds(config.cache.snapshot_ttl_seconds));
    if let (Some(spotify), Some(store)) = (&spotify, refresh_store.as_ref()) {
        match store.load() {
            Ok(Some(_)) => {
                if let Err(error) = spotify.refresh_with_store(store.as_ref()).await {
                    // Secret Service failures and revoked sessions are expected desktop states;
                    // continue in logged-out mode so MPRIS remains useful.
                    eprintln!("stored Spotify session unavailable: {}", error.code());
                }
            }
            Ok(None) => {}
            Err(error) => {
                // Do not make startup depend on secret-tool, a running keyring, or a collection
                // being unlocked. No token value is ever included in this diagnostic.
                eprintln!(
                    "Spotify refresh-token storage unavailable: {}",
                    error.code()
                );
            }
        }
    }
    let connection = serve(Arc::clone(&state)).await?;
    // A live process with a closed service connection is unreachable by the extension.
    // Watch the connection independently of refresh work and the configured poll interval;
    // returning an error lets the user unit's Restart=on-failure rebuild both D-Bus clients.
    tokio::select! {
        () = connection.closed() => Err(zbus::Error::Failure(
            "session D-Bus connection closed; exiting for service restart".into(),
        ).into()),
        result = refresh_playback(
            &state,
            &connection,
            Duration::from_secs(config.server.poll_interval_seconds.max(1)),
        ) => result,
    }
}

async fn refresh_playback(
    state: &DaemonState,
    connection: &zbus::Connection,
    poll_interval: Duration,
) -> pulse_daemon::Result<()> {
    match state.refresh().await {
        Ok(snapshot) => {
            emit_snapshot_update(connection, snapshot).await?;
        }
        Err(error) => eprintln!("initial playback refresh failed: {error}"),
    }
    eprintln!("pulse-daemon backend initialized");
    let mut interval = tokio::time::interval(poll_interval);
    // The first Tokio interval tick is immediate; the explicit refresh above already supplied it.
    interval.tick().await;
    loop {
        interval.tick().await;
        match state.refresh().await {
            Ok(snapshot) => {
                emit_snapshot_update(connection, snapshot).await?;
            }
            Err(error) => eprintln!("playback refresh failed: {error}"),
        }
    }
}
