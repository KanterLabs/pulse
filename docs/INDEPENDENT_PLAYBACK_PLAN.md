# Pulse independent playback plan

Status: stage 1 prototype implemented; real-account and background-runtime
acceptance pending. Production playback engine not implemented.
Date: 2026-09-09

## Outcome

Install Pulse, connect a Spotify account, and browse and play music from the
GNOME panel with the Spotify desktop application closed. A separate Pulse
player process handles audio; the extension remains the interface. Browser
login is allowed during account setup. Daily playback should not require a
visible browser player or manual selection of a Spotify Connect device.

This changes the product direction in FEDORA_IMPLEMENTATION_PLAN.md. That
document describes the existing desktop-client companion; this document
describes the proposed standalone playback experience. Existing playback
continues to work during development of the new backend.

## Steps and acceptance criteria

Each step is an implementation-sized backlog item. Complete its acceptance
criteria before treating dependent work as ready. No future step is claimed
as active implementation by this planning document.

### 1. Prove independent playback on Fedora

- Record the laptop's Fedora/GNOME versions and confirm account eligibility.
- Start with Spotify's official Web Playback SDK. Test an actual supported
  browser engine, including encrypted-media/DRM support, audio output,
  autoplay/user-gesture behavior, and runtime distribution requirements.
- Determine whether a packaged Pulse helper can keep playing with its setup
  window closed and accept playback requests from an external process.
- Verify the currently available playback/transfer APIs and required OAuth
  scopes. Do not assume a generic webview, Electron, or headless Chromium can
  stream Spotify just because it can execute JavaScript.
- Record the tested runtime and any remaining user interaction requirements.

Done: a real Premium account plays a complete track on the laptop with the
Spotify desktop app closed, and the prototype handles pause, resume, seek,
and the next track. Closing and reopening the Pulse UI does not stop audio.
If the required background experience cannot be demonstrated, document the
blocker and evaluate alternatives before building the dependent UI. Native
alternatives such as librespot require an explicit backend decision because
they are unofficial integrations; they are not an automatic fallback.

### 2. Add the isolated Pulse player service

Depends on step 1.

- Package the proven playback runtime as a separate user process, supervised
  independently from GNOME Shell.
- Add a playback backend boundary in the daemon; retain MPRIS compatibility
  during development while adding the independent backend.
- Define bounded commands and events for readiness, playback, position,
  capabilities, errors, and process restart. Invalidate stale events when a
  player instance is replaced.

Done: killing or restarting the player does not crash Shell or disable any
extension. Pulse reports the interruption and can reconnect without duplicate
players or unbounded restart attempts.

### 3. Make account setup work inside Pulse

Depends on steps 1 and 2.

- Provide setup UI for any required public client ID and callback settings,
  instead of requiring manual TOML edits.
- Implement PKCE login with the scopes proven in step 1. Prompt for renewed
  consent when existing tokens lack those scopes.
- Keep refresh tokens in Secret Service. Supply the player with only the
  credentials it needs over a restricted local channel; never put tokens in
  URLs, command arguments, logs, or extension settings.
- Handle expired credentials, revoked consent, logout, and interrupted login.

Done: a fresh install can sign in from Pulse, play a track, restart, and
reconnect. Logout retires the playback session and stops authenticated use.

### 4. Route the extension's controls to the new player

Depends on steps 2 and 3.

- Connect play/pause, next/previous, seeking, and volume to the Pulse player.
- Display authoritative track, artwork, duration, position, and buffering
  state. Distinguish daemon connection, player readiness, and account login.
- Make a track selection play in Pulse, with no Spotify desktop launch.

Done: all primary controls work from the panel with Spotify closed. Closing
the popover preserves playback; reopening it shows the current state.

### 5. Make browsing lead directly to playback

Depends on step 4.

- Wire search results, saved music, playlists, and supported queue actions
  into the selected backend.
- Verify current Development Mode endpoint limits against the real account.
  Show a clear unavailable state for unsupported capabilities.
- Keep pagination bounded and ensure late replies cannot replace newer views
  or playback state.

Done: searching for and selecting a track starts it in Pulse. Supported
playlist/context playback advances correctly and the queue reflects playback.

### 6. Validate desktop stability and recovery

Depends on steps 4 and 5; add focused regression coverage throughout earlier
steps rather than deferring all testing until this stage.

- Extend unit, private-D-Bus, and native GNOME tests for the new backend.
- Exercise player/daemon crashes, bus loss, token expiry, network loss and
  recovery, suspend/resume, audio-device changes, and login-session restart.
- Check repeated enable/disable cycles, resource cleanup, and sustained
  playback. Keep a sentinel extension enabled and verify GNOME's global
  extension switch does not change.
- Keep automated mock tests separate from the real-account laptop evidence.

Done: a recorded laptop acceptance run covers these cases and at least one
hour of playback without a Shell crash, disabled extensions, or accumulating
player processes. Failures have regression coverage and are repaired before
release.

### 7. Ship a simple GitHub installation and upgrade path

Depends on step 6.

- Publish versioned release artifacts for the supported laptop architecture,
  with checksums and a documented runtime/dependency strategy from step 1.
- Provide one installer that installs the extension, daemon, and playback
  helper and guides account setup. Ordinary installation should not require
  users to compile Rust, enter TOML in a terminal, or clone over an old folder.
- Preserve existing settings and data. Verify upgrades with populated data
  and backups before any migration; rollback must not reset user data.
- Explain when GNOME requires a new login and make the activation step clear.
- Keep CI on the organization's homelab runner tiers, choosing homelab-heavy
  for builds and native integration suites.

Done: install a published release on the laptop, sign in, and play from Pulse
with Spotify closed; then upgrade and verify retained settings and a working
rollback.

## Immediate next work

The [stage 1 browser prototype](../experiments/web-playback/README.md) provides
PKCE login, a Web Playback SDK device, targeted playback, controls, runtime
diagnostics, and automated lifecycle tests. Premium eligibility is confirmed.
The available embedded browser failed its Widevine capability check; real
audio must be checked in a supported laptop browser. No complete-track or
window-independent runtime acceptance has been recorded yet.

Steps 2–7 remain backlog work until
the playback prototype resolves the browser-runtime and background-playback
constraints. The installed extension still uses the existing playback backend.

## References

- [Spotify Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk)
- [SDK setup and Premium requirement](https://developer.spotify.com/documentation/web-playback-sdk/tutorials/getting-started)
- [Spotify playback transfer API](https://developer.spotify.com/documentation/web-api/reference/transfer-a-users-playback)
- [GNOME JavaScript runtime](https://gjs.guide/guides/gjs/intro.html)
- [librespot project and support limitations](https://github.com/librespot-org/librespot)
