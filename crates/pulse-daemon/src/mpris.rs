//! Direct MPRIS integration with the locally running Spotify desktop client.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use crate::error::{PulseError, Result};
use crate::model::{PlaybackSnapshot, PlaybackStatus};
use zbus::Proxy;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

pub const MPRIS_ROOT_PATH: &str = "/org/mpris/MediaPlayer2";
pub const MPRIS_PLAYER_INTERFACE: &str = "org.mpris.MediaPlayer2.Player";
pub const MPRIS_ROOT_INTERFACE: &str = "org.mpris.MediaPlayer2";

/// A session-bus MPRIS client. The player name is rediscovered when Spotify starts or exits.
#[derive(Clone)]
pub struct MprisClient {
    connection: zbus::Connection,
    player_name: Arc<RwLock<Option<String>>>,
}

impl std::fmt::Debug for MprisClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MprisClient")
            .field("player_name", &self.player_name())
            .finish_non_exhaustive()
    }
}

impl MprisClient {
    pub async fn connect() -> Result<Self> {
        let connection = zbus::Connection::session().await?;
        Ok(Self::new(connection))
    }

    #[must_use]
    pub fn new(connection: zbus::Connection) -> Self {
        Self {
            connection,
            player_name: Arc::new(RwLock::new(None)),
        }
    }

    pub fn connection(&self) -> &zbus::Connection {
        &self.connection
    }

    #[must_use]
    pub fn player_name(&self) -> Option<String> {
        self.player_name.read().ok().and_then(|name| name.clone())
    }

    /// Return the running Spotify MPRIS name, if the official client owns one.
    pub async fn discover_player(&self) -> Result<Option<String>> {
        let dbus = zbus::fdo::DBusProxy::new(&self.connection).await?;
        let names = dbus.list_names().await?;
        for name in names {
            let name = name.to_string();
            if !name.starts_with("org.mpris.MediaPlayer2.") {
                continue;
            }
            if name.eq_ignore_ascii_case("org.mpris.MediaPlayer2.spotify")
                || name.to_ascii_lowercase().contains("spotify")
            {
                self.set_player_name(Some(name.clone()));
                return Ok(Some(name));
            }
        }
        self.set_player_name(None);
        Ok(None)
    }

    /// Read an MPRIS snapshot. A closed player is a normal disconnected state, not an error.
    pub async fn snapshot(&self) -> Result<PlaybackSnapshot> {
        let player_name = match self.player_name() {
            Some(name) => Some(name),
            None => self.discover_player().await?,
        };
        let Some(player_name) = player_name else {
            return Ok(PlaybackSnapshot::default());
        };
        let proxy = match self.player_proxy(&player_name).await {
            Ok(proxy) => proxy,
            Err(error) => {
                self.set_player_name(None);
                return Ok(PlaybackSnapshot::disconnected(Some(error.to_string())));
            }
        };

        let status = proxy
            .get_property::<String>("PlaybackStatus")
            .await
            .map_or(PlaybackStatus::Unknown, |value| {
                PlaybackStatus::from_mpris(&value)
            });
        let metadata = proxy
            .get_property::<HashMap<String, OwnedValue>>("Metadata")
            .await
            .unwrap_or_default();
        let mut snapshot = PlaybackSnapshot {
            status,
            title: metadata_string(&metadata, "xesam:title"),
            artist: metadata_artist(&metadata),
            album: metadata_string(&metadata, "xesam:album"),
            art_url: metadata_string(&metadata, "mpris:artUrl"),
            spotify_url: metadata_string(&metadata, "xesam:url"),
            length_us: metadata_i64(&metadata, "mpris:length"),
            position_us: proxy.get_property::<i64>("Position").await.ok(),
            playing: status.is_playing(),
            can_control: property_bool(&proxy, "CanControl").await,
            can_go_next: property_bool(&proxy, "CanGoNext").await,
            can_go_previous: property_bool(&proxy, "CanGoPrevious").await,
            can_seek: property_bool(&proxy, "CanSeek").await,
            offline: false,
            error: None,
        };
        snapshot.normalize();
        Ok(snapshot)
    }

    pub async fn play_pause(&self) -> Result<()> {
        self.call_player_method("PlayPause").await
    }

    pub async fn next(&self) -> Result<()> {
        self.call_player_method("Next").await
    }

    pub async fn previous(&self) -> Result<()> {
        self.call_player_method("Previous").await
    }

