# Independent playback feasibility prototype

This is stage 1 of the [independent playback plan](../../docs/INDEPENDENT_PLAYBACK_PLAN.md).
It creates a Spotify Web Playback SDK device and starts a track directly on
that device through Spotify's Web API. The Spotify desktop application is
not used by this code. **Real-account streaming has not yet been verified.**

This experiment does not install, restart, or change the daemon, GNOME
extension, user services, configuration, keyring, or database. It is not yet
the independent GNOME player release.

## Run on the laptop

Requires Node.js 22+ and a supported browser with Widevine/protected-content
playback enabled. On Fedora, install Node with `sudo dnf install nodejs` if
needed. From this checkout:

```sh
./scripts/playback-probe.sh
```

Open the local address printed by the launcher in Chrome or Firefox.
In your Spotify developer app, enable **Web Playback SDK** and register
`http://127.0.0.1:8888/callback`. Enter your public Client ID in the page and
click **Connect Spotify**. A client secret is never needed.

Close the official Spotify desktop application. Paste a Spotify track link
in the prototype and click **Play here**. This activates browser audio from
your click and explicitly targets the prototype's device; no manual device
selection is required. A different track link can start the next test track.
Previous/Next use Spotify's current queue and may be unavailable for a
single-track selection. Signing out disconnects the SDK and clears the
prototype's credentials. Stop the server with Ctrl+C when finished.

Optional environment variables:

- `PULSE_PROBE_CLIENT_ID`: prefill the public Client ID without saving it.
- `PULSE_PROBE_PORT`: change the loopback port; register the matching callback
  in the Spotify app first. If port 8888 is occupied (for example by a pending
  Pulse login), complete/cancel that login or choose a different port.

**Keep the player tab open.** Closing it stops audio. Minimize the browser
to test background playback, but do not interpret this as proof of a packaged
helper that can survive closing its own window.

## Credential boundary

The server binds only `127.0.0.1`, checks Host and request origin, and exposes
only allowlisted assets. OAuth uses PKCE with expiring, single-use state.
Tokens stay in process memory; only a short-lived access token reaches the
same-origin player page. No client secret, token files, browser storage,
extension settings, or request logs are used. Refresh and logout invalidate
stale operations. Another local process under the same user is outside this
prototype's isolation boundary. The production service needs its own
restricted IPC and keyring integration.

## Validation and release gate

Run automated tests with `node --test tests/*.test.mjs` from the repository
root. These test authentication boundaries and player lifecycles with fake
Spotify responses; they do **not** prove DRM support or audible playback.

Developers with Playwright and its Chromium installed can also run
`node tests/web-playback-browser-smoke.mjs`. If Playwright is installed
outside the repository, set `PULSE_PLAYWRIGHT_MODULE` to its absolute
`index.mjs` path; `PULSE_CHROMIUM_PATH` optionally selects the browser binary.
This exercises the actual browser login, callback, token, play, controls,
and logout flow against simulated Spotify endpoints. It caught a native
browser fetch binding failure missed by Node-only tests. DRM is mocked in
this test; a separate dev Chromium capability probe passed, which still
does not prove Spotify streaming.

Record the following on the laptop before choosing the production runtime:

| Check | Evidence required |
| --- | --- |
| Environment | Fedora/GNOME versions printed by launcher; browser/version |
| Eligibility | Premium confirmed; successful OAuth with streaming scopes |
| Audio | Complete audible track with the official Spotify application closed |
| Controls | Pause, resume, seek, volume, track change and supported queue advance |
| Background | Audio survives minimize; separately evaluate setup-window closure |
| Recovery | Offline/online, reconnect, logout, expired token and server restart |
| Desktop safety | Pulse popover open/close; GNOME and other extensions remain healthy |

Current evidence: Shane confirmed Premium. The available T3 embedded browser
reports Chrome 150 on Linux and exposes encrypted-media APIs, but an actual
`com.widevine.alpha` audio capability request returned `NotSupportedError`.
That browser cannot be used to establish streaming feasibility. Laptop SSH
responds but rejects the available authentication. Laptop Fedora/GNOME
versions, real Spotify audio, and window-independent runtime remain unverified.

Do not bundle an untested Electron/webview runtime or replace the installed
playback backend based solely on these mock tests. Stages 2–7 remain gated
on the real-account and background-runtime results.

References: [SDK setup](https://developer.spotify.com/documentation/web-playback-sdk/tutorials/getting-started),
[SDK controls and events](https://developer.spotify.com/documentation/web-playback-sdk/reference),
[targeted playback](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback).
