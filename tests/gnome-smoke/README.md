# Native GNOME 49 lifecycle test

Run from the repository root with Docker:

```bash
docker build -f tests/gnome-smoke/Dockerfile -t pulse-gnome-smoke .
docker run --rm --network=none --cpus=2 --memory=4g --pids-limit=512 \
  -v "$PWD:/workspace:ro" pulse-gnome-smoke
```

The Dockerfile-specific ignore file restricts the build context to the harness.
At runtime only the repository is mounted, read-only. The harness copies the
extension into temporary XDG directories owned by a disposable container user,
compiles its schema, and starts a headless Wayland compositor with software
rendering. It does not mount a host GPU, display socket, session/system bus, or
home directory. There is no Pulse daemon or Spotify account in this test.

`--unsafe-mode` is used only inside this private test session so D-Bus Eval can
open/close the actual menu and force garbage collection. Do not apply that
option to a normal desktop. The private session bus also provides the isolated
system-bus address; missing logind, AccountsService, portals, and other system
service warnings are expected. Pulse stack traces, GJS errors, native aborts,
and GC/destroy warnings fail the test.

The test enables Pulse, opens the popover, switches views, closes it, disables
the extension, and forces GJS garbage collection ten times. The first cycle
also waits for the absent-daemon reconnect timer. A Shell exit, wrong extension
state, failed Eval, or relevant log error returns nonzero. CI runs this image
build and test on `homelab-heavy`.

## Recorded validation

On 2026-09-08, the test image supplied GNOME Shell **49.9**, Mutter **49.7**,
and GJS **1.86** on Fedora **43**. Before the shortcut fix it reproduced a
fatal `GLib-GIO-ERROR`: `toggle-popover` was not a settings key. This aborted
the Shell before the first cycle could complete. With `toggle-shortcut` and
schema validation in place, all ten cycles and offline reconnect passed.

This is native Shell/GObject coverage, not hardware validation. It cannot
establish the cause of the reported laptop reboot or verify GPU drivers,
other installed extensions, authenticated Spotify behavior, suspend/resume,
or long-duration resource usage. Keep the affected laptop's extension disabled
until its previous-boot kernel log and a reviewed build can be assessed.
