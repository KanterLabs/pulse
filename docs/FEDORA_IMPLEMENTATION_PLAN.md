# Pulse: Fedora Laptop Implementation Plan

> This document records the original MPRIS companion milestone. The optional
> independent backend is tracked in
> [INDEPENDENT_PLAYBACK_PLAN.md](INDEPENDENT_PLAYBACK_PLAN.md) and now
> supersedes its playback direction.

Status: implementation-ready plan  
Updated: 2026-09-03  
Target: Shane's Fedora Workstation laptop, with source copied from the mounted development VM

## Outcome

Pulse will be a per-user GNOME Shell companion for the official Spotify desktop client. It will start as two native components:

1. A small GNOME Shell extension for the panel indicator, popover, shortcuts, and presentation.
2. A Rust daemon for D-Bus, Spotify Web API access, caching, secrets, and local playback control through MPRIS.

The first usable milestone is deliberately smaller than the original handoff: install the folder on the Fedora laptop and get a reliable panel mini-player controlling the already-installed Spotify client. Browsing, search, and library features follow after that local path is proven.

Pulse does not decode, proxy, download, or cache audio. The Spotify application remains the playback mechanism.

## Decisions that replace or refine the original handoff

| Original direction | Fedora-ready decision |
| --- | --- |
| Flatpak-first distribution | Native per-user installation first. Revisit Flatpak only after D-Bus, Secret Service, and GNOME extension lifecycle behavior is proven. |
| GTK4/Adwaita-compatible extension UI | Use GJS with Shell Toolkit (`St`, `Clutter`, `PopupMenu`) inside GNOME Shell. Use GTK4/libadwaita only for the separate preferences process. |
| Generic playback bridge | Control the official Spotify desktop client through its MPRIS session-bus interface. Use Spotify Web API playback endpoints only as an optional fallback for remote devices. |
| Full client-style MVP | Position Pulse as a fast desktop command center/companion, not a replacement for Spotify's core application. Always provide an Open/Play in Spotify action. |
| Home screen | Compose Home from endpoints actually available to the account: recently played, saved items, and the user's playlists. Do not depend on Spotify editorial or recommendation endpoints. |
| Queue actions | Begin with a read-only queue plus Next/Previous. Add-to-queue is conditional on the current API and account; reordering/removing queue items is not an MVP promise. |
| Aggressive artwork treatment | Cache exact Spotify-provided images, preserve aspect ratio, do not crop, blur, animate, or overlay controls/text. Artwork and metadata link back to Spotify and include attribution. |
| Broad GNOME support | Detect the laptop's GNOME major version first, implement that version, then add only the adjacent Fedora-supported version if APIs differ. No legacy pre-45 code path. |

## Local architecture

```text
GNOME Shell process
  pulse@kanterlabs extension
    - St/Clutter panel and popover UI
    - keyboard interactions and optimistic state
    - async D-Bus proxy only; no HTTP or SQLite
             |
             | io.kanterlabs.Pulse1 on the session bus
             v
systemd --user
  pulse-daemon
    - MPRIS client for the official Spotify application
    - Spotify OAuth 2.0 Authorization Code with PKCE
    - Web API client, rate limiting, retries, and stale-while-revalidate
    - SQLite metadata cache and bounded artwork cache
    - Secret Service storage for refresh tokens
```

Identifiers:

- Extension UUID: `pulse@kanterlabs`
- Application ID and bus name: `io.kanterlabs.Pulse`
- D-Bus interface: `io.kanterlabs.Pulse1`
- D-Bus object path: `/io/kanterlabs/Pulse`
- Daemon executable: `pulse-daemon`

## Repository and transfer layout

Everything required to build or install the app will remain under one copied repository folder:

```text
pulse/
  Cargo.toml
  crates/
    pulse-daemon/
    pulse-core/
  extension/
    pulse@kanterlabs/
      extension.js
      metadata.json
      stylesheet.css
      prefs.js
      schemas/
  dbus/
    io.kanterlabs.Pulse1.xml
  packaging/
    systemd/pulse-daemon.service
    dbus/io.kanterlabs.Pulse.service
  scripts/
    doctor-fedora.sh
    build.sh
    install-user.sh
    uninstall-user.sh
    dev-sync.sh
  docs/
```

The laptop workflow will be:

```bash
# Copy or synchronize the whole pulse/ folder from the mounted VM.
cd /path/to/pulse
./scripts/doctor-fedora.sh
./scripts/build.sh
./scripts/install-user.sh
```

The scripts must not assume the VM and laptop have the same absolute path. They resolve the repository from the script location and install only to XDG per-user locations.

## Fedora per-user installation contract

The installer will place artifacts here:

