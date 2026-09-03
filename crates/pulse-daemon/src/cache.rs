//! Additive SQLite cache and bounded artwork storage.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::error::{PulseError, Result};
use crate::model::PlaybackSnapshot;

pub const CURRENT_SCHEMA_VERSION: i32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheLimits {
    pub max_api_rows: usize,
    pub max_payload_bytes: usize,
    pub max_artwork_bytes: usize,
    pub max_artwork_disk_bytes: u64,
}

impl Default for CacheLimits {
    fn default() -> Self {
        Self {
            max_api_rows: 100,
            max_payload_bytes: 4 * 1024 * 1024,
            max_artwork_bytes: 8 * 1024 * 1024,
            max_artwork_disk_bytes: 128 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    pub from_version: i32,
    pub to_version: i32,
    pub backup_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedSnapshot {
    pub snapshot: PlaybackSnapshot,
    pub fetched_at: i64,
    pub expires_at: i64,
}

impl CachedSnapshot {
    #[must_use]
    pub const fn is_stale_at(&self, now: i64) -> bool {
        self.expires_at <= now
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedResponse {
    pub key: String,
    pub source_url: String,
    pub payload: Vec<u8>,
    pub etag: Option<String>,
    pub fetched_at: i64,
    pub expires_at: i64,
}

impl CachedResponse {
    #[must_use]
    pub const fn is_stale_at(&self, now: i64) -> bool {
        self.expires_at <= now
    }
}

#[derive(Debug)]
pub struct CacheRepository {
    connection: Mutex<Connection>,
    limits: CacheLimits,
    migration: MigrationReport,
}

impl CacheRepository {
    /// Open or create the cache, applying only additive migrations.
    pub fn open(path: impl AsRef<Path>, limits: CacheLimits) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let existing_version = if path.exists() {
            let connection = Connection::open(path)?;
            let version = schema_version(&connection)?;
            drop(connection);
            Some(version)
        } else {
            None
        };
        let from_version = existing_version.unwrap_or(0);
        if from_version > CURRENT_SCHEMA_VERSION {
            return Err(PulseError::CacheUnavailable(format!(
                "database schema {from_version} is newer than supported schema {CURRENT_SCHEMA_VERSION}"
            )));
        }
        let backup_path = if existing_version.is_some() && from_version < CURRENT_SCHEMA_VERSION {
            Some(create_backup(path)?)
        } else {
            None
        };
        let mut connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 2500;
             PRAGMA journal_mode = WAL;",
        )?;
        apply_migrations(&mut connection, from_version)?;
        let to_version = schema_version(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            limits,
            migration: MigrationReport {
                from_version,
                to_version,
                backup_path,
            },
        })
    }

    #[must_use]
    pub fn migration_report(&self) -> &MigrationReport {
        &self.migration
    }

    #[must_use]
    pub fn limits(&self) -> CacheLimits {
        self.limits
    }

    pub fn save_snapshot(
        &self,
        snapshot: &PlaybackSnapshot,
        fetched_at: i64,
        expires_at: i64,
    ) -> Result<()> {
        let payload = snapshot.to_json();
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO playback_snapshots (id, payload, fetched_at, expires_at)
                 VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload,
                   fetched_at = excluded.fetched_at, expires_at = excluded.expires_at",
                params![payload, fetched_at, expires_at],
            )?;
            Ok(())
        })
    }

    pub fn load_snapshot(&self) -> Result<Option<CachedSnapshot>> {
        self.with_connection(|connection| {
            let value = connection
                .query_row(
                    "SELECT payload, fetched_at, expires_at FROM playback_snapshots WHERE id = 1",
                    [],
                    |row| {
                        let payload: String = row.get(0)?;
                        let snapshot = serde_json::from_str::<PlaybackSnapshot>(&payload).map_err(
                            |error| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    0,
                                    rusqlite::types::Type::Text,
                                    Box::new(error),
                                )
                            },
                        )?;
                        Ok(CachedSnapshot {
                            snapshot,
                            fetched_at: row.get(1)?,
                            expires_at: row.get(2)?,
                        })
                    },
                )
                .optional()?;
            Ok(value)
        })
    }

    pub fn put_response(&self, response: &CachedResponse) -> Result<()> {
        if response.payload.len() > self.limits.max_payload_bytes {
            return Err(PulseError::PayloadTooLarge {
                size: response.payload.len(),
                limit: self.limits.max_payload_bytes,
            });
        }
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO api_cache
                   (cache_key, source_url, payload, etag, fetched_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(cache_key) DO UPDATE SET source_url = excluded.source_url,
                   payload = excluded.payload, etag = excluded.etag,
                   fetched_at = excluded.fetched_at, expires_at = excluded.expires_at",
                params![
                    response.key,
                    response.source_url,
                    response.payload,
                    response.etag,
                    response.fetched_at,
                    response.expires_at
                ],
            )?;
            trim_api_cache(connection, self.limits.max_api_rows)?;
            Ok(())
        })
    }

    pub fn get_response(&self, key: &str) -> Result<Option<CachedResponse>> {
        self.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT cache_key, source_url, payload, etag, fetched_at, expires_at
                     FROM api_cache WHERE cache_key = ?1",
                    params![key],
                    |row| {
                        Ok(CachedResponse {
                            key: row.get(0)?,
                            source_url: row.get(1)?,
                            payload: row.get(2)?,
                            etag: row.get(3)?,
                            fetched_at: row.get(4)?,
                            expires_at: row.get(5)?,
                        })
                    },
                )
                .optional()
        })
    }

    pub fn prune_expired(&self, before: i64) -> Result<usize> {
        self.with_connection(|connection| {
            connection.execute(
                "DELETE FROM api_cache WHERE expires_at < ?1",
                params![before],
            )
        })
    }

    /// Remove all Spotify-derived content while leaving the schema and local settings intact.
    pub fn clear_spotify_cache(&self) -> Result<()> {
        self.with_connection(|connection| {
            connection.execute_batch("DELETE FROM api_cache; DELETE FROM playback_snapshots;")?;
            Ok(())
        })
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| PulseError::CacheUnavailable("cache lock poisoned".into()))?;
        operation(&mut connection).map_err(Into::into)
    }
}

