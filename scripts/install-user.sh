#!/usr/bin/env bash

# Install Pulse as a native per-user application.  Every destination is under
# the current user's XDG directories (or an explicit PULSE_* override).

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=pulse-common.bash
source "$SCRIPT_DIR/pulse-common.bash"

pulse_require_non_root

PROFILE=${PULSE_BUILD_PROFILE:-release}
NO_BUILD=${PULSE_SKIP_BUILD:-0}
NO_START=${PULSE_NO_START:-0}
ENABLE_EXTENSION=${PULSE_ENABLE_EXTENSION:-0}
DRY_RUN=${PULSE_DRY_RUN:-0}

usage() {
    cat <<'EOF'
Usage: scripts/install-user.sh [options]

Installs Pulse below the current user's XDG directories.  Existing config,
database, tokens, artwork, and other runtime state are never touched.

Options:
  --release             install the release build (default)
  --debug               install the debug build
  --no-build            use an existing target artifact
  --no-start            install files without enabling/starting the daemon
  --enable-extension    activate a fresh install; upgrades require logout/login
  --dry-run             print planned actions without writing or reloading
  -h, --help            show this help

Environment overrides:
  PULSE_DAEMON_BINARY   prebuilt daemon path (implies --no-build)
  PULSE_BIN_DIR         executable directory (default: ~/.local/bin)
  XDG_CONFIG_HOME       user configuration root
  XDG_DATA_HOME         extension, D-Bus, and data root
  XDG_CACHE_HOME        artwork/cache root
  PULSE_BUILD_DIR       staged build root
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
        --no-build)
            NO_BUILD=1
            ;;
        --no-start)
            NO_START=1
            ;;
        --enable-extension)
            ENABLE_EXTENSION=1
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

if [[ "$NO_START" -eq 1 && "$ENABLE_EXTENSION" -eq 1 ]]; then
    pulse_die '--enable-extension cannot be combined with --no-start; remove --no-start or enable the extension manually after installation'
fi

export PULSE_DRY_RUN=$DRY_RUN

