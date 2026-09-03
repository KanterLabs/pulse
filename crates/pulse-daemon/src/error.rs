//! Error types shared by the daemon's persistence, desktop integration, and API layers.

use std::time::Duration;

use thiserror::Error;

/// Result alias used throughout the daemon.
pub type Result<T> = std::result::Result<T, PulseError>;

/// Errors that can be safely surfaced to the D-Bus boundary.
#[derive(Debug, Error)]
pub enum PulseError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("TOML error: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("TOML serialization error: {0}")]
    TomlSerialize(#[from] toml::ser::Error),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("D-Bus error: {0}")]
    Dbus(#[from] zbus::Error),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("missing HOME and XDG directory environment variables")]
    MissingHome,
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("resource not found: {0}")]
    NotFound(String),
    #[error("Spotify authentication is required")]
    AuthenticationRequired,
    #[error("Spotify authentication was rejected: {0}")]
    AuthenticationFailed(String),
    #[error("Spotify permission denied")]
    PermissionDenied,
    #[error("Spotify rate limit reached; retry after {retry_after:?}")]
    RateLimited { retry_after: Duration },
    #[error("Spotify development quota exhausted")]
    QuotaExceeded,
    #[error("request failed after {attempts} attempts: {message}")]
    RetryExhausted { attempts: u32, message: String },
    #[error("cache payload exceeds configured limit ({size} bytes > {limit} bytes)")]
    PayloadTooLarge { size: usize, limit: usize },
    #[error("cache is unavailable: {0}")]
    CacheUnavailable(String),
}

impl PulseError {
    /// Return a stable machine-readable code suitable for D-Bus clients.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "IO_ERROR",
            Self::Json(_) | Self::Toml(_) | Self::TomlSerialize(_) => "CONFIG_ERROR",
            Self::Sqlite(_) | Self::CacheUnavailable(_) => "CACHE_ERROR",
            Self::Dbus(_) => "DBUS_ERROR",
            Self::Http(_) | Self::RetryExhausted { .. } => "NETWORK_ERROR",
            Self::MissingHome => "XDG_ERROR",
            Self::InvalidInput(_) => "INVALID_INPUT",
            Self::NotFound(_) => "NOT_FOUND",
            Self::AuthenticationRequired | Self::AuthenticationFailed(_) => "AUTH_REQUIRED",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::RateLimited { .. } => "RATE_LIMITED",
            Self::QuotaExceeded => "QUOTA_EXCEEDED",
            Self::PayloadTooLarge { .. } => "PAYLOAD_TOO_LARGE",
        }
    }
}

impl From<zbus::fdo::Error> for PulseError {
    fn from(error: zbus::fdo::Error) -> Self {
        Self::Dbus(error.into())
    }
}
