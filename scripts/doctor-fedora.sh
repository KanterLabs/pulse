#!/usr/bin/env bash

# Read-only Fedora/GNOME compatibility report.  Nothing in this script writes
# to the repository, XDG directories, the user systemd manager, or the session
# bus.  Start Spotify before rerunning it to check MPRIS visibility.

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=pulse-common.bash
source "$SCRIPT_DIR/pulse-common.bash"

pulse_require_non_root

STRICT=0
DRY_RUN=0
if (($# > 0)); then
    while (($# > 0)); do
        case $1 in
            --strict)
                STRICT=1
                ;;
            --dry-run)
                DRY_RUN=1
                ;;
            -h|--help)
                cat <<'EOF'
Usage: scripts/doctor-fedora.sh [--strict] [--dry-run]

Prints a read-only compatibility report for a Fedora Workstation Pulse
installation.  --strict treats warnings (including a not-yet-running
Spotify/MPRIS player) as failures.  --dry-run is accepted for symmetry with
the other scripts and does not change the read-only behavior.

The doctor never installs packages or starts/stops applications.
EOF
                exit 0
                ;;
            *)
                pulse_error "unknown option: $1"
                exit 2
                ;;
        esac
        shift
    done
fi

blockers=0
warnings=0

pass() {
    printf '  [ok]   %s\n' "$1"
}

warn() {
    printf '  [warn] %s\n' "$1"
    warnings=$((warnings + 1))
}

block() {
    printf '  [FAIL] %s\n' "$1"
    blockers=$((blockers + 1))
}

show_command() {
    local label=$1
    shift
    local output
    if ! pulse_have_command "$1"; then
        printf '  [miss] %-30s (%s is not installed)\n' "$label" "$1"
        return 1
    fi
    output=$("$@" 2>&1 || true)
    output=${output//$'\n'/; }
    [[ -n "$output" ]] || output='available'
    printf '  [info] %-30s %s\n' "$label" "$output"
    return 0
}

check_command() {
    local label=$1
    local command_name=$2
    local severity=$3
    if pulse_have_command "$command_name"; then
        pass "$label ($command_name)"
    elif [[ "$severity" == required ]]; then
        block "$label is missing: $command_name"
    else
        warn "$label is missing: $command_name"
    fi
}

printf 'Pulse Fedora compatibility doctor (read-only)\n'
printf 'Repository: %s\n' "$PULSE_REPO_ROOT"
if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'Mode: dry-run (no writes; probes are still read-only)\n'
fi
printf '\nSystem\n'

if [[ -r /etc/fedora-release ]]; then
    printf '  [info] Fedora release: %s\n' "$(< /etc/fedora-release)"
else
    if [[ -r /etc/os-release ]]; then
        os_name='unknown'
        os_id='unknown'
        # shellcheck disable=SC1091
        . /etc/os-release
        os_name=${PRETTY_NAME:-${NAME:-unknown}}
        os_id=${ID:-unknown}
        printf '  [info] operating system: %s (%s)\n' "$os_name" "$os_id"
    else
        printf '  [info] operating system metadata is unavailable\n'
        os_id='unknown'
    fi
    if [[ "${PULSE_DOCTOR_ALLOW_NON_FEDORA:-0}" == 1 ]]; then
        warn 'this host does not expose /etc/fedora-release (allowed by PULSE_DOCTOR_ALLOW_NON_FEDORA=1)'
    else
        block 'this host does not expose /etc/fedora-release; run the doctor on Fedora Workstation'
    fi
fi

if [[ -r /etc/fedora-release ]]; then
    pass 'Fedora release metadata is present'
fi

session_type=${XDG_SESSION_TYPE:-unset}
printf '  [info] XDG_SESSION_TYPE: %s\n' "$session_type"
case "$session_type" in
    wayland|x11|unset)
        ;;
    *)
        warn "unusual XDG_SESSION_TYPE: $session_type"
        ;;
esac

show_command 'GNOME Shell' gnome-shell --version || warn 'gnome-shell is unavailable (runtime UI cannot be checked)'
show_command 'GNOME extensions CLI' gnome-extensions version || warn 'gnome-extensions is unavailable (extension cannot be enabled automatically)'
show_command 'systemd user manager' systemctl --user --version || block 'systemctl is unavailable (user service cannot run)'
show_command 'session bus tooling' busctl --user --version || warn 'busctl is unavailable (MPRIS probe is unavailable)'

