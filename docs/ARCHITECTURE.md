# Pulse architecture

This note describes the intended public architecture. Pulse is pre-alpha, so
the implementation may expose only a subset of this boundary until the
corresponding milestone is complete. The authoritative delivery sequence is
the [Fedora laptop implementation plan](FEDORA_IMPLEMENTATION_PLAN.md).

## Process boundary

Pulse has one UI process, one daemon, and an optional isolated player service:

```text
GNOME Shell
└── pulse@kanterlabs
    └── async D-Bus proxy
             │  io.kanterlabs.Pulse1
             ▼
systemd --user
├── pulse-daemon
│   ├── MPRIS client or bounded browser-player bridge
│   ├── Web API client, rate limiting, retry, and stale-while-revalidate
│   └── SQLite metadata cache and bounded artwork cache
└── pulse-player (independent playback option)
    ├── loopback PKCE and restricted daemon bridge
    ├── headless Google Chrome + Spotify Web Playback SDK
    └── Secret Service storage for refresh tokens
```

The extension owns presentation, pointer/keyboard interaction, and local
optimistic playback state. It must not perform HTTP, SQLite, synchronous file,
or subprocess work. The daemon owns all network access and long-lived state so
the shell remains responsive and a cached snapshot can be shown while offline.

## Stable identifiers

| Resource | Identifier |
| --- | --- |
| Extension UUID | `pulse@kanterlabs` |
| Application and bus name | `io.kanterlabs.Pulse` |
| D-Bus interface | `io.kanterlabs.Pulse1` |
| Object path | `/io.kanterlabs/Pulse` |
| Executable | `pulse-daemon` |

The D-Bus contract is versioned and intentionally small. The initial shape is
properties for status/playback/view/offline/last refresh; methods for snapshot,
refresh, search, open URI, playback controls, login, and logout; and signals
for snapshot, playback, login, and error changes. Payloads must be typed and
bounded. Large views are paginated with a page token instead of being sent in
one D-Bus message.

## Data ownership and locations

The installer places executable and integration artifacts in per-user XDG
locations. Runtime data follows the user's XDG configuration, data, and cache
directories:

```text
${XDG_CONFIG_HOME:-~/.config}/pulse/config.toml
${XDG_DATA_HOME:-~/.local/share}/pulse/pulse.sqlite3
${XDG_CACHE_HOME:-~/.cache}/pulse/artwork/
```

The config may contain the Spotify client ID but not a client secret or
refresh token. Refresh tokens belong in GNOME Keyring through the Secret
Service API. Logs must redact credentials. SQLite migrations are additive and
transactional; upgrades must preserve populated user data and create a
verified backup before a migration.

## Playback and API policy

Pulse selects one playback backend at daemon startup. The original backend
controls the official Spotify client through MPRIS. The independent backend
sends bounded commands through a private loopback descriptor to a separately
supervised headless Chrome player. The daemon re-reads and validates that
descriptor on every request, and player loss becomes an offline snapshot rather
than a GNOME Shell failure. Spotify API access remains capability-gated.

Pulse does not decode, proxy, download, or cache audio. Spotify metadata and
artwork should retain attribution and a link back to Spotify, preserve the
complete source image, and avoid destructive cropping or overlays.

## Lifecycle

1. `systemd --user` starts `pulse-daemon` from the installed per-user path.
2. The daemon connects to the session bus and serves the versioned interface.
   It either discovers Spotify through MPRIS or connects to the independent
   player service through its private runtime descriptor.
3. The extension connects asynchronously and renders a calm disconnected state
   when the daemon or Spotify is unavailable.
4. User actions become bounded D-Bus requests. Obsolete search requests are
   cancelled and playback position may be interpolated locally between daemon
   updates.
5. Login opens the system browser for PKCE and uses a temporary literal
   `127.0.0.1` loopback callback. The callback listener is short-lived.
6. Logout removes Spotify-derived cached content and revokes local access
   according to the current retention policy while preserving non-account
   settings.

The installer and uninstaller must be safe to rerun. Upgrades leave config,
database, tokens, and artwork intact; default uninstall removes binaries and
integration files only. Explicit data deletion is a separate operation.

## Failure states

The daemon and extension should expose distinct user-visible states for:

- Spotify closed/no MPRIS player, or independent player offline;
- daemon unavailable or disconnected;
- offline with stale cached data;
- ordinary API rate limiting;
- Development Mode quota exhaustion;
- expired or revoked authorization; and
- endpoint permission or capability failures (`403`/`404`).

Existing cached content should remain visible during refresh. Spinners are for
explicitly requested uncached pages only. Rapid polling and synchronous work in
GNOME Shell are correctness and performance bugs, not acceptable fallbacks.
