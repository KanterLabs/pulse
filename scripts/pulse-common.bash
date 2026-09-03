#!/usr/bin/env bash

# Shared, deliberately small helpers for the user-level Pulse scripts.
# This file is sourced by the scripts in this directory; it is not an
# executable entry point.

set -Eeuo pipefail

PULSE_COMMON_CALLER=${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}
PULSE_SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$PULSE_COMMON_CALLER")" && pwd -P)"
PULSE_REPO_ROOT="$(CDPATH='' cd -- "$PULSE_SCRIPT_DIR/.." && pwd -P)"

pulse_info() {
    printf 'pulse: %s\n' "$*"
}

pulse_warn() {
    printf 'pulse: warning: %s\n' "$*" >&2
}

pulse_error() {
    printf 'pulse: error: %s\n' "$*" >&2
}

pulse_die() {
    pulse_error "$*"
    exit 1
}

pulse_require_non_root() {
    if [[ "$(id -u)" -eq 0 ]]; then
        pulse_die 'do not run this script as root; Pulse is installed for the current user'
    fi
    if [[ -z "${HOME:-}" || ! -d "$HOME" ]]; then
        pulse_die 'HOME must point to an existing user home directory'
    fi
}

pulse_require_absolute_path() {
    local name=$1
    local value=$2
    [[ -n "$value" && "$value" == /* ]] ||
        pulse_die "$name must be an absolute path (got: $value)"
}

# XDG variables are required to be absolute by the specification.  Treat a
# relative override as relative to HOME so a copied repository still behaves
# predictably, while making the normalization visible in diagnostics.
pulse_xdg_dir() {
    local variable=$1
    local fallback=$2
    local value=${!variable:-}

    if [[ -z "$value" ]]; then
        value=$fallback
    elif [[ "$value" != /* ]]; then
        value="$HOME/$value"
    fi
    printf '%s\n' "$value"
}

pulse_config_home() {
    pulse_xdg_dir XDG_CONFIG_HOME "$HOME/.config"
}

pulse_data_home() {
    pulse_xdg_dir XDG_DATA_HOME "$HOME/.local/share"
}

pulse_cache_home() {
    pulse_xdg_dir XDG_CACHE_HOME "$HOME/.cache"
}

pulse_state_home() {
    pulse_xdg_dir XDG_STATE_HOME "$HOME/.local/state"
}

pulse_bin_dir() {
    local value=${PULSE_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}
    if [[ "$value" != /* ]]; then
        value="$HOME/$value"
    fi
    printf '%s\n' "$value"
}

pulse_override_path() {
    local variable=$1
    local fallback=$2
    local value=${!variable:-$fallback}
    if [[ "$value" != /* ]]; then
        value="$HOME/$value"
    fi
    printf '%s\n' "$value"
}

pulse_extension_parent() {
    pulse_override_path PULSE_EXTENSION_PARENT "$(pulse_data_home)/gnome-shell/extensions"
}

pulse_extension_dir() {
    printf '%s\n' "$(pulse_extension_parent)/pulse@kanterlabs"
}

pulse_dbus_service_dir() {
    pulse_override_path PULSE_DBUS_SERVICE_DIR "$(pulse_data_home)/dbus-1/services"
}

pulse_systemd_user_dir() {
    pulse_override_path PULSE_SYSTEMD_USER_DIR "$(pulse_config_home)/systemd/user"
}

pulse_config_dir() {
    pulse_override_path PULSE_CONFIG_DIR "$(pulse_config_home)/pulse"
}

pulse_data_dir() {
    pulse_override_path PULSE_DATA_DIR "$(pulse_data_home)/pulse"
}

pulse_cache_dir() {
    pulse_override_path PULSE_CACHE_DIR "$(pulse_cache_home)/pulse"
}

pulse_state_dir() {
    pulse_override_path PULSE_STATE_DIR "$(pulse_state_home)/pulse"
}

pulse_build_root() {
    printf '%s\n' "${PULSE_BUILD_DIR:-$PULSE_REPO_ROOT/target/pulse-build}"
}

pulse_build_profile() {
    printf '%s\n' "${PULSE_BUILD_PROFILE:-release}"
}

pulse_uuid() {
    printf '%s\n' 'pulse@kanterlabs'
}

pulse_bus_name() {
    printf '%s\n' 'io.kanterlabs.Pulse'
}

pulse_unit_name() {
    printf '%s\n' 'pulse-daemon.service'
}

pulse_dbus_service_name() {
    printf '%s\n' 'io.kanterlabs.Pulse.service'
}

pulse_require_command() {
    local command_name=$1
    command -v "$command_name" >/dev/null 2>&1 ||
        pulse_die "required command not found: $command_name"
}

pulse_have_command() {
    command -v "$1" >/dev/null 2>&1
}

pulse_quote_for_display() {
    printf '%q' "$1"
}

pulse_is_dry_run() {
    [[ "${PULSE_DRY_RUN:-0}" == 1 ]]
}

pulse_run() {
    if pulse_is_dry_run; then
        printf '+ '
        printf '%q ' "$@"
        printf '\n'
        return 0
    fi
    "$@"
}

pulse_mkdir() {
    if pulse_is_dry_run; then
        pulse_info "would create directory $(pulse_quote_for_display "$1")"
        return 0
    fi
    mkdir -p -- "$1"
}

pulse_remove_file() {
    local path=$1
    if [[ ! -e "$path" && ! -L "$path" ]]; then
        return 0
    fi
    if pulse_is_dry_run; then
        pulse_info "would remove $(pulse_quote_for_display "$path")"
    else
        rm -f -- "$path"
    fi
}

pulse_remove_tree() {
    local path=$1
    if [[ ! -e "$path" && ! -L "$path" ]]; then
        return 0
    fi
    if pulse_is_dry_run; then
        pulse_info "would remove tree $(pulse_quote_for_display "$path")"
    else
        rm -rf -- "$path"
    fi
}

# Replace a completed staged tree with one move.  The backup lives beside the
# destination so the final rename remains atomic even when /tmp and HOME are
# different filesystems.  The old tree is retained until the new one is in
# place; callers should pass a fully populated source directory.
pulse_replace_tree_atomic() {
    local source=$1
    local destination=$2
    local parent
    local backup=''
    local backup_created=0

    parent=$(dirname -- "$destination")
    mkdir -p -- "$parent"

    if [[ -e "$destination" || -L "$destination" ]]; then
        backup=$(mktemp -d "$parent/.pulse-old.XXXXXX")
        rmdir -- "$backup"
        if ! mv -- "$destination" "$backup"; then
            rmdir -- "$backup" 2>/dev/null || true
            pulse_die "could not stage existing path for replacement: $destination"
        fi
        backup_created=1
    fi

    if mv -- "$source" "$destination"; then
        if [[ "$backup_created" -eq 1 ]]; then
            rm -rf -- "$backup"
        fi
        return 0
    fi

    if [[ "$backup_created" -eq 1 ]]; then
        mv -- "$backup" "$destination" 2>/dev/null ||
            pulse_warn "rollback failed; previous path is at $backup"
    fi
    pulse_die "could not install staged path: $destination"
}

pulse_install_file_atomic() {
    local source=$1
    local destination=$2
    local mode=${3:-0644}
    local parent
    local temporary

    if pulse_is_dry_run; then
        pulse_info "would install $(pulse_quote_for_display "$source") as $(pulse_quote_for_display "$destination")"
        return 0
    fi
    parent=$(dirname -- "$destination")
    mkdir -p -- "$parent"
    temporary=$(mktemp "$parent/.pulse-file.XXXXXX")
    if ! cp -- "$source" "$temporary"; then
        rm -f -- "$temporary"
        pulse_die "could not stage file: $source"
    fi
    chmod "$mode" "$temporary"
    if ! mv -f -- "$temporary" "$destination"; then
        rm -f -- "$temporary"
        pulse_die "could not install file: $destination"
    fi
}

# Refuse to recursively remove a broad or ambiguous location.  This is used
# only for the explicit --purge path in uninstall-user.sh.
pulse_assert_purge_target() {
    local path=$1
    local home_real
    local path_real
    local parent

    pulse_require_absolute_path 'purge target' "$path"
    [[ "$path" != '/' && "$path" != '/.' ]] ||
        pulse_die 'refusing to purge the filesystem root'
    [[ "$path" != "$HOME" && "$path" != "$HOME/" ]] ||
        pulse_die 'refusing to purge HOME itself'
    [[ "$(basename -- "$path")" == pulse ]] ||
        pulse_die "refusing to purge a non-Pulse directory: $path"
    parent=$(dirname -- "$path")
    [[ "$parent" != '/' && "$parent" != "$HOME" ]] ||
        pulse_die "refusing to purge broad path: $path"

    home_real=$(CDPATH='' cd -- "$HOME" && pwd -P)
    if [[ -e "$path" ]]; then
        path_real=$(CDPATH='' cd -- "$path" 2>/dev/null && pwd -P) ||
            pulse_die "cannot resolve purge target: $path"
        [[ "$path_real" != "$home_real" && "$path_real" != '/' ]] ||
            pulse_die "refusing to purge broad path: $path"
    fi
}

pulse_escape_sed_replacement() {
    # The caller uses | as sed's delimiter.
    printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

pulse_escape_service_value() {
    # Service templates quote executable and XDG values.  Escape characters
    # meaningful inside those quotes before escaping the sed replacement.
    printf '%s' "$1" | sed 's/[\\"]/\\&/g'
}

pulse_render_template() {
    local template=$1
    local output=$2
    local executable=$3
    local config_home=$4
    local data_home=$5
    local cache_home=$6
    local escaped_executable
    local escaped_config_home
    local escaped_data_home
    local escaped_cache_home

    [[ -f "$template" ]] || pulse_die "template not found: $template"
    escaped_executable=$(pulse_escape_sed_replacement "$(pulse_escape_service_value "$executable")")
    escaped_config_home=$(pulse_escape_sed_replacement "$(pulse_escape_service_value "$config_home")")
    escaped_data_home=$(pulse_escape_sed_replacement "$(pulse_escape_service_value "$data_home")")
    escaped_cache_home=$(pulse_escape_sed_replacement "$(pulse_escape_service_value "$cache_home")")
    sed \
        -e "s|@PULSE_EXEC@|$escaped_executable|g" \
        -e "s|%h/.local/bin/pulse-daemon|$escaped_executable|g" \
        -e "s|@XDG_CONFIG_HOME@|$escaped_config_home|g" \
        -e "s|%h/.config|$escaped_config_home|g" \
        -e "s|@XDG_DATA_HOME@|$escaped_data_home|g" \
        -e "s|%h/.local/share|$escaped_data_home|g" \
        -e "s|@XDG_CACHE_HOME@|$escaped_cache_home|g" \
        -e "s|%h/.cache|$escaped_cache_home|g" \
        "$template" >"$output"
}

pulse_session_bus_available() {
    if pulse_have_command busctl; then
        busctl --user status >/dev/null 2>&1
        return $?
    fi
    if pulse_have_command dbus-send; then
        dbus-send --session --dest=org.freedesktop.DBus \
            --type=method_call --print-reply \
            /org/freedesktop/DBus org.freedesktop.DBus.ListNames \
            >/dev/null 2>&1
        return $?
    fi
    return 1
}

pulse_user_systemd_available() {
    pulse_have_command systemctl || return 1
    systemctl --user show-environment >/dev/null 2>&1
}

pulse_reload_user_integration() {
    local config_home=$1
    local data_home=$2
    local cache_home=$3

    if pulse_is_dry_run; then
        pulse_info 'would reload the systemd user manager and session D-Bus configuration'
        return 0
    fi

    if pulse_have_command systemctl && pulse_user_systemd_available; then
        if ! systemctl --user daemon-reload; then
            pulse_warn 'systemd user daemon-reload failed; run: systemctl --user daemon-reload'
        fi
        if pulse_have_command dbus-update-activation-environment; then
            if ! dbus-update-activation-environment --systemd \
                "XDG_CONFIG_HOME=$config_home" \
                "XDG_DATA_HOME=$data_home" \
                "XDG_CACHE_HOME=$cache_home"; then
                pulse_warn 'could not update the systemd activation environment'
            fi
        fi
    else
        pulse_warn 'systemd --user manager is unavailable; integration reload was skipped'
    fi

    if pulse_session_bus_available; then
        if pulse_have_command busctl; then
            busctl --user call org.freedesktop.DBus /org/freedesktop/DBus \
                org.freedesktop.DBus ReloadConfig >/dev/null 2>&1 ||
                pulse_warn 'session D-Bus did not accept ReloadConfig; log out/in if activation is stale'
        elif pulse_have_command dbus-send; then
            dbus-send --session --dest=org.freedesktop.DBus \
                --type=method_call --print-reply \
                /org/freedesktop/DBus org.freedesktop.DBus.ReloadConfig \
                >/dev/null 2>&1 ||
                pulse_warn 'session D-Bus did not accept ReloadConfig; log out/in if activation is stale'
        fi
    else
        pulse_warn 'session D-Bus is unavailable; activation reload was skipped'
    fi
}

pulse_print_paths() {
    pulse_info "repository: $PULSE_REPO_ROOT"
    pulse_info "binary: $(pulse_bin_dir)/pulse-daemon"
    pulse_info "extension: $(pulse_extension_dir)"
    pulse_info "D-Bus service: $(pulse_dbus_service_dir)/$(pulse_dbus_service_name)"
    pulse_info "systemd user unit: $(pulse_systemd_user_dir)/$(pulse_unit_name)"
    pulse_info "config (preserved): $(pulse_config_dir)"
    pulse_info "data (preserved): $(pulse_data_dir)"
    pulse_info "cache (preserved): $(pulse_cache_dir)"
}