fn schema_version(connection: &Connection) -> rusqlite::Result<i32> {
    connection.pragma_query_value(None, "user_version", |row| row.get(0))
}

fn apply_migrations(connection: &mut Connection, from_version: i32) -> Result<()> {
    let transaction = connection.transaction()?;
    if from_version < 1 {
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS playback_snapshots (
                 id INTEGER PRIMARY KEY CHECK (id = 1),
                 payload TEXT NOT NULL,
                 fetched_at INTEGER NOT NULL,
                 expires_at INTEGER NOT NULL
             );
             PRAGMA user_version = 1;",
        )?;
    }
    if from_version < 2 {
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS api_cache (
                 cache_key TEXT PRIMARY KEY NOT NULL,
                 source_url TEXT NOT NULL,
                 payload BLOB NOT NULL,
                 etag TEXT,
                 fetched_at INTEGER NOT NULL,
                 expires_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS api_cache_expiry_idx ON api_cache (expires_at);
             PRAGMA user_version = 2;",
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn create_backup(path: &Path) -> Result<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| PulseError::CacheUnavailable(error.to_string()))?;
    let backup_path = PathBuf::from(format!(
        "{}.bak-{}-{}",
        path.display(),
        timestamp.as_secs(),
        timestamp.subsec_nanos()
    ));
    // SQLite's online backup API copies the consistent database snapshot, including committed
    // pages still living in a WAL file. Copying only `path` would silently omit those pages.
    let source = Connection::open(path)?;
    source.backup(rusqlite::DatabaseName::Main, &backup_path, None)?;
    Ok(backup_path)
}

fn trim_api_cache(connection: &Connection, max_rows: usize) -> rusqlite::Result<()> {
    let max_rows = i64::try_from(max_rows).unwrap_or(i64::MAX);
    connection.execute(
        "DELETE FROM api_cache WHERE cache_key NOT IN
           (SELECT cache_key FROM api_cache ORDER BY fetched_at DESC LIMIT ?1)",
        params![max_rows],
    )?;
    Ok(())
}

/// Return seconds since the Unix epoch for timestamps stored in the cache.
#[must_use]
pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or(i64::MAX)
}

#[derive(Debug, Clone)]
pub struct ArtworkCache {
    root: PathBuf,
    max_file_bytes: usize,
    max_disk_bytes: u64,
}

