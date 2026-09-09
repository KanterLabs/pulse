//! Small, forwards-compatible TOML configuration file.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{PulseError, Result};
use crate::paths::XdgPaths;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct PulseConfig {
    pub spotify: SpotifyConfig,
    pub cache: CacheConfig,
    pub server: ServerConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct SpotifyConfig {
    /// Public Spotify application ID. A client secret is deliberately unsupported for PKCE.
    pub client_id: Option<String>,
    /// Loopback callback port registered in the dashboard; zero preserves dynamic assignment.
    pub redirect_port: u16,
    pub scopes: Vec<String>,
    pub api_base_url: String,
    pub accounts_base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct CacheConfig {
    pub snapshot_ttl_seconds: u64,
    pub api_ttl_seconds: u64,
    pub max_api_rows: usize,
    pub max_payload_bytes: usize,
    pub max_artwork_bytes: usize,
    pub max_artwork_disk_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ServerConfig {
    pub poll_interval_seconds: u64,
}

impl Default for SpotifyConfig {
    fn default() -> Self {
        Self {
            client_id: None,
            redirect_port: 0,
            scopes: vec![
                "user-read-playback-state".into(),
                "user-read-currently-playing".into(),
                "user-read-recently-played".into(),
                "user-library-read".into(),
                "playlist-read-private".into(),
                "playlist-read-collaborative".into(),
            ],
            api_base_url: "https://api.spotify.com/v1".into(),
            accounts_base_url: "https://accounts.spotify.com".into(),
        }
    }
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            snapshot_ttl_seconds: 30,
            api_ttl_seconds: 300,
            max_api_rows: 100,
            max_payload_bytes: 4 * 1024 * 1024,
            max_artwork_bytes: 8 * 1024 * 1024,
            max_artwork_disk_bytes: 128 * 1024 * 1024,
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            poll_interval_seconds: 5,
        }
    }
}

impl PulseConfig {
    pub fn load(paths: &XdgPaths) -> Result<Self> {
        if !paths.config_file.exists() {
            return Ok(Self::default());
        }
        let bytes = std::fs::read(&paths.config_file)?;
        let text = String::from_utf8(bytes)
            .map_err(|error| PulseError::InvalidInput(format!("config is not UTF-8: {error}")))?;
        let config: Self = toml::from_str(&text).map_err(PulseError::Toml)?;
        config.validate()?;
        Ok(config)
    }

    pub fn save(&self, paths: &XdgPaths) -> Result<()> {
        self.validate()?;
        paths.ensure_dirs()?;
        let rendered = toml::to_string_pretty(self)?;
        let temporary = paths.config_file.with_extension("toml.tmp");
        std::fs::write(&temporary, rendered.as_bytes())?;
        std::fs::rename(temporary, &paths.config_file)?;
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        validate_url(&self.spotify.api_base_url, "spotify.api_base_url")?;
        validate_url(&self.spotify.accounts_base_url, "spotify.accounts_base_url")?;
        if self.cache.max_payload_bytes == 0
            || self.cache.max_artwork_bytes == 0
            || self.cache.max_artwork_disk_bytes == 0
        {
            return Err(PulseError::InvalidInput(
                "cache byte limits must be greater than zero".into(),
            ));
        }
        if self.server.poll_interval_seconds == 0 {
            return Err(PulseError::InvalidInput(
                "server.poll_interval_seconds must be greater than zero".into(),
            ));
        }
        Ok(())
    }

    #[must_use]
    pub fn client_id(&self) -> Option<&str> {
        self.spotify
            .client_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
    }
}

fn validate_url(value: &str, field: &str) -> Result<()> {
    let parsed = url::Url::parse(value)
        .map_err(|error| PulseError::InvalidInput(format!("{field} is not a URL: {error}")))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(PulseError::InvalidInput(format!(
            "{field} must use http or https"
        )));
    }
    Ok(())
}

/// Helper used by tests and diagnostics to avoid writing credentials accidentally.
#[must_use]
pub fn is_safe_config_path(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == "config.toml")
}

#[cfg(test)]
mod tests {
    use super::{PulseConfig, is_safe_config_path};
    use crate::paths::XdgPaths;
    use std::path::Path;
    use tempfile::tempdir;

    #[test]
    fn defaults_include_only_read_scopes() {
        let config = PulseConfig::default();
        assert!(config.spotify.scopes.iter().all(|scope| {
            !scope.contains("modify") && !scope.contains("write") && !scope.contains("delete")
        }));
        assert!(config.client_id().is_none());
        assert_eq!(config.spotify.redirect_port, 0);
    }

    #[test]
    fn config_round_trips_atomically() {
        let root = tempdir().unwrap();
        let paths = XdgPaths::from_environment_values(
            Some(root.path()),
            Some(&root.path().join("config")),
            Some(&root.path().join("data")),
            Some(&root.path().join("cache")),
        )
        .unwrap();
        let mut config = PulseConfig::default();
        config.spotify.client_id = Some("public-id".into());
        config.spotify.redirect_port = 8888;
        config.save(&paths).unwrap();
        assert!(is_safe_config_path(Path::new("/x/config.toml")));
        assert_eq!(PulseConfig::load(&paths).unwrap(), config);
    }
}
