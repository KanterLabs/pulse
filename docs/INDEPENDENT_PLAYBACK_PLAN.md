# Pulse independent playback plan

Status: stages 2–5 implemented behind `--independent-playback`; stage 6 laptop
acceptance and stage 7 release packaging remain.
Date: 2026-09-10

## Outcome

Pulse remains a GNOME Shell extension for its interface. A separately
supervised `pulse-player.service` runs Spotify's Web Playback SDK in headless
Google Chrome, so daily playback has no visible application window. A normal
browser window opens only for Spotify sign-in and can be closed afterward.

The Rust daemon remains the only process the extension contacts. The extension
does no HTTP, filesystem, or subprocess work, and player failure degrades to an
offline state instead of taking down GNOME Shell or other extensions.

## Implemented

- An opt-in installer deploys the daemon, GNOME extension, player helper,
  systemd units, and browser-backend drop-in. Later ordinary upgrades preserve
  that choice.
- The helper uses Google Chrome `--headless=new`, a private profile, PKCE, and
  a loopback server. Refresh tokens are stored through Secret Service and never
  appear in URLs, process arguments, source files, or logs.
- A private runtime descriptor has mode `0600`; its parent is `0700`. The daemon
  validates ownership, file type, mode, loopback address, exact host, and a
  random bearer secret before every request.
- The daemon routes snapshot, play/pause, next, previous, seek, and supported
  Spotify URI selection to the player. Search and account views continue
  through the Web API using short-lived access tokens from the helper.
- Player sessions, commands, login attempts, refreshes, and cached daemon
  results use generation checks so late work cannot restore a logged-out or
  replaced account.
- Installation creates a verified pre-upgrade backup and preserves existing
  configuration, SQLite data, cache, and keyring data. Default uninstall also
  preserves runtime data.

## Validation completed

Unit, Rust integration, installer-upgrade, private D-Bus, browser, and native
GNOME lifecycle suites cover the new boundary. The full simulated integration
starts a private D-Bus daemon, the real Rust daemon, the real helper, and
headless Chromium; it exercises playback, seeking, direct track selection,
search, setup-window closure, player loss, and logout. Spotify network and DRM
are simulated in automated tests.

Shane separately confirmed that the real Premium account and Google Chrome can
play through the stage-1 prototype with the Spotify desktop application closed.
The new headless service still needs a real-laptop audio run.

## Remaining release gates

1. Install with `./scripts/install-user.sh --independent-playback` on the Fedora
   laptop and record Fedora, GNOME, and Google Chrome versions.
2. Confirm audible playback through the headless service, including
   setup-window closure, pause/resume, seek, track/context selection, and
   logout/login.
3. Exercise network loss, suspend/resume, audio-device changes, daemon/player
   restarts, repeated extension enable/disable, and at least one hour of audio.
   Keep another extension enabled and verify GNOME's global extension switch
   never changes.
4. Publish versioned binaries and checksums so ordinary users do not need Rust
   or a repository checkout to install.

## Development prototype

The standalone feasibility page remains in
[`experiments/web-playback`](../experiments/web-playback/README.md). It is useful
for isolating Spotify SDK or account behavior, while the installed mode uses
the service architecture above.