printf '\nBuild prerequisites\n'
check_command 'Cargo' cargo required
check_command 'Rust compiler' rustc required
schema_source="$PULSE_REPO_ROOT/extension/pulse@kanterlabs/schemas"
schema_files=0
if [[ -d "$schema_source" ]]; then
    schema_files=$(find "$schema_source" -maxdepth 1 -type f -name '*.gschema.xml' -print | wc -l)
fi
if [[ "$schema_files" -gt 0 ]]; then
    check_command 'GSettings schema compiler' glib-compile-schemas required
else
    check_command 'GSettings schema compiler' glib-compile-schemas optional
fi
check_command 'GJS runtime' gjs optional
check_command 'Python 3 diagnostics' python3 optional
check_command 'ShellCheck (script lint)' shellcheck optional
check_command 'D-Bus activation environment updater' dbus-update-activation-environment optional
check_command 'rsync (development sync only)' rsync optional

printf '\nSpotify client discovery (optional for builds)\n'
native_spotify=0
flatpak_spotify=0
if pulse_have_command spotify; then
    native_spotify=1
    printf '  [ok]   native/RPM Spotify: %s\n' "$(command -v spotify)"
else
    printf '  [info] native/RPM Spotify: not found on PATH\n'
fi

if pulse_have_command flatpak; then
    flatpak_info=$(flatpak info com.spotify.Client 2>&1 || true)
    if [[ -n "$flatpak_info" && "$flatpak_info" != *'is not installed'* && "$flatpak_info" != *'error'* && "$flatpak_info" != *'Error'* ]]; then
        flatpak_spotify=1
        printf '  [ok]   Spotify Flatpak com.spotify.Client: %s\n' "${flatpak_info//$'\n'/; }"
    else
        printf '  [info] Spotify Flatpak com.spotify.Client: not installed\n'
    fi
else
    warn 'flatpak command is unavailable (Flatpak Spotify cannot be checked)'
fi

if [[ "$native_spotify" -eq 0 && "$flatpak_spotify" -eq 0 ]]; then
    warn 'no Spotify client detected; this is not a build blocker, but MPRIS needs Spotify running'
else
    pass 'at least one supported Spotify client source is installed'
fi

printf '\nSession D-Bus and MPRIS\n'
if pulse_have_command busctl; then
    mpris_names=$(busctl --user list 2>/dev/null || true)
    if printf '%s\n' "$mpris_names" | grep -Eq 'org\.mpris\.MediaPlayer2\.spotify([[:space:]]|\.|$)'; then
        pass 'Spotify MPRIS name is visible on the user session bus'
        printf '  [info] matching names:\n'
        printf '%s\n' "$mpris_names" | grep -E 'org\.mpris\.MediaPlayer2\.spotify([[:space:]]|\.|$)' | sed 's/^/          /' || true
    elif pulse_session_bus_available; then
        warn 'session bus is available, but Spotify MPRIS is not visible (start Spotify and rerun)'
    else
        warn 'session bus is unavailable; start a graphical user session before probing MPRIS'
    fi
else
    warn 'cannot probe MPRIS because busctl is unavailable'
fi

printf '\nPulse paths (resolved, no directories created)\n'
pulse_print_paths

printf '\nSummary\n'
printf '  blockers: %d\n' "$blockers"
printf '  warnings: %d\n' "$warnings"
printf '  Spotify is intentionally optional for scripts/build.sh.\n'
if [[ "$STRICT" -eq 1 && "$warnings" -gt 0 ]]; then
    block '--strict requested and warnings were reported'
fi

if [[ "$blockers" -gt 0 ]]; then
    printf '\nInstall missing Fedora packages manually (this script never installs):\n'
    printf '  sudo dnf install cargo rust glib2-devel gnome-shell systemd dbus-tools\n'
    printf 'Then start Spotify and rerun this doctor to verify its MPRIS name.\n'
    exit 1
fi

if [[ "$warnings" -gt 0 ]]; then
    printf '\nNo hard blockers detected; resolve warnings before enabling the extension.\n'
fi
exit 0
