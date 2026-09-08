# Troubleshooting Pulse

Run diagnostics from the copied repository folder. The commands below are
read-only unless noted.

## First checks

```bash
./scripts/doctor-fedora.sh
systemctl --user status pulse-daemon.service
systemctl --user is-active pulse-daemon.service
busctl --user introspect io.kanterlabs.Pulse /io.kanterlabs/Pulse
gnome-extensions info pulse@kanterlabs
```

Collect service logs without exposing them publicly:

```bash
journalctl --user -u pulse-daemon.service --since today
journalctl --since today /usr/bin/gnome-shell
```

Before sharing logs, remove access tokens, refresh tokens, authorization
codes, client secrets, private paths, and unrelated desktop information.

## Installation and service failures

The expected install is per-user. The installer refuses root and should not
need `sudo`. If a service is missing, verify that the repository was copied in
full and that `./scripts/build.sh` and `./scripts/install-user.sh` completed.
Check the user unit and binary paths printed by the installer, then reload the
user manager only if the script did not already do so:

```bash
systemctl --user daemon-reload
systemctl --user restart pulse-daemon.service
systemctl --user status pulse-daemon.service
```

Do not delete the database or configuration as a first troubleshooting step.
The default uninstall is non-destructive; use the explicit `--purge` data
removal option only after preserving a backup and confirming every target.

### Safe extension upgrades and recovery

The installer leaves the GNOME extension disabled by default while Pulse is
pre-alpha. Every install or upgrade that includes extension files first runs:

```bash
gnome-extensions disable pulse@kanterlabs
```

If that command is unavailable or fails while an old extension directory is
present, the installer stops before replacing any installed file. The old
tree, daemon, and integration files remain unchanged, and it does not use a
GSettings fallback for that existing tree. From a working GNOME session,
disable the UUID manually and retry. When the destination is absent, a stale
enabled UUID can be removed through `gsettings`; the installer verifies that
Pulse's UUID is gone and stops before writing files if it cannot confirm this.
Pulse runtime data remains untouched in either case.

If GNOME is unavailable after the extension was explicitly enabled, use a text
console for this explicit filesystem recovery command. The installer does not
quarantine an existing extension automatically:

```bash
data_home=${XDG_DATA_HOME:-$HOME/.local/share}
extension_dir="$data_home/gnome-shell/extensions/pulse@kanterlabs"
quarantine_parent="$data_home/pulse-extension-quarantine"
mkdir -p -- "$quarantine_parent"
quarantine_dir=$(mktemp -d "$quarantine_parent/pulse@kanterlabs.XXXXXX")
mv -- "$extension_dir" "$quarantine_dir/"
printf 'quarantined extension: %s\n' "$quarantine_dir/pulse@kanterlabs"
```

This moves only the extension tree and does not remove the config, database,
tokens, artwork, or cache under Pulse's normal runtime directories. Log out/in
when possible, then rerun `./scripts/install-user.sh` from a working session.
If the extension was already enabled and GNOME is unstable, keep it disabled
and omit `--enable-extension` until the compatibility check is complete. This
recovery procedure does not by itself establish the cause of a reboot or other
laptop failure.

After a successful install, the daemon is enabled and started by default, but
the extension remains disabled until activation is requested explicitly:

```bash
./scripts/install-user.sh --enable-extension
```

For a staged install with no service activation, use `--no-start`; it cannot
be combined with `--enable-extension`. To activate an already installed
extension later, check compatibility first and then run:

```bash
gnome-extensions enable pulse@kanterlabs
```

The installer reloads the user systemd manager and session D-Bus activation
configuration. If a service or D-Bus change is not visible, run
`systemctl --user daemon-reload`, restart the daemon, and log out/in when the
GNOME Shell session does not support a safe extension reload. Runtime files
under the configured Pulse config, data, and cache directories are preserved
through installs, upgrades, and the default uninstall. Do not use
`--purge` while recovering unless data deletion is explicitly intended.

## GNOME extension is not visible

Check the UUID and GNOME version:

```bash
gnome-extensions version
gnome-shell --version
gnome-extensions info pulse@kanterlabs
```

The current extension metadata declares GNOME Shell 45 through 49; the Fedora
laptop discovery gate still decides which version is exercised. A fresh or
upgraded install intentionally leaves the extension disabled. Enable it only
after checking the version:

```bash
gnome-extensions enable pulse@kanterlabs
```

If the extension was installed while Shell was running, log out and back in
when the current session does not support a safe Shell reload. A disabled
extension or an unsupported `shell-version` is a compatibility issue, not a
Spotify login issue. If enabling it makes GNOME unstable, disable it again and
retry the installer without `--enable-extension`; installed runtime data is
not removed by that recovery path.

## Spotify and MPRIS

Start Spotify before testing local playback. Inspect the user session bus:

```bash
busctl --user tree
busctl --user list | grep -i spotify
```

Flatpak and native Spotify packages may use different MPRIS names. Pulse must
discover the available player rather than depending on one hard-coded package
path. If no player appears, verify Spotify itself can play and that the current
desktop session exposes a session bus.

## OAuth and PKCE

The redirect URI in the Spotify Dashboard must exactly match the one configured
for Pulse. Use the literal loopback address `127.0.0.1`; do not replace it with
`localhost` or add a trailing slash that is not configured. The client ID may
be in user configuration, but the refresh token belongs in GNOME Keyring via
Secret Service.

If login returns without an account, verify the keyring service and inspect
the daemon log for a redacted error. Never paste a browser callback URL or an
authorization code into an issue. If a token may have leaked, revoke it in
Spotify and rotate the application credentials before continuing.

## Offline, stale, or quota-limited data

Cached metadata remaining visible while offline is expected. A `401` (expired
authorization), ordinary rate limit, `429` quota exhaustion, and `403`/`404`
capability failure are separate states. Wait for the backoff interval instead
of repeatedly refreshing. Re-login only when the daemon reports authorization
has expired or been revoked.

For a bug report, include the Fedora release, GNOME major version, session type,
Spotify package source, Pulse commit, and the redacted diagnostic message.
Do not include credentials, full logs, or private playlist data.
