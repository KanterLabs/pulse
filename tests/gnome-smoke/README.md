# Native GNOME 49 lifecycle test

Run from the repository root with Docker:

```bash
docker build -f tests/gnome-smoke/Dockerfile -t pulse-gnome-smoke .
docker run --rm --network=none --cpus=2 --memory=4g --pids-limit=512 \
  -v "$PWD:/workspace:ro" pulse-gnome-smoke
```

The Dockerfile-specific ignore file restricts the build context to the harness.
At runtime only the repository is mounted, read-only. The harness copies the
extension and a separate sentinel extension into temporary XDG directories
owned by a disposable container user, compiles Pulse's schema, and starts a
headless Wayland compositor with software rendering. It does not mount a host
GPU, display socket, session/system bus, or home directory. The GJS fixture at
`tests/gnome-smoke/fake-pulse.js` implements the checked-in Pulse D-Bus contract
inside the private session bus; it carries deterministic snapshot, auth, view,
search, artwork, and progress data without credentials or network access.

`--unsafe-mode` is used only inside this private test session so D-Bus Eval can
open/close the actual menu and force garbage collection. Do not apply that
option to a normal desktop. The private session bus also provides the isolated
system-bus address; missing logind, AccountsService, portals, and other system
service warnings are expected. Pulse stack traces, GJS errors, native aborts,
and GC/destroy warnings fail the test.

The test keeps the sentinel enabled while it enables Pulse, waits through the
absent-daemon reconnect timer, opens the connected popover, checks populated
rows/artwork/progress, switches home/library/queue/search views, and forces GJS
garbage collection. It kills and restarts the fixture once while Pulse remains
enabled to cover owner loss and reconnection, then disables Pulse for each of
ten cycles. Home omits `next_cursor`, library returns an empty cursor, and
queue returns a real cursor so the load-more path is exercised in both states.
The playback button is clicked in both directions while connected, covering
the D-Bus playback signal and progress-timer start/stop path.
Search focuses the entry's internal ClutterText before entering text, matching
normal keyboard input. After the ten cycles, the test invokes Clutter's native
actor destructor directly and verifies Pulse retires its daemon connection.
After the cycles, Pulse is re-enabled with its menu closed, the fixture owner
is stopped, and Shell shuts down through the still-enabled extension path.
The harness checks the sentinel's Shell state and marker, the enabled-extension
list, and the baseline `disable-user-extensions` setting after each phase. A
Shell or fixture exit, wrong extension state, failed Eval, or relevant log
error returns nonzero. CI runs this image build and test on `homelab-heavy`.

## Recorded validation

On 2026-09-08, the test image supplied GNOME Shell **49.9**, Mutter **49.7**,
and GJS **1.86** on Fedora **43**. Before the shortcut fix it reproduced a
fatal `GLib-GIO-ERROR`: `toggle-popover` was not a settings key. This aborted
the Shell before the first cycle could complete. With `toggle-shortcut` and
schema validation in place, all ten cycles and offline reconnect passed.

On 2026-09-09, the extended connected lifecycle, playback, view/search,
owner-reconnect, native actor destruction, and enabled-shutdown checks passed
on the same GNOME 49.9 environment. The sentinel stayed active and the global
extension setting stayed unchanged. The shutdown case initially exposed Pulse
callbacks reaching disposed widgets; the extension now cleans up through the
native panel destroy callback as well as its explicit disable method.

This is native Shell/GObject coverage, not hardware validation. It cannot
establish the cause of the reported laptop reboot or verify GPU drivers,
other installed extensions, authenticated Spotify behavior, suspend/resume,
or long-duration resource usage. Install the repaired source and log out/in
before enabling it on the laptop; see the [repair procedure](../../docs/TROUBLESHOOTING.md#all-gnome-extensions-get-turned-off).
