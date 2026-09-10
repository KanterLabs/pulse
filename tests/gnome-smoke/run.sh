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
cp -a /workspace/tests/gnome-smoke/sentinel@pulse-smoke \
    "$XDG_DATA_HOME/gnome-shell/extensions/"
glib-compile-schemas "$XDG_DATA_HOME/gnome-shell/extensions/pulse@kanterlabs/schemas"
shell_log="$runtime_root/shell.log"
fixture_log="$runtime_root/fake-pulse.log"

report() {
    local result=$?
    if (( result != 0 )); then
        echo 'Native Shell smoke failed; private-session log follows:' >&2
        cat "$shell_log" >&2
        [[ -f "$fixture_log" ]] && { echo 'Fake Pulse fixture log:' >&2; cat "$fixture_log" >&2; }
        tail -60 "$runtime_root/services.log" >&2
    fi
}
trap report EXIT

gnome-shell --version
# The same private bus also supplies an isolated system-bus address. No host
# bus or real logind/AccountsService is exposed. Unavailable system-service
# warnings are expected; native/GJS errors still fail the test below.
timeout --kill-after=5 180 dbus-run-session -- bash -Eeuo pipefail -s -- \
    "$shell_log" "$fixture_log" 2>"$runtime_root/services.log" <<'SESSION'
shell_log=$1
fixture_log=$2
export DBUS_SYSTEM_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS"

# Start from a known private profile. The sentinel is enabled before Shell
# starts, so a later Pulse failure can only pass if GNOME preserves it.
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['sentinel@pulse-smoke']"
baseline_disable_user_extensions=$(gsettings get org.gnome.shell disable-user-extensions)

gnome-shell --headless --wayland --no-x11 --virtual-monitor=1280x720 --unsafe-mode >"$shell_log" 2>&1 &
shell_pid=$!
fixture_pid=''

stop_fixture() {
    if [[ -n "$fixture_pid" ]]; then
        kill "$fixture_pid" 2>/dev/null || true
        wait "$fixture_pid" 2>/dev/null || true
        fixture_pid=''
    fi
}

cleanup() {
    local result=$?
    stop_fixture
    if kill -0 "$shell_pid" 2>/dev/null; then
        kill "$shell_pid" 2>/dev/null || true
        wait "$shell_pid" 2>/dev/null || true
    fi
    exit "$result"
}
trap cleanup EXIT

fail() {
    printf 'Smoke assertion failed: %s\n' "$*" >&2
    return 1
}

assert_global_extensions_enabled() {
    local current enabled
    current=$(gsettings get org.gnome.shell disable-user-extensions)
    [[ "$current" == "$baseline_disable_user_extensions" ]] || \
        fail "disable-user-extensions changed from $baseline_disable_user_extensions to $current"
    enabled=$(gsettings get org.gnome.shell enabled-extensions)
    [[ "$enabled" == *sentinel@pulse-smoke* ]] || \
        fail "sentinel was removed from enabled-extensions: $enabled"
}

wait_state() {
    local uuid=$1
    local pattern=$2
    local state=''
    for _ in $(seq 1 100); do
        if ! kill -0 "$shell_pid" 2>/dev/null; then
            fail 'Shell exited unexpectedly'
            return 1
        fi
        state=$(gnome-extensions info "$uuid" 2>/dev/null || true)
        if printf '%s\n' "$state" | rg -q "$pattern"; then
            return 0
        fi
        sleep 0.1
    done
    printf 'Unexpected %s extension state:\n%s\n' "$uuid" "$state" >&2
    return 1
}

evaluate() {
    local response
    response=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>/dev/null) || {
        printf 'Shell Eval transport failed: %s\n' "$1" >&2
        return 1
    }
    if [[ "$response" != "(true, 'true')" ]]; then
        printf 'Shell Eval failed: %s\nResponse: %s\n' "$1" "$response" >&2
        return 1
    fi
}

wait_eval() {
    local expression=$1
    local response=''
    for _ in $(seq 1 120); do
        if ! kill -0 "$shell_pid" 2>/dev/null; then
            fail 'Shell exited unexpectedly while waiting for Eval'
            return 1
        fi
        response=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
            --method org.gnome.Shell.Eval "$expression" 2>/dev/null || true)
        if [[ "$response" == "(true, 'true')" ]]; then
            return 0
        fi
        sleep 0.1
    done
    printf 'Shell Eval never became true: %s\nLast response: %s\n' "$expression" "$response" >&2
    return 1
}

assert_sentinel() {
    wait_state sentinel@pulse-smoke 'State: (ENABLED|ACTIVE)'
    assert_global_extensions_enabled
    wait_eval 'globalThis.__pulseSmokeSentinelEnabled === true'
}

