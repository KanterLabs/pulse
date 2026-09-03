//! Typed playback and health models shared by MPRIS, cache, and D-Bus.

use serde::{Deserialize, Serialize};

/// Playback state as defined by the MPRIS `PlaybackStatus` property.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PlaybackStatus {
    Playing,
    Paused,
    Stopped,
    Disconnected,
    #[default]
    Unknown,
}

impl PlaybackStatus {
    #[must_use]
    pub fn from_mpris(value: &str) -> Self {
        match value {
            "Playing" => Self::Playing,
            "Paused" => Self::Paused,
            "Stopped" => Self::Stopped,
            _ => Self::Unknown,
        }
    }

    #[must_use]
    pub const fn is_playing(self) -> bool {
        matches!(self, Self::Playing)
    }
}

/// The smallest stable payload sent over D-Bus to the GNOME extension.
///
/// Fields intentionally remain optional where players may omit metadata. The structure is
/// serialized as JSON for forwards-compatible D-Bus evolution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaybackSnapshot {
    pub status: PlaybackStatus,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub art_url: Option<String>,
    pub spotify_url: Option<String>,
    pub length_us: Option<i64>,
    pub position_us: Option<i64>,
    pub playing: bool,
    pub can_control: bool,
    pub can_go_next: bool,
    pub can_go_previous: bool,
    pub can_seek: bool,
    pub offline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for PlaybackSnapshot {
    fn default() -> Self {
        Self::disconnected(None::<String>)
    }
}

impl PlaybackSnapshot {
    #[must_use]
    pub fn disconnected(error: Option<impl Into<String>>) -> Self {
        Self {
            status: PlaybackStatus::Disconnected,
            title: None,
            artist: None,
            album: None,
            art_url: None,
            spotify_url: None,
            length_us: None,
            position_us: None,
            playing: false,
            can_control: false,
            can_go_next: false,
            can_go_previous: false,
            can_seek: false,
            offline: true,
            error: error.map(Into::into),
        }
    }

    /// Normalize fields that are derivable from `status` and clamp malformed media positions.
    pub fn normalize(&mut self) {
        self.playing = self.status.is_playing();
        if let Some(length) = self.length_us {
            self.length_us = Some(length.max(0));
        }
        if let Some(position) = self.position_us {
            self.position_us = Some(position.max(0));
        }
        if let (Some(position), Some(length)) = (self.position_us, self.length_us) {
            self.position_us = Some(position.min(length));
        }
    }

    #[must_use]
    pub fn to_json(&self) -> String {
        // All fields in this type are serializable, so this cannot fail in practice. Returning a
        // valid fallback keeps D-Bus methods total even if a future field gets a custom serializer.
        serde_json::to_string(self).unwrap_or_else(|_| "{\"status\":\"unknown\"}".to_owned())
    }
}

/// Coarse daemon health state exposed as a D-Bus property and method payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    Ready,
    Degraded,
    Offline,
    #[default]
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthSnapshot {
    pub status: HealthStatus,
    pub mpris_available: bool,
    pub spotify_authenticated: bool,
    pub offline: bool,
    pub last_refresh: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for HealthSnapshot {
    fn default() -> Self {
        Self {
            status: HealthStatus::Disconnected,
            mpris_available: false,
            spotify_authenticated: false,
            offline: true,
            last_refresh: None,
            error: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PlaybackSnapshot, PlaybackStatus};

    #[test]
    fn snapshot_json_contains_extension_contract_fields() {
        let snapshot = PlaybackSnapshot {
            status: PlaybackStatus::Playing,
            title: Some("Song".into()),
            artist: Some("Artist".into()),
            album: Some("Album".into()),
            art_url: Some("https://i.scdn.co/image/x".into()),
            spotify_url: Some("spotify:track:x".into()),
            length_us: Some(100),
            position_us: Some(5),
            playing: true,
            can_control: true,
            can_go_next: true,
            can_go_previous: true,
            can_seek: true,
            offline: false,
            error: None,
        };
        let value: serde_json::Value = serde_json::from_str(&snapshot.to_json()).unwrap();
        for field in [
            "status",
            "title",
            "artist",
            "album",
            "art_url",
            "spotify_url",
            "length_us",
            "position_us",
            "playing",
            "can_control",
            "can_go_next",
            "can_go_previous",
            "can_seek",
            "offline",
        ] {
            assert!(value.get(field).is_some(), "missing field {field}");
        }
    }

    #[test]
    fn normalize_clamps_position_and_derives_playing() {
        let mut snapshot = PlaybackSnapshot {
            status: PlaybackStatus::Paused,
            position_us: Some(200),
            length_us: Some(100),
            ..PlaybackSnapshot::default()
        };
        snapshot.normalize();
        assert!(!snapshot.playing);
        assert_eq!(snapshot.position_us, Some(100));
    }
}
