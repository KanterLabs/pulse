#!/usr/bin/env bash

# Build the Rust daemon and prepare an installable, compiled extension tree.
# The output is kept below target/ and is safe to regenerate at any time.

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=pulse-common.bash
source "$SCRIPT_DIR/pulse-common.bash"

pulse_require_non_root

PROFILE=${PULSE_BUILD_PROFILE:-release}
DRY_RUN=${PULSE_DRY_RUN:-0}
CARGO_COMMAND=${CARGO:-cargo}

usage() {
    cat <<'EOF'
Usage: scripts/build.sh [--release|--debug] [--dry-run]

Builds the Pulse daemon and stages the GNOME extension under target/pulse-build.
The Spotify client is not a build prerequisite. Use --debug for a faster
developer build; --release is the default.

Environment overrides:
  CARGO                 Cargo executable (default: cargo)
  CARGO_TARGET_DIR      Cargo target directory
  PULSE_BUILD_DIR       staged artifact directory
  PULSE_BUILD_PROFILE   release or debug
EOF
}

while (($# > 0)); do
    case $1 in
        --release)
            PROFILE=release
            ;;
        --debug)
            PROFILE=debug
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

BUILD_ROOT=$(pulse_build_root)
if [[ "$BUILD_ROOT" != /* ]]; then
    BUILD_ROOT="$PULSE_REPO_ROOT/$BUILD_ROOT"
fi
TARGET_DIR=${CARGO_TARGET_DIR:-$PULSE_REPO_ROOT/target}
if [[ "$TARGET_DIR" != /* ]]; then
    TARGET_DIR="$PULSE_REPO_ROOT/$TARGET_DIR"
fi
DAEMON_BINARY="$TARGET_DIR/$PROFILE/pulse-daemon"
EXTENSION_SOURCE="$PULSE_REPO_ROOT/extension/pulse@kanterlabs"

pulse_info "repository: $PULSE_REPO_ROOT"
pulse_info "profile: $PROFILE"
pulse_info "daemon output: $DAEMON_BINARY"
pulse_info "staged output: $BUILD_ROOT/$PROFILE"

if [[ "$DRY_RUN" -eq 1 ]]; then
    pulse_info "would run: $(pulse_quote_for_display "$CARGO_COMMAND") build --workspace --manifest-path $(pulse_quote_for_display "$PULSE_REPO_ROOT/Cargo.toml")$( [[ "$PROFILE" == release ]] && printf ' --release' )"
    if [[ -d "$EXTENSION_SOURCE" ]]; then
        pulse_info "would stage extension: $EXTENSION_SOURCE"
        if pulse_have_command glib-compile-schemas; then
            pulse_info 'would compile GSettings schemas in the staged extension'
        else
            pulse_warn 'glib-compile-schemas is not installed; schema compilation would be unavailable'
        fi
    else
        pulse_warn "extension source is absent; daemon-only build is still supported"
    fi
    exit 0
fi

pulse_require_command "$CARGO_COMMAND"
[[ -f "$PULSE_REPO_ROOT/Cargo.toml" ]] || pulse_die "Cargo manifest not found: $PULSE_REPO_ROOT/Cargo.toml"

build_args=(build --workspace --manifest-path "$PULSE_REPO_ROOT/Cargo.toml")
if [[ "$PROFILE" == release ]]; then
    build_args+=(--release)
fi

pulse_info 'building Rust workspace (Spotify is not required)'
(
    cd -- "$PULSE_REPO_ROOT"
    "$CARGO_COMMAND" "${build_args[@]}"
)

[[ -f "$DAEMON_BINARY" ]] || pulse_die "Cargo completed but daemon binary was not found: $DAEMON_BINARY"
[[ -x "$DAEMON_BINARY" ]] || chmod 0755 "$DAEMON_BINARY"

BUILD_PARENT=$(dirname -- "$BUILD_ROOT/$PROFILE")
mkdir -p -- "$BUILD_PARENT"
stage=$(mktemp -d "$BUILD_PARENT/.pulse-build.XXXXXX")
cleanup() {
    if [[ -n "${stage:-}" && -d "$stage" ]]; then
        rm -rf -- "$stage"
    fi
}
trap cleanup EXIT

install -m 0755 -- "$DAEMON_BINARY" "$stage/pulse-daemon"

if [[ -d "$EXTENSION_SOURCE" ]]; then
    mkdir -p -- "$stage/extension/pulse@kanterlabs"
    cp -a -- "$EXTENSION_SOURCE/." "$stage/extension/pulse@kanterlabs/"

    schema_dir="$stage/extension/pulse@kanterlabs/schemas"
    schema_count=0
    if [[ -d "$schema_dir" ]]; then
        schema_count=$(find "$schema_dir" -maxdepth 1 -type f -name '*.gschema.xml' -print | wc -l)
    fi
    if [[ "$schema_count" -gt 0 ]]; then
        if pulse_have_command glib-compile-schemas; then
            glib-compile-schemas "$schema_dir"
        else
            pulse_die 'extension contains GSettings schemas but glib-compile-schemas is unavailable'
        fi
    fi
else
    pulse_warn "extension source is absent; staging daemon only"
fi

printf 'profile=%s\n' "$PROFILE" >"$stage/manifest"
printf 'built_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$stage/manifest"

# The staged tree is complete before it becomes visible to install-user.sh.
pulse_replace_tree_atomic "$stage" "$BUILD_ROOT/$PROFILE"
stage=''
trap - EXIT

pulse_info 'build complete'
pulse_info "use scripts/install-user.sh --no-build to install this staged build"
