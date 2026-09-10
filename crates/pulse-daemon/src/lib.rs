#![forbid(unsafe_code)]
#![allow(clippy::doc_markdown)]
#![allow(clippy::missing_errors_doc)]
#![allow(clippy::struct_excessive_bools)]

pub mod browser_player;
pub mod cache;
pub mod config;
pub mod dbus_service;
pub mod error;
pub mod model;
pub mod mpris;
pub mod paths;
pub mod spotify;

pub use browser_player::{BrowserAuthState, BrowserPlayer, BrowserToken};
pub use cache::{ArtworkCache, CacheLimits, CacheRepository, CachedResponse, CachedSnapshot};
pub use config::PulseConfig;
pub use dbus_service::{
    BUS_NAME, DaemonState, INTERFACE, OBJECT_PATH, PulseDbus, emit_snapshot_update, serve,
};
pub use error::{PulseError, Result};
pub use model::{HealthSnapshot, HealthStatus, PlaybackSnapshot, PlaybackStatus};
pub use mpris::MprisClient;
pub use paths::XdgPaths;
pub use spotify::{
    MemoryRefreshTokenStore, PkceLogin, RateLimitState, RefreshTokenStore, RetryPolicy,
    SecretServiceStore, SpotifyClient, TokenSet,
};
