# Pulse

Pulse is a Fedora GNOME desktop companion for the official Spotify desktop
client. It puts a small, fast command center in the panel while leaving audio
playback in Spotify itself.

[![CI](https://github.com/KanterLabs/pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/KanterLabs/pulse/actions/workflows/ci.yml)

<p align="center">
  <img src="assets/pulse-hero.svg" alt="Pulse heartbeat waveform banner" width="1200">
</p>

> **Maturity:** pre-alpha. The repository is being built milestone by
> milestone and is not a packaged, supported daily-driver release yet. Expect
> breaking changes, incomplete features, and Fedora/GNOME compatibility work.

The banner and the companion [icon](assets/pulse-icon.svg) and
[symbolic mark](assets/pulse-symbolic.svg) are project identity artwork, not
screenshots of a finished UI.

## What Pulse is

Pulse is a native per-user application made of two cooperating pieces:

- a GNOME Shell extension for the panel indicator, popover, keyboard actions,
  and presentation; and
- a Rust daemon for the session-bus API, Spotify Web API access, local cache,
  secrets, and playback control through MPRIS.

The official Spotify application remains the playback engine. Pulse does not
decode, proxy, download, or cache audio, and it is not intended to replace the
Spotify client.

## Feature status

The product is intentionally being delivered in small, testable milestones.
The table describes the public target; a feature is not a release promise
until its acceptance criteria are met.

| Area | Target | Status in this pre-alpha tree |
| --- | --- | --- |
| Panel mini-player | Play/pause, next, previous, current playback, and Open in Spotify | In development |
| Local playback | MPRIS control of the official Spotify desktop client | In development |
| Account data | PKCE login, recently played, saved items, and the user's playlists | Planned after the local path |
| Search and queue | Debounced search, paginated views, and a read-only queue | Planned |
| Offline behavior | Cached snapshots with bounded artwork and stale-while-revalidate refresh | Planned |
| Installation | Copy one repository folder, then install per-user through the supplied scripts | In development |

For the complete implementation sequence and acceptance criteria, see the
[Fedora laptop implementation plan](docs/FEDORA_IMPLEMENTATION_PLAN.md).

## Architecture

```text
GNOME Shell process
  pulse@kanterlabs extension
    panel and popover UI; async D-Bus only
             |
             | io.kanterlabs.Pulse1 on the user session bus
             v
systemd --user
  pulse-daemon
    MPRIS + Spotify Web API + SQLite cache + Secret Service
```

The boundary is deliberately narrow: the extension must stay responsive and
must not perform HTTP, SQLite, synchronous file, or subprocess work. The
daemon owns network access, rate limiting, cache policy, OAuth refresh tokens,
and local playback integration. The identifiers are:

| Item | Value |
| --- | --- |
| Extension UUID | `pulse@kanterlabs` |
| Application/bus name | `io.kanterlabs.Pulse` |
| D-Bus interface | `io.kanterlabs.Pulse1` |
| D-Bus object path | `/io/kanterlabs/Pulse` |
| Daemon executable | `pulse-daemon` |

See [the architecture notes](docs/ARCHITECTURE.md) for lifecycle and failure
boundaries.

## Fedora prerequisites

Pulse targets Fedora Workstation with GNOME and a working user session. The
current extension metadata declares GNOME Shell 45 through 49; support for a
particular Fedora image still needs to be confirmed by the laptop
compatibility snapshot, and the extension does not promise every GNOME
version.

Install or verify these before building:

- Rust 1.88 or newer, Cargo, and the `rustfmt` and `clippy` components;
- GNOME Shell, GJS, `gnome-extensions`, a user `systemd`, and a session D-Bus;
- GNOME Keyring (Secret Service) for OAuth refresh-token storage;
- Bash and Python 3 for repository diagnostics; and
- the official Spotify desktop client, installed through Flatpak or RPM/native
  packaging, with MPRIS visible after Spotify starts.

The optional development checks also use `shellcheck`, Node.js, and
`glib-compile-schemas` when those tools are available. CI reports missing
optional extension validators instead of silently pretending that validation
ran.

The usual Fedora development tools can be installed with your normal package
manager, for example:

```bash
sudo dnf install cargo rustfmt clippy gjs gnome-shell python3 shellcheck \
  glib2-devel nodejs
```

Package names can differ between Fedora releases. If the doctor reports a
missing command, install the package that provides that command and run it
again.

## Copy, build, and install

The supported development-to-laptop flow copies or synchronizes the entire
repository folder. The scripts resolve the repository from their own location,
so the source path may change between the development VM and the Fedora
laptop.

```bash
# Replace this with the path where the repository was copied.
cd /path/to/pulse
./scripts/doctor-fedora.sh
./scripts/build.sh
./scripts/install-user.sh
```

The installer is per-user and refuses to run as root. It stages artifacts and
installs them under XDG locations, including:

```text
~/.local/bin/pulse-daemon
~/.local/share/gnome-shell/extensions/pulse@kanterlabs/
~/.local/share/dbus-1/services/io.kanterlabs.Pulse.service
~/.config/systemd/user/pulse-daemon.service
```

It reloads the user service manager and integration files, enables the daemon,
and enables the extension where supported. Existing configuration, database,
tokens, and artwork remain in place during an upgrade. If a script is absent
in a checkout from before its milestone lands, follow the implementation plan
and do not copy binaries or service files by hand.

After installation, useful checks are:

```bash
systemctl --user is-active pulse-daemon.service
busctl --user introspect io.kanterlabs.Pulse /io/kanterlabs/Pulse
gnome-extensions info pulse@kanterlabs
journalctl --user -u pulse-daemon.service --since today
```

For development synchronization, use `./scripts/dev-sync.sh` only when that
script is present and read its `--help` output first. To remove an install
without deleting user data, use `./scripts/uninstall-user.sh`. Data deletion
requires the explicit `./scripts/uninstall-user.sh --purge` option after
checking its target and preserving any backup; the default uninstall does not
remove the database, configuration, OAuth tokens, or artwork.

## Spotify Developer app and PKCE setup

Web API features require a Spotify Developer Dashboard application. This is a
personal Development Mode integration, not a production Spotify client. Check
Spotify's current [Development Mode limits](https://developer.spotify.com/documentation/web-api/concepts/quota-modes)
and [Developer Policy](https://developer.spotify.com/policy) before enabling
account features; those rules can change.

1. Create one application in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Add the exact loopback redirect URI shown by Pulse's configuration or login
   instructions. Pulse uses a literal `127.0.0.1` loopback address, for example
   `http://127.0.0.1:<dynamic-port>/callback`; do not substitute `localhost`.
3. Configure only the client ID in Pulse's user configuration. A client ID is
   not a secret. Do not add a client secret to the repository, a service file,
   the database, logs, shell history, or screenshots.
4. Start login from Pulse. It opens the system browser and uses Authorization
   Code with PKCE; the daemon keeps the refresh token in GNOME Keyring through
   Secret Service.

The initial read-only scopes are:

```text
user-read-playback-state
user-read-currently-playing
user-read-recently-played
user-library-read
playlist-read-private
playlist-read-collaborative
```

Local MPRIS control is preferred for the first mini-player milestone, so do
not request write or playback-modification scopes until a later feature needs
them. Pulse should always provide an Open in Spotify action and attribute
Spotify metadata/artwork with a link back to Spotify.

Read Spotify's primary documentation for the [PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow),
[redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri),
and [design and attribution requirements](https://developer.spotify.com/documentation/design)
when implementing or reviewing an API feature.

## Troubleshooting

Start with the non-destructive doctor and service logs:

```bash
./scripts/doctor-fedora.sh
systemctl --user status pulse-daemon.service
journalctl --user -u pulse-daemon.service --since today
journalctl --since today /usr/bin/gnome-shell
```

Common causes:

- **The panel indicator is missing:** verify the UUID with
  `gnome-extensions info pulse@kanterlabs`, confirm that your GNOME major
  version is supported, and log out/in if the shell did not reload the
  extension.
- **The daemon is inactive:** inspect `systemctl --user status` and the user
  journal. Run the doctor again to catch missing user-session commands or a
  wrong install path.
- **Spotify is not controllable:** start Spotify first, then verify that an
  MPRIS player appears with `busctl --user tree`; Flatpak and native Spotify
  builds can expose different player names.
- **Login returns to Pulse without an account:** verify the Dashboard redirect
  URI is an exact match, use the literal `127.0.0.1` address, ensure GNOME
  Keyring's Secret Service is running, and remove no tokens manually until the
  logs have been captured without credentials.
- **Cached content is stale:** offline cache is expected to remain visible;
  use `Refresh` after connectivity returns and inspect the daemon's rate-limit
  or quota message rather than repeatedly restarting it.

Do not paste access tokens, refresh tokens, client secrets, or full private
logs into an issue. For more detail, see
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Privacy and security

Pulse is designed for a local, per-user installation:

- No audio is sent through Pulse. Spotify remains responsible for playback.
- The daemon's network requests are limited to Spotify authentication and Web
  API endpoints needed by enabled features.
- Refresh tokens are kept in GNOME Keyring through Secret Service, never in
  `config.toml`, SQLite, source files, or logs. The client ID may be stored in
  user configuration.
- SQLite metadata and artwork are local XDG state. Logout clears
  Spotify-derived cached content according to the retention policy; settings
  are preserved.
- The GNOME Shell extension talks to the local daemon over the user session
  bus and does not make network requests.
- There is no telemetry service in the current architecture. Any proposal to
  add telemetry must document data minimization, opt-in behavior, retention,
  and threat-model impact.

Report suspected vulnerabilities privately as described in
[SECURITY.md](SECURITY.md); do not open a public issue with a live credential
or an exploit that exposes another user's data.

## Screenshots

Screenshots are pending the first working Fedora GNOME capture. No production
UI screenshot is available yet, so the architecture diagram above should not
be read as a visual preview of the finished extension.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development loop, validation
commands, review expectations, and security reporting guidance. The
[implementation plan](docs/FEDORA_IMPLEMENTATION_PLAN.md) records the product
boundaries and milestone acceptance criteria.

Pulse is licensed under the [MIT License](LICENSE).