    pub async fn seek(&self, position_us: i64) -> Result<()> {
        if position_us < 0 {
            return Err(PulseError::InvalidInput(
                "seek position cannot be negative".into(),
            ));
        }
        let player_name = self.require_player().await?;
        let proxy = self.player_proxy(&player_name).await?;
        proxy
            .call::<_, _, ()>("SetPosition", &(track_id(&proxy).await, position_us))
            .await?;
        Ok(())
    }

    pub async fn open_uri(&self, uri: &str) -> Result<()> {
        let parsed = url::Url::parse(uri)
            .map_err(|error| PulseError::InvalidInput(format!("invalid URI: {error}")))?;
        if parsed.scheme() != "spotify" {
            return Err(PulseError::InvalidInput(
                "MPRIS URI routing only accepts spotify URIs".into(),
            ));
        }
        let player_name = self.require_player().await?;
        let proxy = Proxy::new_owned(
            self.connection.clone(),
            player_name,
            MPRIS_ROOT_PATH.to_owned(),
            MPRIS_ROOT_INTERFACE.to_owned(),
        )
        .await?;
        proxy.call::<_, _, ()>("OpenUri", &(uri,)).await?;
        Ok(())
    }

    async fn call_player_method(&self, method: &str) -> Result<()> {
        let player_name = self.require_player().await?;
        let proxy = self.player_proxy(&player_name).await?;
        proxy.call::<_, _, ()>(method, &()).await?;
        Ok(())
    }

    async fn require_player(&self) -> Result<String> {
        if let Some(name) = self.player_name() {
            return Ok(name);
        }
        self.discover_player()
            .await?
            .ok_or_else(|| PulseError::NotFound("Spotify MPRIS player is not running".into()))
    }

    async fn player_proxy(&self, name: &str) -> Result<Proxy<'static>> {
        Ok(Proxy::new_owned(
            self.connection.clone(),
            name.to_owned(),
            MPRIS_ROOT_PATH.to_owned(),
            MPRIS_PLAYER_INTERFACE.to_owned(),
        )
        .await?)
    }

    fn set_player_name(&self, name: Option<String>) {
        if let Ok(mut current) = self.player_name.write() {
            *current = name;
        }
    }
}

async fn property_bool(proxy: &Proxy<'_>, property: &str) -> bool {
    proxy.get_property::<bool>(property).await.unwrap_or(false)
}

async fn track_id(proxy: &Proxy<'_>) -> OwnedObjectPath {
    proxy
        .get_property::<HashMap<String, OwnedValue>>("Metadata")
        .await
        .ok()
        .and_then(|mut metadata| metadata.remove("mpris:trackid"))
        .and_then(|value| OwnedObjectPath::try_from(value).ok())
        .unwrap_or_else(|| {
            OwnedObjectPath::try_from("/org/mpris/MediaPlayer2/TrackList/NoTrack")
                .expect("valid object path")
        })
}

fn metadata_string(metadata: &HashMap<String, OwnedValue>, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(|value| String::try_from(value.clone()).ok())
}

fn metadata_artist(metadata: &HashMap<String, OwnedValue>) -> Option<String> {
    metadata_string(metadata, "xesam:artist").or_else(|| {
        metadata
            .get("xesam:artist")
            .and_then(|value| Vec::<String>::try_from(value.clone()).ok())
            .and_then(|artists| artists.into_iter().next())
    })
}

fn metadata_i64(metadata: &HashMap<String, OwnedValue>, key: &str) -> Option<i64> {
    metadata
        .get(key)
        .and_then(|value| i64::try_from(value).ok())
}

#[cfg(test)]
mod tests {
    use super::{metadata_artist, metadata_i64, metadata_string};
    use std::collections::HashMap;
    use zbus::zvariant::OwnedValue;

    #[test]
    fn metadata_helpers_tolerate_missing_or_malformed_values() {
        let mut metadata = HashMap::new();
        metadata.insert(
            "xesam:title".into(),
            OwnedValue::from(zbus::zvariant::Str::from("Title")),
        );
        metadata.insert("mpris:length".into(), OwnedValue::from(123_i64));
        assert_eq!(
            metadata_string(&metadata, "xesam:title"),
            Some("Title".into())
        );
        assert_eq!(metadata_i64(&metadata, "mpris:length"), Some(123));
        assert_eq!(metadata_artist(&metadata), None);
    }
}