impl ArtworkCache {
    pub fn new(
        root: impl Into<PathBuf>,
        max_file_bytes: usize,
        max_disk_bytes: u64,
    ) -> Result<Self> {
        let root = root.into();
        std::fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            max_file_bytes,
            max_disk_bytes,
        })
    }

    #[must_use]
    pub fn path_for(&self, source_url: &str) -> PathBuf {
        let mut hasher = Sha256::new();
        hasher.update(source_url.as_bytes());
        let digest = hasher.finalize();
        self.root.join(format!("{digest:x}.img"))
    }

    pub fn get(&self, source_url: &str) -> Result<Option<Vec<u8>>> {
        let path = self.path_for(source_url);
        if !path.exists() {
            return Ok(None);
        }
        let metadata = std::fs::metadata(&path)?;
        if metadata.len() > self.max_file_bytes as u64 {
            std::fs::remove_file(path)?;
            return Ok(None);
        }
        Ok(Some(std::fs::read(path)?))
    }

    pub fn put(&self, source_url: &str, bytes: &[u8]) -> Result<PathBuf> {
        if bytes.len() > self.max_file_bytes {
            return Err(PulseError::PayloadTooLarge {
                size: bytes.len(),
                limit: self.max_file_bytes,
            });
        }
        std::fs::create_dir_all(&self.root)?;
        let destination = self.path_for(source_url);
        let temporary = destination.with_extension("tmp");
        std::fs::write(&temporary, bytes)?;
        std::fs::rename(&temporary, &destination)?;
        self.prune_disk()?;
        Ok(destination)
    }

    fn prune_disk(&self) -> Result<()> {
        let mut entries = Vec::new();
        let mut total = 0_u64;
        for entry in std::fs::read_dir(&self.root)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if !metadata.is_file() {
                continue;
            }
            total = total.saturating_add(metadata.len());
            entries.push((entry.path(), metadata.modified().ok(), metadata.len()));
        }
        entries.sort_by_key(|(_, modified, _)| *modified);
        for (path, _, size) in entries {
            if total <= self.max_disk_bytes {
                break;
            }
            std::fs::remove_file(path)?;
            total = total.saturating_sub(size);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{ArtworkCache, CURRENT_SCHEMA_VERSION, CacheLimits, CacheRepository, unix_now};
    use crate::model::PlaybackSnapshot;
    use rusqlite::Connection;
    use tempfile::tempdir;

    #[test]
    fn creates_schema_and_round_trips_snapshot_and_response() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("pulse.sqlite3");
        let repository = CacheRepository::open(&path, CacheLimits::default()).unwrap();
        assert_eq!(
            repository.migration_report().to_version,
            CURRENT_SCHEMA_VERSION
        );
        let snapshot = PlaybackSnapshot::default();
        repository.save_snapshot(&snapshot, 1, 2).unwrap();
        assert_eq!(
            repository.load_snapshot().unwrap().unwrap().snapshot,
            snapshot
        );
        let response = super::CachedResponse {
            key: "recent".into(),
            source_url: "https://api.spotify.com/v1/me/player".into(),
            payload: b"{}".to_vec(),
            etag: Some("etag".into()),
            fetched_at: 1,
            expires_at: 2,
        };
        repository.put_response(&response).unwrap();
        assert_eq!(repository.get_response("recent").unwrap(), Some(response));
    }

    #[test]
    fn migration_makes_backup_before_upgrading() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("old.sqlite3");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 CREATE TABLE playback_snapshots (id INTEGER PRIMARY KEY, payload TEXT NOT NULL,
                 fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
                 INSERT INTO playback_snapshots VALUES (1, '{\"status\":\"disconnected\"}', 1, 2);
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        let repository = CacheRepository::open(&path, CacheLimits::default()).unwrap();
        let backup = repository.migration_report().backup_path.as_ref().unwrap();
        assert!(backup.exists());
        let backup_connection = Connection::open(backup).unwrap();
        let payload: String = backup_connection
            .query_row(
                "SELECT payload FROM playback_snapshots WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(payload.contains("disconnected"));
        assert_eq!(repository.migration_report().from_version, 1);
        assert_eq!(repository.migration_report().to_version, 2);
    }

    #[test]
    fn artwork_cache_enforces_file_limit_and_hashes_urls() {
        let directory = tempdir().unwrap();
        let artwork = ArtworkCache::new(directory.path(), 4, 7).unwrap();
        assert_ne!(artwork.path_for("a"), artwork.path_for("b"));
        artwork.put("a", b"1234").unwrap();
        assert_eq!(artwork.get("a").unwrap(), Some(b"1234".to_vec()));
        assert!(artwork.put("b", b"12345").is_err());
        artwork.put("b", b"5678").unwrap();
        assert!(artwork.get("a").unwrap().is_none());
    }

    #[test]
    fn unix_now_is_nonzero_on_normal_systems() {
        assert!(unix_now() > 0);
    }
}
