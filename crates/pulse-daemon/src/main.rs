use std::sync::Arc;
use std::time::Duration;

use pulse_daemon::{
    ArtworkCache, CacheLimits, CacheRepository, DaemonState, MprisClient, PulseConfig,
    RefreshTokenStore, SecretServiceStore, SpotifyClient, XdgPaths, emit_snapshot_update, serve,
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
    let mpris = match MprisClient::connect().await {
        Ok(client) => Some(client),
        Err(error) => {
            eprintln!("MPRIS unavailable; starting disconnected: {error}");
            None
        }
    };
    let spotify = config
        .client_id()
        .map(|client_id| {
            SpotifyClient::with_urls(
                client_id,
                &config.spotify.api_base_url,
                &config.spotify.accounts_base_url,
                config.spotify.scopes.clone(),
            )
        })
        .transpose()?;
    let refresh_store = config.client_id().map(|client_id| {
        Arc::new(SecretServiceStore::new(client_id)) as Arc<dyn RefreshTokenStore>
    });
    let mut daemon_state = DaemonState::new(mpris, spotify.clone(), Some(cache))
        .with_artwork_cache(artwork_cache)
        .with_api_ttl_seconds(config.cache.api_ttl_seconds);
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
    match state.refresh().await {
        Ok(snapshot) => {
            if let Err(error) = emit_snapshot_update(&connection, snapshot).await {
                eprintln!("initial playback signal failed: {error}");
            }
        }
        Err(error) => eprintln!("initial playback refresh failed: {error}"),
    }
    eprintln!("pulse-daemon backend initialized");
    let mut interval = tokio::time::interval(Duration::from_secs(
        config.server.poll_interval_seconds.max(1),
    ));
    // The first Tokio interval tick is immediate; the explicit refresh above already supplied it.
    interval.tick().await;
    loop {
        interval.tick().await;
        match state.refresh().await {
            Ok(snapshot) => {
                if let Err(error) = emit_snapshot_update(&connection, snapshot).await {
                    eprintln!("playback signal failed: {error}");
                }
            }
            Err(error) => eprintln!("playback refresh failed: {error}"),
        }
    }
}