start_fixture() {
    [[ -z "$fixture_pid" ]] || return 0
    gjs -m /workspace/tests/gnome-smoke/fake-pulse.js >>"$fixture_log" 2>&1 &
    fixture_pid=$!
    for _ in $(seq 1 100); do
        if ! kill -0 "$fixture_pid" 2>/dev/null; then
            tail -60 "$fixture_log" >&2
            fail 'Fake Pulse fixture exited during startup'
            return 1
        fi
        local response=''
        response=$(gdbus call --session --dest io.kanterlabs.Pulse \
            --object-path /io/kanterlabs/Pulse \
            --method io.kanterlabs.Pulse1.Health 2>/dev/null || true)
        if [[ "$response" == *fixture* ]]; then
            return 0
        fi
        sleep 0.1
    done
    printf 'Fake Pulse fixture did not acquire its bus name:\n' >&2
    tail -60 "$fixture_log" >&2
    return 1
}

wait_state sentinel@pulse-smoke 'State: (ENABLED|ACTIVE)'
assert_sentinel

for cycle in $(seq 1 10); do
    gnome-extensions enable pulse@kanterlabs
    wait_state pulse@kanterlabs 'State: (ENABLED|ACTIVE)'
    assert_sentinel

    if (( cycle == 1 )); then
        # Exercise the absent-daemon reconnect source before the private
        # service appears. This retains the original offline coverage.
        sleep 13
        wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._connection.connected === false && Main.panel.statusArea["pulse@kanterlabs"]._snapshot.offline === true'
        assert_sentinel
        start_fixture
    fi

    wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._connection.connected === true && Main.panel.statusArea["pulse@kanterlabs"]._snapshot.title === "Fixture Track" && Main.panel.statusArea["pulse@kanterlabs"]._authState.authenticated === true'
    wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._authState.playback_backend === "browser" && Main.panel.statusArea["pulse@kanterlabs"]._openButton.visible === false'
    assert_global_extensions_enabled
    evaluate 'Main.panel.statusArea["pulse@kanterlabs"].menu.open(); true;'
    wait_eval 'Main.panel.statusArea["pulse@kanterlabs"].menu.isOpen === true && Main.panel.statusArea["pulse@kanterlabs"]._viewData.get("home") !== undefined && Main.panel.statusArea["pulse@kanterlabs"]._viewData.get("home").items.length >= 2 && Main.panel.statusArea["pulse@kanterlabs"]._loadMoreButton.visible === false'
    wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._snapshot.art_url.indexOf("file://") === 0 && Main.panel.statusArea["pulse@kanterlabs"]._artwork.gicon !== null && Main.panel.statusArea["pulse@kanterlabs"]._progress.value > 0 && Main.panel.statusArea["pulse@kanterlabs"]._progress.value < 1'
    evaluate 'Main.panel.statusArea["pulse@kanterlabs"]._playButton.emit("clicked", 1); true;'
    wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._snapshot.playing === false && Main.panel.statusArea["pulse@kanterlabs"]._progressSource === 0'
    evaluate 'Main.panel.statusArea["pulse@kanterlabs"]._playButton.emit("clicked", 1); true;'
    wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._snapshot.playing === true && Main.panel.statusArea["pulse@kanterlabs"]._progressSource !== 0'

    evaluate 'Main.panel.statusArea["pulse@kanterlabs"]._setView("library"); true;'
    wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._view === "library" && Main.panel.statusArea["pulse@kanterlabs"]._viewData.get("library")?.items.length === 36 && Main.panel.statusArea["pulse@kanterlabs"]._resultsBox.get_n_children() === 36 && Main.panel.statusArea["pulse@kanterlabs"]._loadMoreButton.visible === false'
    # A real library used to grow the menu far below the bottom of a laptop
    # screen. Check allocation and keyboard access, not just the row count.
    wait_eval '(() => {
        const menu = Main.panel.statusArea["pulse@kanterlabs"].menu.actor;
        const [, y] = menu.get_transformed_position();
        const [, height] = menu.get_transformed_size();
        return height > 0 && y >= 0 && y + height <= global.stage.height;
    })()'
    evaluate 'Main.panel.statusArea["pulse@kanterlabs"]._resultsBox.get_last_child().grab_key_focus(); true;'
    wait_eval '(() => {
        const pulse = Main.panel.statusArea["pulse@kanterlabs"];
        const last = pulse._resultsBox.get_last_child();
        const [, y] = last.get_transformed_position();
        const [, height] = last.get_transformed_size();
        const [, scrollY] = pulse._resultsScroll.get_transformed_position();
        const [, scrollHeight] = pulse._resultsScroll.get_transformed_size();
        return last.has_key_focus() && y >= scrollY && y + height <= scrollY + scrollHeight;
    })()'
    evaluate 'Main.panel.statusArea["pulse@kanterlabs"]._setView("queue"); true;'
    wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._view === "queue" && Main.panel.statusArea["pulse@kanterlabs"]._viewData.get("queue") !== undefined && Main.panel.statusArea["pulse@kanterlabs"]._viewData.get("queue").items.length >= 1 && Main.panel.statusArea["pulse@kanterlabs"]._loadMoreButton.visible === true'
    evaluate 'Main.panel.statusArea["pulse@kanterlabs"]._setView("search"); true;'
    wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._view === "search" && Main.panel.statusArea["pulse@kanterlabs"]._searchEntry.visible === true'
    evaluate 'Main.panel.statusArea["pulse@kanterlabs"]._searchEntry.get_clutter_text().grab_key_focus(); true;'
    wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._searchEntry.get_clutter_text().has_key_focus() === true'
    evaluate 'Main.panel.statusArea["pulse@kanterlabs"]._searchEntry.set_text("fixture"); Main.panel.statusArea["pulse@kanterlabs"]._scheduleSearch(); true;'
    wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._view === "search" && Main.panel.statusArea["pulse@kanterlabs"]._searchPayload.items.length >= 2'
    assert_sentinel

    evaluate 'Main.panel.statusArea["pulse@kanterlabs"].menu.close(); true;'
    wait_eval 'Main.panel.statusArea["pulse@kanterlabs"].menu.isOpen === false'

    if (( cycle == 2 )); then
        # Kill and restart the real D-Bus owner while Pulse is enabled. The
        # connection must reset safely, then recover through the same proxy.
        stop_fixture
        sleep 1
        wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._connection.connected === false && Main.panel.statusArea["pulse@kanterlabs"]._snapshot.offline === true'
        assert_sentinel
        start_fixture
        wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._connection.connected === true && Main.panel.statusArea["pulse@kanterlabs"]._snapshot.title === "Fixture Track"'
        assert_sentinel
    fi

    gnome-extensions disable pulse@kanterlabs
    wait_state pulse@kanterlabs 'State: (DISABLED|INACTIVE)'
    assert_sentinel
    evaluate 'imports.system.gc(); true;'
    assert_sentinel
    sleep 0.1
    printf 'Native cycle %s passed\n' "$cycle"