CONFIG_HOME=$(pulse_config_home)
DATA_HOME=$(pulse_data_home)
CACHE_HOME=$(pulse_cache_home)
BIN_DIR=$(pulse_bin_dir)
EXTENSION_DIR=$(pulse_extension_dir)
DBUS_DIR=$(pulse_dbus_service_dir)
SYSTEMD_DIR=$(pulse_systemd_user_dir)
BUILD_ROOT=$(pulse_build_root)
if [[ "$BUILD_ROOT" != /* ]]; then
    BUILD_ROOT="$PULSE_REPO_ROOT/$BUILD_ROOT"
fi
TARGET_DIR=${CARGO_TARGET_DIR:-$PULSE_REPO_ROOT/target}
if [[ "$TARGET_DIR" != /* ]]; then
    TARGET_DIR="$PULSE_REPO_ROOT/$TARGET_DIR"
fi

DAEMON_BINARY=${PULSE_DAEMON_BINARY:-}
if [[ -z "$DAEMON_BINARY" ]]; then
    if [[ "$NO_BUILD" -eq 0 ]]; then
        if [[ "$DRY_RUN" -eq 1 ]]; then
            pulse_info "would build the $PROFILE daemon before installation"
        else
            PULSE_BUILD_PROFILE=$PROFILE "$SCRIPT_DIR/build.sh" "--$PROFILE"
        fi
    fi
    if [[ -f "$BUILD_ROOT/$PROFILE/pulse-daemon" ]]; then
        DAEMON_BINARY="$BUILD_ROOT/$PROFILE/pulse-daemon"
    else
        DAEMON_BINARY="$TARGET_DIR/$PROFILE/pulse-daemon"
    fi
fi

if [[ "$DAEMON_BINARY" != /* ]]; then
    DAEMON_BINARY="$PULSE_REPO_ROOT/$DAEMON_BINARY"
fi

# A staged build extension is preferred because it already reflects the same
# profile and source snapshot as the daemon.  A source extension is a useful
# fallback for --no-build developer installs.
EXTENSION_SOURCE=''
if [[ -d "$BUILD_ROOT/$PROFILE/extension/pulse@kanterlabs" ]]; then
    EXTENSION_SOURCE="$BUILD_ROOT/$PROFILE/extension/pulse@kanterlabs"
elif [[ -d "$PULSE_REPO_ROOT/extension/pulse@kanterlabs" ]]; then
    EXTENSION_SOURCE="$PULSE_REPO_ROOT/extension/pulse@kanterlabs"
fi

SYSTEMD_TEMPLATE="$PULSE_REPO_ROOT/packaging/systemd/pulse-daemon.service"
DBUS_TEMPLATE="$PULSE_REPO_ROOT/packaging/dbus/io.kanterlabs.Pulse.service"

pulse_info "repository: $PULSE_REPO_ROOT"
pulse_info "install profile: $PROFILE"
pulse_info "binary destination: $BIN_DIR/pulse-daemon"
pulse_info "extension destination: $EXTENSION_DIR"
pulse_info "D-Bus service destination: $DBUS_DIR/$(pulse_dbus_service_name)"
pulse_info "systemd user unit destination: $SYSTEMD_DIR/$(pulse_unit_name)"
pulse_info "runtime data is preserved under: $CONFIG_HOME/pulse, $DATA_HOME/pulse, and $CACHE_HOME/pulse"

extension_destination_exists=0
if [[ -e "$EXTENSION_DIR" || -L "$EXTENSION_DIR" ]]; then
    extension_destination_exists=1
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
    if [[ -n "${PULSE_DAEMON_BINARY:-}" ]]; then
        pulse_info "would install supplied daemon: $DAEMON_BINARY"
    else
        pulse_info "would install daemon artifact: $DAEMON_BINARY"
    fi
    if [[ -n "$EXTENSION_SOURCE" ]]; then
        pulse_info "would stage extension: $EXTENSION_SOURCE"
    else
        pulse_warn 'extension source is absent; daemon-only install would be used'
    fi
    [[ -f "$SYSTEMD_TEMPLATE" ]] && pulse_info "would render systemd template: $SYSTEMD_TEMPLATE" ||
        pulse_warn "systemd template is absent: $SYSTEMD_TEMPLATE"
    [[ -f "$DBUS_TEMPLATE" ]] && pulse_info "would render D-Bus template: $DBUS_TEMPLATE" ||
        pulse_warn "D-Bus template is absent: $DBUS_TEMPLATE"
    if [[ -n "$EXTENSION_SOURCE" ]]; then
        if [[ "$extension_destination_exists" -eq 1 ]]; then
            pulse_info "would disable the existing GNOME extension before replacing it"
        else
            pulse_info "would ensure the GNOME extension is disabled before installation"
        fi
        if [[ "$ENABLE_EXTENSION" -eq 1 && "$extension_destination_exists" -eq 1 ]]; then
            pulse_info 'would require logout/login before enabling the upgraded extension'
        elif [[ "$ENABLE_EXTENSION" -eq 1 ]]; then
            pulse_info 'would enable the GNOME extension (--enable-extension)'
        else
            pulse_info 'would leave the GNOME extension disabled (pass --enable-extension to activate it)'
        fi
    elif [[ "$ENABLE_EXTENSION" -eq 1 ]]; then
        pulse_warn 'extension source is absent; --enable-extension cannot activate the extension'
    fi
    if [[ "$NO_START" -eq 0 ]]; then
        pulse_info 'would enable/start pulse-daemon.service'
    else
        pulse_info 'would skip pulse-daemon.service activation (--no-start)'
    fi
    exit 0
fi

[[ -f "$DAEMON_BINARY" ]] || pulse_die "daemon binary not found: $DAEMON_BINARY (run scripts/build.sh or pass PULSE_DAEMON_BINARY)"
[[ -x "$DAEMON_BINARY" ]] || pulse_die "daemon binary is not executable: $DAEMON_BINARY"
[[ -f "$SYSTEMD_TEMPLATE" ]] || pulse_die "systemd template not found: $SYSTEMD_TEMPLATE"
[[ -f "$DBUS_TEMPLATE" ]] || pulse_die "D-Bus template not found: $DBUS_TEMPLATE"

BIN_DEST="$BIN_DIR/pulse-daemon"
SYSTEMD_DEST="$SYSTEMD_DIR/$(pulse_unit_name)"
DBUS_DEST="$DBUS_DIR/$(pulse_dbus_service_name)"
pulse_assert_file_destination "$BIN_DEST"
pulse_assert_file_destination "$SYSTEMD_DEST"
pulse_assert_file_destination "$DBUS_DEST"

if [[ "$ENABLE_EXTENSION" -eq 1 && -z "$EXTENSION_SOURCE" ]]; then
    pulse_die '--enable-extension was requested, but no GNOME extension source is available'
fi
if [[ "$ENABLE_EXTENSION" -eq 1 ]] && ! pulse_have_command gnome-extensions; then
    pulse_die 'cannot enable the GNOME extension: gnome-extensions is unavailable; run the installer from a GNOME session or enable pulse@kanterlabs manually after installation'
fi

clear_enabled_extension_setting() {
    local uuid
    local enabled
    local cleaned

    pulse_have_command gsettings || return 1
    uuid=$(pulse_uuid)
    if ! enabled=$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null); then
        return 1
    fi

    # gnome-extensions uses the same GSettings key when GNOME Shell's D-Bus
    # API is unavailable. Remove only this exact UUID and leave every other
    # user extension untouched.
    if [[ "$enabled" == *"'$uuid'"* ]]; then
        cleaned=$(printf '%s\n' "$enabled" |
            sed -e "s/'$uuid', //g" -e "s/, '$uuid'//g" -e "s/'$uuid'//g")
        [[ "$cleaned" != *"'$uuid'"* ]] || return 1
        if ! gsettings set org.gnome.shell enabled-extensions "$cleaned" >/dev/null 2>&1; then
            return 1
        fi
    fi

    enabled=$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null) || return 1
    [[ "$enabled" != *"'$uuid'"* ]]
}

disable_existing_extension() {
    if [[ -z "$EXTENSION_SOURCE" ]]; then
        return 0
    fi

    if pulse_have_command gnome-extensions && gnome-extensions disable "$(pulse_uuid)" >/dev/null 2>&1; then
        if [[ "$extension_destination_exists" -eq 1 ]] && ! pulse_verify_extension_inactive; then
            pulse_die "could not confirm GNOME extension $(pulse_uuid) is inactive; refusing to replace $EXTENSION_DIR"
        fi
        if [[ "$extension_destination_exists" -eq 1 ]]; then
            pulse_info "existing GNOME extension $(pulse_uuid) disabled before replacement"
        else
            pulse_info "GNOME extension $(pulse_uuid) disabled before installation"
        fi
        return 0
    fi

    if [[ "$extension_destination_exists" -eq 1 ]]; then
        pulse_die "could not disable existing GNOME extension $(pulse_uuid); refusing to replace $EXTENSION_DIR. The existing files were left unchanged; disable it from a working GNOME session and retry"
    fi

    if clear_enabled_extension_setting; then
        pulse_warn "could not disable $(pulse_uuid) through GNOME Shell; confirmed its enabled setting is clear through GSettings"
        return 0
    fi

    pulse_die "could not confirm GNOME extension $(pulse_uuid) is disabled; refusing to install $EXTENSION_DIR"
}

verify_extension_active() {
    local info
    local state
    local attempt

    # The CLI reports that Shell accepted the enable request, even if enable()
    # throws or the global extensions switch is off. Check the actual state.
    for ((attempt = 0; attempt < 30; attempt++)); do
        info=$(LC_ALL=C gnome-extensions info "$(pulse_uuid)" 2>/dev/null) || info=''
        state=$(printf '%s\n' "$info" | sed -n 's/^[[:space:]]*State: //p')
        case "$state" in
            ACTIVE|ENABLED) return 0 ;;
            ERROR|OUT_OF_DATE|UNINSTALLED) break ;;
        esac
        sleep 0.1
    done
    pulse_warn "Pulse did not become active (state: ${state:-unavailable})"
    if pulse_have_command gsettings &&
        [[ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)" == true ]]; then
        pulse_warn 'GNOME has turned off user extensions globally; check the Extensions app master switch after installing the repair and logging out/in'
    fi
    return 1
}

# Build each destination in its own parent filesystem.  This is important for
# atomic rename: /tmp may be a different filesystem from the user's home.
atomic_install_extension() {
    local source=$1
    local destination=$2
    local parent
    local staged
    local schema_dir
    local schema_count

    parent=$(dirname -- "$destination")
    mkdir -p -- "$parent"
    staged=$(mktemp -d "$parent/.pulse-extension.XXXXXX")
    if ! cp -a -- "$source/." "$staged/"; then
        rm -rf -- "$staged"
        pulse_die "could not stage GNOME extension: $source"
    fi

    schema_dir="$staged/schemas"
    schema_count=0
    if [[ -d "$schema_dir" ]]; then
        schema_count=$(find "$schema_dir" -maxdepth 1 -type f -name '*.gschema.xml' -print | wc -l)
    fi
    if [[ "$schema_count" -gt 0 ]]; then
        if pulse_have_command glib-compile-schemas; then
            if ! glib-compile-schemas "$schema_dir"; then
                rm -rf -- "$staged"
                pulse_die "could not compile GSettings schemas in: $schema_dir"
            fi
        else
            rm -rf -- "$staged"
            pulse_die 'extension contains GSettings schemas but glib-compile-schemas is unavailable'
        fi
    fi

    pulse_replace_tree_atomic "$staged" "$destination"
}

atomic_install_rendered_file() {
    local template=$1
    local destination=$2
    local mode=$3
    local parent
    local staged

    parent=$(dirname -- "$destination")
    mkdir -p -- "$parent"
    staged=$(mktemp "$parent/.pulse-template.XXXXXX")
    if ! pulse_render_template "$template" "$staged" "$BIN_DIR/pulse-daemon" \
        "$CONFIG_HOME" "$DATA_HOME" "$CACHE_HOME"; then
        rm -f -- "$staged"
        pulse_die "could not render template: $template"
    fi
    if ! chmod "$mode" "$staged"; then
        rm -f -- "$staged"
        pulse_die "could not set permissions on rendered file: $destination"
    fi
    if ! mv -fT -- "$staged" "$destination"; then
        rm -f -- "$staged"
        pulse_die "could not install rendered file: $destination"
    fi
}

disable_existing_extension
mkdir -p -- "$BIN_DIR"
pulse_install_file_atomic "$DAEMON_BINARY" "$BIN_DEST" 0755

if [[ -n "$EXTENSION_SOURCE" ]]; then
    atomic_install_extension "$EXTENSION_SOURCE" "$EXTENSION_DIR"
else
    pulse_warn 'extension source is absent; installed daemon and integration files only'
fi

atomic_install_rendered_file "$SYSTEMD_TEMPLATE" "$SYSTEMD_DEST" 0644
atomic_install_rendered_file "$DBUS_TEMPLATE" "$DBUS_DEST" 0644

pulse_reload_user_integration "$CONFIG_HOME" "$DATA_HOME" "$CACHE_HOME"

if [[ "$NO_START" -eq 0 ]]; then
    if pulse_user_systemd_available; then
        if systemctl --user is-active --quiet "$(pulse_unit_name)"; then
            if systemctl --user restart "$(pulse_unit_name)"; then
                pulse_info 'daemon restarted through systemd --user'
            else
                pulse_warn 'daemon was active but could not be restarted; inspect: systemctl --user status pulse-daemon.service'
            fi
        elif systemctl --user enable --now "$(pulse_unit_name)"; then
            pulse_info 'daemon enabled and started through systemd --user'
        else
            pulse_warn 'daemon could not be enabled/started; inspect with: systemctl --user status pulse-daemon.service'
            pulse_warn 'journal command: journalctl --user -u pulse-daemon.service --since today'
        fi
    else
        pulse_warn 'systemd --user is unavailable; daemon was installed but not started'
    fi

    if [[ -n "$EXTENSION_SOURCE" && "$ENABLE_EXTENSION" -eq 1 ]]; then
        if [[ "$extension_destination_exists" -eq 1 ]]; then
            # GJS keeps imported modules for the life of the Shell process.
            # Enabling here can execute the old code we just replaced, even
            # after a successful disable and even on a second installer run.
            pulse_info 'GNOME extension updated; log out and back in to load the new code'
            pulse_info 'after logging back in, enable Pulse: gnome-extensions enable pulse@kanterlabs'
            pulse_info 'then verify its State is ACTIVE or ENABLED: gnome-extensions info pulse@kanterlabs'
        elif gnome-extensions enable "$(pulse_uuid)" && verify_extension_active; then
            pulse_info 'GNOME extension enabled and verified active'
        else
            if gnome-extensions disable "$(pulse_uuid)" >/dev/null 2>&1; then
                if pulse_verify_extension_inactive; then
                    pulse_die 'GNOME extension could not be activated; it was disabled again and remains installed. Log out and back in, then run: gnome-extensions enable pulse@kanterlabs; verify with: gnome-extensions info pulse@kanterlabs'
                fi
                pulse_die 'GNOME extension could not be enabled and its disabled state could not be confirmed. Inspect it with: gnome-extensions info pulse@kanterlabs; disable it before retrying'
            else
                pulse_die 'GNOME extension could not be enabled and its disabled state could not be confirmed. Inspect it with: gnome-extensions info pulse@kanterlabs; disable it before retrying'
            fi
        fi
    elif [[ -n "$EXTENSION_SOURCE" ]]; then
        pulse_info 'GNOME extension installed but left disabled'
        if [[ "$extension_destination_exists" -eq 1 ]]; then
            pulse_info 'log out and back in before enabling Pulse so GNOME loads the updated code'
            pulse_info 'enable after logging back in: gnome-extensions enable pulse@kanterlabs'
        else
            pulse_info 'enable Pulse once GNOME sees the fresh install: gnome-extensions enable pulse@kanterlabs'
        fi
    fi
else
    if [[ -n "$EXTENSION_SOURCE" ]]; then
        pulse_info 'daemon activation was skipped (--no-start); GNOME extension remains disabled'
        if [[ "$extension_destination_exists" -eq 1 ]]; then
            pulse_info 'log out and back in before enabling Pulse so GNOME loads the updated code'
            pulse_info 'enable after logging back in: gnome-extensions enable pulse@kanterlabs'
        else
            pulse_info 'enable Pulse once GNOME sees the fresh install: gnome-extensions enable pulse@kanterlabs'
        fi
    else
        pulse_info 'daemon activation was skipped (--no-start)'
    fi
fi

pulse_info 'installation complete'
pulse_info 'diagnostics: systemctl --user status pulse-daemon.service'
pulse_info 'daemon logs: journalctl --user -u pulse-daemon.service --since today'
pulse_info 'extension diagnostics: gnome-extensions info pulse@kanterlabs'
pulse_info 'rollback integration: scripts/uninstall-user.sh (runtime data remains preserved)'
