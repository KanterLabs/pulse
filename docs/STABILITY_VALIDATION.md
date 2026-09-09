# Shell stability repair

The reported failures were on Fedora 43 / GNOME Shell 49. Pulse first failed
on nonexistent `St.ProgressBar` and `toggle_style_class_name` APIs. The supplied
journal also showed a Pulse indicator destroy callback blocked during GJS
garbage collection. A subsequent whole-laptop reboot was confirmed, but no matching
core dump or kernel log has been collected. These fixes address concrete
extension defects; they do not establish the cause of a whole-machine reboot.

An isolated native test reproduced a third, fatal defect: the shortcut name
`toggle-popover` was passed to Mutter's keybinding API, but the installed
GSettings schema defines `toggle-shortcut`. GLib aborts the process when the
requested key does not exist; JavaScript `try/catch` cannot recover from that
native error. The fix uses the schema key and validates its existence and
string-array type before invoking Mutter.

## Changes

- Match the shortcut binding name to its settings key and validate the schema.
- Use Shell's `BarLevel` and supported style-class add/remove methods.
- Retain the indicator before building its menu; attach subtrees promptly and
  roll back widgets, signals, sources, and keybindings after failed startup.
- Make teardown idempotent and ignore late callbacks after destruction.
- Handle native panel destruction as well as explicit extension disable, so
  Shell shutdown cannot dispatch daemon replies into disposed widgets.
- Let the Shell extension manager manage stylesheets, and remove unsupported
  tooltip calls.
- Render finite progress values using elapsed monotonic time. Schedule progress
  ticks only when the menu is open and playback is active.
- Launch the browser asynchronously and cancel pending launch work on disable.
- Cancel stale D-Bus requests and reject results from previous connections;
  bound in-flight work and normalize malformed payloads.
- Verify the existing extension is inactive before replacement. Fresh activation
  checks the actual Shell state; upgrades require logout/login so GJS cannot
  execute the previously cached module. Configuration, tokens, database, and
  cache remain intact.

## Regression checks

`node --test tests/*.test.mjs` executes the actual source modules with limited
Shell/GIO fixtures. The fixtures deliberately do not implement the invalid
APIs that triggered the original startup errors. Cases include 100 repeated
enable/disable cycles, injected widget-construction failures, late login and
browser replies, progress bounds, and replacing result pages without retaining
old actors or handlers. D-Bus tests cover asynchronous connection/request
lifetimes and malformed input.

`python3 tests/install-user.test.py` uses temporary installation roots and fake
session commands. It checks explicit activation, failure before file replacement,
and preservation of a populated SQLite database plus config/token/cache files.
It never installs into a developer's desktop.

`cargo test --workspace` passed all 21 daemon tests during this repair. The
initial run encountered the development host's temporary-directory quota;
rerunning with `TMPDIR` pointing under `target/` passed. No Rust source or storage
schema is changed by this repair.

The CI static job now requires the Node regression tests and installer tests.
Syntax checks alone cannot detect GObject lifetime or missing Shell API errors.

On 2026-09-09, the extended native test exposed callbacks into disposed Pulse
widgets when Shell shut down with the extension still enabled. Native actor
destruction bypassed the JavaScript `destroy()` override. Resource cleanup now
also runs from `PanelMenu.Button`'s native destroy callback before menu teardown,
and the extension retires its connection, settings callbacks, and shortcut.
All 27 Node tests pass, including direct native-style destruction and late
callbacks. All 16 installer tests pass, including accepted-but-failed disable,
delayed disable completion, activation errors, and populated-data preservation.
The release build and schema compilation also pass; this host still needs
`TMPDIR` under `target/` because its `/tmp` quota is exhausted.

## Native test and remaining desktop validation

The isolated Fedora 43 test using GNOME Shell 49.9, Mutter 49.7, and GJS 1.86
passed ten enable/menu/disable/forced-GC cycles and offline reconnect after the
shortcut fix. On 2026-09-09 the extended test also passed connected playback
controls, artwork, populated views/search, daemon owner replacement, direct C
actor destruction, and shutdown with Pulse enabled. A separate sentinel
extension remained enabled, and GNOME's global extension switch stayed unchanged.
Native smoke commands and limits are recorded in
[tests/gnome-smoke](../tests/gnome-smoke/README.md).

The isolated software-rendered test cannot verify the laptop's graphics
hardware, its particular extension combination, suspend/resume, or an
authenticated Spotify session. Install the repaired checkout, log out/in,
then enable Pulse and check its actual state using
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#all-gnome-extensions-get-turned-off).
The new login is necessary because [GNOME retains imported extension code
until the Shell process ends](https://gjs.guide/extensions/development/debugging.html#reloading-extensions).
