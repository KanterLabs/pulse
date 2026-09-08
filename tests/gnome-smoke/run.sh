#!/usr/bin/env bash
set -Eeuo pipefail

# This script runs INSIDE the disposable test container, never on a desktop.
[[ -f /.dockerenv ]] || { echo 'Run this through the documented Docker command.' >&2; exit 1; }
runtime_root=$(mktemp -d /tmp/pulse-gnome-smoke.XXXXXX)
export XDG_RUNTIME_DIR="$runtime_root/runtime"
export XDG_DATA_HOME="$runtime_root/data"
export XDG_CONFIG_HOME="$runtime_root/config"
export XDG_CACHE_HOME="$runtime_root/cache"
export XDG_STATE_HOME="$runtime_root/state"
export XDG_CURRENT_DESKTOP=GNOME
export XDG_SESSION_TYPE=wayland
export LIBGL_ALWAYS_SOFTWARE=1
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_DATA_HOME/gnome-shell/extensions" \
    "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
chmod 0700 "$XDG_RUNTIME_DIR"
cp -a /workspace/extension/pulse@kanterlabs "$XDG_DATA_HOME/gnome-shell/extensions/"
glib-compile-schemas "$XDG_DATA_HOME/gnome-shell/extensions/pulse@kanterlabs/schemas"
shell_log="$runtime_root/shell.log"

report() {
    local result=$?
    if (( result != 0 )); then
        echo 'Native Shell smoke failed; private-session log follows:' >&2
        cat "$shell_log" >&2
        tail -60 "$runtime_root/services.log" >&2
    fi
}
trap report EXIT

gnome-shell --version
# The same private bus also supplies an isolated system-bus address. No host
# bus or real logind/AccountsService is exposed. Unavailable system-service
# warnings are expected; native/GJS errors still fail the test below.
timeout --kill-after=5 180 dbus-run-session -- bash -Eeuo pipefail -s -- "$shell_log" 2>"$runtime_root/services.log" <<'SESSION'
export DBUS_SYSTEM_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS"
shell_log=$1
gsettings set org.gnome.shell enabled-extensions '[]'
gnome-shell --headless --wayland --no-x11 --virtual-monitor=1280x720 --unsafe-mode >"$shell_log" 2>&1 &
shell_pid=$!
trap 'kill "$shell_pid" 2>/dev/null || true; wait "$shell_pid" 2>/dev/null || true' EXIT

wait_state() {
    local pattern=$1
    local state=''
    for _ in $(seq 1 100); do
        kill -0 "$shell_pid" 2>/dev/null || { echo 'Shell exited unexpectedly' >&2; return 1; }
        state=$(gnome-extensions info pulse@kanterlabs 2>/dev/null || true)
        if printf '%s\n' "$state" | rg -q "$pattern"; then
            return 0
        fi
        sleep 0.1
    done
    printf 'Unexpected extension state:\n%s\n' "$state" >&2
    return 1
}
wait_state 'State:'

evaluate() {
    local response
    response=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1")
    [[ "$response" == "(true, 'true')" ]] || { printf 'Shell Eval failed: %s\n' "$response" >&2; return 1; }
}
for cycle in $(seq 1 10); do
    gnome-extensions enable pulse@kanterlabs
    wait_state 'State: (ENABLED|ACTIVE)'
    evaluate 'Main.panel.statusArea["pulse@kanterlabs"].menu.open(); true;'
    evaluate 'Main.panel.statusArea["pulse@kanterlabs"]._setView("search"); true;'
    evaluate 'Main.panel.statusArea["pulse@kanterlabs"]._setView("home"); true;'
    if (( cycle == 1 )); then
        # Exercise the absent-daemon reconnect source as well as menu setup.
        sleep 13
    fi
    evaluate 'Main.panel.statusArea["pulse@kanterlabs"].menu.close(); true;'
    gnome-extensions disable pulse@kanterlabs
    wait_state 'State: (DISABLED|INACTIVE)'
    evaluate 'imports.system.gc(); true;'
    sleep 0.1
    printf 'Native cycle %s passed\n' "$cycle"
done
kill -0 "$shell_pid"
kill "$shell_pid"
result=0
wait "$shell_pid" || result=$?
trap - EXIT
[[ "$result" -eq 0 || "$result" -eq 143 ]] || exit "$result"
SESSION

if rg -n -i 'segmentation fault|JS ERROR|Gjs-CRITICAL|sweeping phase|offending signal|Pulse cleanup failed|invalid pointer|double free|assertion.*failed|extension/pulse@kanterlabs|Gjs_pulse' "$shell_log"; then
    echo 'Native/GJS errors found in Shell log' >&2
    exit 1
fi
echo 'GNOME 49 smoke passed: 10 enable/menu/disable/GC cycles and offline reconnect.'