```text
~/.local/bin/pulse-daemon
~/.local/share/gnome-shell/extensions/pulse@kanterlabs/
~/.local/share/dbus-1/services/io.kanterlabs.Pulse.service
~/.config/systemd/user/pulse-daemon.service
```

Runtime state will respect XDG locations:

```text
${XDG_CONFIG_HOME:-~/.config}/pulse/config.toml
${XDG_DATA_HOME:-~/.local/share}/pulse/pulse.sqlite3
${XDG_CACHE_HOME:-~/.cache}/pulse/artwork/
```

OAuth refresh tokens go to GNOME Keyring through the Secret Service API, never to `config.toml`, SQLite, logs, or source files. The client ID may be stored in config because it is not a secret. Pulse uses PKCE and a loopback literal redirect such as `http://127.0.0.1:<dynamic-port>/callback`; it must not use `localhost`.

The install script will:

1. Refuse to run as root.
2. Copy into staging paths and atomically rename completed artifacts.
3. reload the systemd user manager and D-Bus configuration as needed.
4. enable/start the daemon, leaving the extension disabled unless activation is explicitly requested; disable an existing extension before replacing its files.
5. leave existing config, database, tokens, and artwork intact on upgrades.
6. print exact rollback and diagnostic commands if validation fails.

The uninstall script will default to removing binaries and integration files only. Deleting user data requires a separate explicit flag.

## Laptop discovery gate

Before code targets a GNOME version, `doctor-fedora.sh` records only non-sensitive compatibility data:

```bash
cat /etc/fedora-release
gnome-shell --version
echo "$XDG_SESSION_TYPE"
gnome-extensions version
systemctl --user --version
busctl --user --version
command -v spotify
flatpak info com.spotify.Client
```

It should accept either the Flatpak or RPM/native Spotify client, verify that an MPRIS player appears after Spotify starts, and report missing build/runtime packages without installing anything automatically.

## D-Bus boundary

Keep the first interface intentionally small and versioned:

- Properties: `Status`, `Playback`, `ActiveView`, `Offline`, `LastRefresh`.
- Methods: `GetSnapshot`, `Refresh`, `Search`, `OpenUri`, `PlayPause`, `Next`, `Previous`, `Seek`, `BeginLogin`, `Logout`.
- Signals: `SnapshotChanged`, `PlaybackChanged`, `LoginStateChanged`, `ErrorChanged`.

Use typed, bounded payloads. Paginated views return a page token rather than sending an entire library through one D-Bus message. The extension cancels obsolete search requests and never polls rapidly; playback position may be interpolated locally between daemon updates.

Generate Rust bindings or validate hand-written bindings against the checked-in XML contract. Contract tests must start a private session bus, not depend on Shane's live desktop session.

## Data and cache rules

- SQLite migrations are additive, transactional, and tracked in source.
- Test every migration against a populated fixture and an immediately previous binary/schema combination.
- Before an upgrade migration, create and verify a timestamped local backup; never reset or silently restore the database.
- Store Spotify stable identifiers, source URLs, attribution/link targets, response ETags where available, fetch timestamps, and expiry timestamps.
- Return stale cached data immediately and refresh asynchronously.
- Treat `401`, ordinary rate limits, and `429` with `reason: QUOTA_EXCEEDED` as distinct states.
- Put hard limits on rows per view, concurrent requests, artwork bytes, and disk size.
- Clear Spotify-derived cached content on logout while preserving non-account settings; confirm policy-required retention behavior again before public distribution.

Artwork is content-addressed by the source URL plus relevant validators. The renderer preserves the complete image. Color extraction may inform a background, but the artwork itself is not blurred or transformed.

## Spotify capability gate

This is a personal, non-commercial Development Mode application. As of September 2026, plan around these constraints:

- The app owner needs Spotify Premium for Development Mode Web API use.
- Development Mode is intended for learning/personal projects and has a small authorized-user limit.
- Development Mode quota is shared at the developer-account level and `429` responses can distinguish quota exhaustion.
- Endpoint access can change. Each feature must probe or handle `403`/`404` rather than assuming every documented endpoint is enabled for the app.
- Spotify policy prohibits cloning/replacing its core experience. Pulse must remain a desktop companion that adds GNOME integration and fast local access.
- Spotify metadata/artwork requires attribution and a link back to Spotify.

Before enabling Web API features, create one Spotify Dashboard application and configure its exact loopback redirect. Do not commit credentials. Implement only these initial scopes:

```text
user-read-playback-state
user-read-currently-playing
user-read-recently-played
user-library-read
playlist-read-private
playlist-read-collaborative
```

Add write/control scopes only in the milestone that uses them, with a new consent prompt. Playback controls work through local MPRIS first, so API playback-modification scopes are not required for the first usable release.

## Implementation sequence

### Milestone 0: Laptop compatibility snapshot

