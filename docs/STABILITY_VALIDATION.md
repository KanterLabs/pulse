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
- Let the Shell extension manager manage stylesheets, and remove unsupported
  tooltip calls.
- Render finite progress values using elapsed monotonic time. Schedule progress
  ticks only when the menu is open and playback is active.
- Launch the browser asynchronously and cancel pending launch work on disable.
- Cancel stale D-Bus requests and reject results from previous connections;
  bound in-flight work and normalize malformed payloads.
- Disable the extension before installation. Activation is an explicit option;
  normal installation preserves configuration, tokens, database, and cache.

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

## Native test and remaining desktop validation

The isolated Fedora 43 test using GNOME Shell 49.9, Mutter 49.7, and GJS 1.86
passed ten enable/menu/disable/forced-GC cycles and offline reconnect after the
shortcut fix. Native smoke commands and limits are recorded in
[tests/gnome-smoke](../tests/gnome-smoke/README.md). A
software-rendered isolated Shell test cannot verify the laptop's graphics
hardware, other installed extensions, suspend/resume, or a long-running Spotify
session. Keep Pulse disabled on the affected laptop until the repair is reviewed
and crash evidence can be checked. Use the recovery instructions in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) if GNOME cannot stay running.
