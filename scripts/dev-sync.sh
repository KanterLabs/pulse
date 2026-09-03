#!/usr/bin/env bash

# Fast development loop: build (unless requested otherwise), install the
# staged files atomically, and optionally restart the user daemon.  The
# installer owns all path, schema, and integration handling so this helper
# cannot accidentally erase runtime state.

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=pulse-common.bash
source "$SCRIPT_DIR/pulse-common.bash"

pulse_require_non_root

PROFILE=${PULSE_BUILD_PROFILE:-debug}
NO_BUILD=${PULSE_SKIP_BUILD:-0}
RESTART=${PULSE_DEV_RESTART:-0}
DRY_RUN=${PULSE_DRY_RUN:-0}

usage() {
    cat <<'EOF'
Usage: scripts/dev-sync.sh [options]

Builds a developer artifact and synchronizes it to the per-user installation.
Runtime state is preserved.  The daemon is not restarted unless --restart is
specified.

Options:
  --debug               use the debug build (default)
  --release             use the release build
  --no-build            synchronize an existing staged/target artifact
  --restart             restart pulse-daemon.service after synchronization
  --dry-run             print planned actions without writing or reloading
  -h, --help            show this help
EOF
}

while (($# > 0)); do
    case $1 in
        --debug)
            PROFILE=debug
            ;;
        --release)
            PROFILE=release
            ;;
        --no-build)
            NO_BUILD=1
            ;;
        --restart)
            RESTART=1
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

if [[ "$PROFILE" != release && "$PROFILE" != debug ]]; then
    pulse_die "unsupported build profile: $PROFILE (use release or debug)"
fi

if [[ "$NO_BUILD" -eq 0 ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
        "$SCRIPT_DIR/build.sh" "--$PROFILE" --dry-run
    else
        "$SCRIPT_DIR/build.sh" "--$PROFILE"
    fi
fi

install_args=("$SCRIPT_DIR/install-user.sh" "--$PROFILE" --no-build --no-start)
if [[ "$DRY_RUN" -eq 1 ]]; then
    install_args+=(--dry-run)
fi
"${install_args[@]}"

if [[ "$RESTART" -eq 1 ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
        pulse_info 'would restart pulse-daemon.service through systemd --user'
    elif pulse_user_systemd_available; then
        if systemctl --user restart "$(pulse_unit_name)"; then
            pulse_info 'daemon restarted'
        else
            pulse_warn 'daemon restart failed; inspect: systemctl --user status pulse-daemon.service'
        fi
    else
        pulse_warn 'systemd --user is unavailable; daemon was not restarted'
    fi
fi

pulse_info 'development synchronization complete'
