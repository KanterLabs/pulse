//! XDG-compliant per-user paths.

use std::env;
use std::path::{Path, PathBuf};

use crate::error::{PulseError, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XdgPaths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub config_file: PathBuf,
    pub database_file: PathBuf,
    pub artwork_dir: PathBuf,
}

impl XdgPaths {
    pub fn from_environment() -> Result<Self> {
        let home = env::var_os("HOME").map(PathBuf::from);
        Self::from_environment_values(
            home.as_deref(),
            env::var_os("XDG_CONFIG_HOME").as_deref().map(Path::new),
            env::var_os("XDG_DATA_HOME").as_deref().map(Path::new),
            env::var_os("XDG_CACHE_HOME").as_deref().map(Path::new),
        )
    }

    /// Build paths from explicit values, useful for tests and callers that have their own env
    /// abstraction. Relative XDG values are ignored per the XDG Base Directory specification.
    pub fn from_environment_values(
        home: Option<&Path>,
        config_home: Option<&Path>,
        data_home: Option<&Path>,
        cache_home: Option<&Path>,
    ) -> Result<Self> {
        let home = home.ok_or(PulseError::MissingHome)?;
        let config_base = absolute_or_home(config_home, home, ".config");
        let data_base = absolute_or_home(data_home, home, ".local/share");
        let cache_base = absolute_or_home(cache_home, home, ".cache");
        let config_dir = config_base.join("pulse");
        let data_dir = data_base.join("pulse");
        let cache_dir = cache_base.join("pulse");
        Ok(Self {
            config_file: config_dir.join("config.toml"),
            database_file: data_dir.join("pulse.sqlite3"),
            artwork_dir: cache_dir.join("artwork"),
            config_dir,
            data_dir,
            cache_dir,
        })
    }

    pub fn ensure_dirs(&self) -> Result<()> {
        std::fs::create_dir_all(&self.config_dir)?;
        std::fs::create_dir_all(&self.data_dir)?;
        std::fs::create_dir_all(&self.artwork_dir)?;
        Ok(())
    }
}

fn absolute_or_home(value: Option<&Path>, home: &Path, fallback: &str) -> PathBuf {
    value
        .filter(|path| path.is_absolute())
        .map_or_else(|| home.join(fallback), Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::XdgPaths;

    #[test]
    fn uses_xdg_overrides_and_app_namespace() {
        let paths = XdgPaths::from_environment_values(
            Some(Path::new("/home/test")),
            Some(Path::new("/tmp/config")),
            Some(Path::new("/tmp/data")),
            Some(Path::new("/tmp/cache")),
        )
        .unwrap();
        assert_eq!(
            paths.config_file,
            Path::new("/tmp/config/pulse/config.toml")
        );
        assert_eq!(
            paths.database_file,
            Path::new("/tmp/data/pulse/pulse.sqlite3")
        );
        assert_eq!(paths.artwork_dir, Path::new("/tmp/cache/pulse/artwork"));
    }

    #[test]
    fn relative_xdg_values_fall_back_to_home() {
        let paths = XdgPaths::from_environment_values(
            Some(Path::new("/home/test")),
            Some(Path::new("relative")),
            None,
            None,
        )
        .unwrap();
        assert_eq!(paths.config_dir, Path::new("/home/test/.config/pulse"));
    }
}