done

# Invoke the actual C actor destructor, bypassing Pulse's JavaScript destroy()
# override, as happens when Shell removes the panel. The daemon client must
# already be retired when subsequent native callbacks can run.
gnome-extensions enable pulse@kanterlabs
wait_state pulse@kanterlabs 'State: (ENABLED|ACTIVE)'
wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._connection.connected === true'
evaluate 'globalThis.__pulseSmokeConnection = Main.panel.statusArea["pulse@kanterlabs"]._connection; imports.gi.Clutter.Actor.prototype.destroy.call(Main.panel.statusArea["pulse@kanterlabs"]); true;'
wait_eval 'globalThis.__pulseSmokeConnection._destroyed === true && Main.panel.statusArea["pulse@kanterlabs"] === undefined'
assert_sentinel
gnome-extensions disable pulse@kanterlabs
wait_state pulse@kanterlabs 'State: (DISABLED|INACTIVE)'
evaluate 'delete globalThis.__pulseSmokeConnection; imports.system.gc(); true;'

# Leave Pulse enabled with its menu closed for the native Shell shutdown path.
# The fixture disappears first, so the connection must process owner loss while
# its indicator is still registered; no focused search entry remains in this
# fresh indicator.
gnome-extensions enable pulse@kanterlabs
wait_state pulse@kanterlabs 'State: (ENABLED|ACTIVE)'
wait_eval 'Main.panel.statusArea["pulse@kanterlabs"]._connection.connected === true && Main.panel.statusArea["pulse@kanterlabs"]._snapshot.title === "Fixture Track"'
evaluate 'Main.panel.statusArea["pulse@kanterlabs"].menu.close(); true;'
wait_eval 'Main.panel.statusArea["pulse@kanterlabs"].menu.isOpen === false'
assert_sentinel
assert_global_extensions_enabled
if ! kill -0 "$shell_pid" 2>/dev/null; then
    fail 'Shell exited after lifecycle cycles'
fi
stop_fixture
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
if [[ -f "$fixture_log" ]] && rg -n -i 'segmentation fault|JS ERROR|Gjs-CRITICAL|invalid pointer|double free|exception|error' "$fixture_log"; then
    echo 'Fake Pulse fixture errors found in fixture log' >&2
    exit 1
fi
echo 'GNOME 49 smoke passed: 10 offline/connected enable/menu/view/search/owner-reconnect/disable/GC cycles with sentinel extension intact.'
