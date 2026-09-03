#!/usr/bin/env bash

# Remove Pulse integration files for the current user.  Runtime state is
# intentionally retained unless --purge is supplied explicitly.

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=pulse-common.bash
source "$SCRIPT_DIR/pulse-common.bash"

pulse_require_non_root

PURGE=0
DRY_RUN=${PULSE_DRY_RUN:-0}

usage() {
    cat <<'EOF'
Usage: scripts/uninstall-user.sh [--purge] [--dry-run]

Removes Pulse's per-user binary, GNOME extension, D-Bus activation file, and
systemd user unit.  Config, database, refresh-token storage, artwork, and
other runtime state are preserved by default.

Options:
  --purge       additionally remove config, data, cache, and state directories
  --dry-run     print planned actions without writing or reloading
  -h, --help    show this help

The --purge flag is the only operation that removes runtime data.
Environment path overrides used at install time must be supplied again when
uninstalling (for example XDG_DATA_HOME or PULSE_BIN_DIR).
EOF
}

while (($# > 0)); do
    case $1 in
        --purge)
            PURGE=1
            ;;
        --dry-run)
            DRY_RUN=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            pulse_error "unknown option: $1"
            usage >&2
            exit 2
            ;;
    esac
    shift
done

export PULSE_DRY_RUN=$DRY_RUN

CONFIG_DIR=$(pulse_config_dir)
DATA_DIR=$(pulse_data_dir)
CACHE_DIR=$(pulse_cache_dir)
STATE_DIR=$(pulse_state_dir)
BIN_PATH="$(pulse_bin_dir)/pulse-daemon"
EXTENSION_PATH=$(pulse_extension_dir)
DBUS_PATH="$(pulse_dbus_service_dir)/$(pulse_dbus_service_name)"
SYSTEMD_PATH="$(pulse_systemd_user_dir)/$(pulse_unit_name)"

if [[ "$PURGE" -eq 1 ]]; then
    pulse_assert_purge_target "$CONFIG_DIR"
    pulse_assert_purge_target "$DATA_DIR"
    pulse_assert_purge_target "$CACHE_DIR"
    pulse_assert_purge_target "$STATE_DIR"
fi

pulse_info 'stopping Pulse integration for the current user'
if [[ "$DRY_RUN" -eq 1 ]]; then
    pulse_info 'would disable and stop pulse-daemon.service'
elif pulse_user_systemd_available; then
    systemctl --user disable --now "$(pulse_unit_name)" >/dev/null 2>&1 ||
        pulse_warn 'pulse-daemon.service was not enabled or could not be stopped'
else
    pulse_warn 'systemd --user is unavailable; remove any manually started daemon before uninstalling'
fi

if pulse_have_command gnome-extensions; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
        pulse_info 'would disable pulse@kanterlabs in GNOME'
    else
        gnome-extensions disable "$(pulse_uuid)" >/dev/null 2>&1 || true
    fi
fi

pulse_remove_file "$BIN_PATH"
pulse_remove_tree "$EXTENSION_PATH"
pulse_remove_file "$DBUS_PATH"
pulse_remove_file "$SYSTEMD_PATH"

pulse_reload_user_integration "$(pulse_config_home)" "$(pulse_data_home)" "$(pulse_cache_home)"

if [[ "$PURGE" -eq 1 ]]; then
    pulse_info 'purging explicitly requested runtime state'
    pulse_remove_tree "$CONFIG_DIR"
    pulse_remove_tree "$DATA_DIR"
    pulse_remove_tree "$CACHE_DIR"
    pulse_remove_tree "$STATE_DIR"
else
    pulse_info 'runtime state was preserved (config, database, tokens, artwork, and cache)'
    pulse_info "to remove it later, rerun: $SCRIPT_DIR/uninstall-user.sh --purge"
fi

pulse_info 'uninstall complete'
