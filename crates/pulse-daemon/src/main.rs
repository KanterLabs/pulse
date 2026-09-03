use std::sync::Arc;
use std::time::Duration;

use pulse_daemon::{
    ArtworkCache, CacheLimits, CacheRepository, DaemonState, MprisClient, PulseConfig,
    RefreshTokenStore, SecretServiceStore, SpotifyClient, XdgPaths, serve,
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
    let _artwork_cache = ArtworkCache::new(
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
    let mut daemon_state = DaemonState::new(mpris, spotify.clone(), Some(cache));
    if let Some(store) = refresh_store.clone() {
        daemon_state = daemon_state.with_refresh_store(store);
    }
    let state = Arc::new(daemon_state.with_snapshot_ttl_seconds(config.cache.snapshot_ttl_seconds));
    if let (Some(spotify), Some(store)) = (&spotify, refresh_store.as_ref())
        && store.load()?.is_some()
        && let Err(error) = spotify.refresh_with_store(store.as_ref()).await
    {
        eprintln!("stored Spotify session unavailable: {error}");
    }
    let _connection = serve(Arc::clone(&state)).await?;
    if let Err(error) = state.refresh().await {
        eprintln!("initial playback refresh failed: {error}");
    }
    eprintln!("pulse-daemon backend initialized");
    let mut interval = tokio::time::interval(Duration::from_secs(
        config.server.poll_interval_seconds.max(1),
    ));
    loop {
        interval.tick().await;
        if let Err(error) = state.refresh().await {
            eprintln!("playback refresh failed: {error}");
        }
    }
}