- Add `doctor-fedora.sh` and document exact detected Fedora, GNOME, Wayland, Spotify package source, and MPRIS bus behavior.
- Select the extension's `shell-version` from evidence gathered on the laptop.
- Verify a copied repository can run scripts regardless of its mount path.

Acceptance: the doctor script exits nonzero for a real blocker, otherwise prints a concise ready report and the exact missing prerequisites.

### Milestone 1: Native panel mini-player

- Scaffold the Rust workspace and GJS extension.
- Implement the versioned D-Bus contract and user systemd activation.
- Discover the Spotify MPRIS player and expose playback state.
- Build the top-bar indicator and mini-player with Play/Pause, Next, Previous, and Open Spotify.
- Add build, install, update, diagnostics, and non-destructive uninstall scripts.

Acceptance: after copying the repo to the Fedora laptop and running three documented commands, Pulse survives logout/login, opens immediately, controls the official Spotify client, and shows a calm disconnected state when Spotify is closed.

### Milestone 2: Durable cache shell

- Add SQLite migrations, repository interfaces, populated migration fixtures, stale-while-revalidate, and bounded artwork storage.
- Render the last known playback snapshot before any network work.
- Add backup-before-migration and rollback compatibility tests.

Acceptance: the mini-player renders cached state while offline; upgrades preserve populated user data; cache limits are enforced.

### Milestone 3: OAuth and account data

- Add PKCE login through the system browser and a temporary loopback listener.
- Store refresh tokens in Secret Service.
- Add recently played, liked songs, and user's playlists using minimal scopes.
- Add attribution, full metadata access, and Open in Spotify links.

Acceptance: login/logout is reliable; no token appears in files or logs; revoked tokens degrade to a clear logged-out state; cached screens remain usable during API failures.

### Milestone 4: Search, playlist detail, and queue

- Add debounced/cancellable search and cached recent queries.
- Add virtualized/paginated playlist and liked-song views.
- Add read-only queue and supported, capability-gated actions.
- Distinguish offline, rate-limited, quota-exhausted, and permission-denied states.

Acceptance: typing and navigation do not block GNOME Shell; unsupported API actions are absent rather than broken; large libraries do not create all rows at once.

### Milestone 5: Polish and packaging decision

- Add preferences, keyboard navigation, media-key coexistence, accessibility labels, light/dark styling, and restrained motion.
- Measure cold/warm UI latency, daemon RSS, API request rate, and artwork disk usage on the laptop.
- Test the adjacent supported GNOME major version in a VM.
- Decide whether per-user tarball, RPM/COPR, extensions.gnome.org, or a hybrid package is appropriate. Evaluate Flatpak only here.

Acceptance: the measured performance contract is met or revised with recorded evidence; clean install, upgrade with populated data, rollback, and uninstall all pass.

## Validation commands expected in the finished repository

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
./scripts/build.sh
./scripts/install-user.sh
systemctl --user is-active pulse-daemon.service
busctl --user introspect io.kanterlabs.Pulse /io/kanterlabs/Pulse
gnome-extensions info pulse@kanterlabs
journalctl --user -u pulse-daemon.service --since today
journalctl --since today /usr/bin/gnome-shell
```

GNOME Shell behavior must also be tested in a nested Wayland session where supported. Do not use Shane's main desktop session as the only development loop.

If GitHub Actions is added before the repository receives an origin, assume `KanterLabs` ownership: use `runs-on: homelab` for lint/metadata/short tests and `runs-on: homelab-heavy` for Rust workspace builds and long integration tests.

## Performance targets

Measure from the Fedora laptop rather than assuming desktop-independent numbers:

- Panel popover shell visible from already-loaded extension: under 100 ms.
- Cached snapshot populated: under 50 ms after opening.
- Cached artwork populated: under 100 ms after opening.
- Cached search results: under 50 ms after debounce fires.
- No synchronous file, network, subprocess, or database work in the GNOME Shell process.
- Daemon startup and resident-memory budgets are set after Milestone 1 baseline measurements.

Spinners are allowed only for an explicitly user-requested uncached page. Existing content remains visible during refresh.

## Sources to re-check before implementation/public release

- GNOME Shell extension architecture and installation: https://gjs.guide/extensions/overview/anatomy.html
- GNOME Shell extension development/testing: https://gjs.guide/extensions/development/creating.html
- Spotify Authorization Code with PKCE: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
- Spotify redirect URI requirements: https://developer.spotify.com/documentation/web-api/concepts/redirect_uri
- Spotify Development Mode quota model: https://developer.spotify.com/documentation/web-api/concepts/quota-modes
- Spotify Developer Policy: https://developer.spotify.com/policy
- Spotify design and attribution rules: https://developer.spotify.com/documentation/design

These are design inputs, not permanent assumptions. Spotify and GNOME behavior must be revalidated against their current primary documentation when the relevant milestone starts.
