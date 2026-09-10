# Sourced by install-user.sh after its path variables are resolved.

player_preflight() {
    pulse_require_command node
    pulse_require_command python3
    pulse_require_command secret-tool
    if ! pulse_have_command google-chrome-stable && ! pulse_have_command google-chrome; then
        pulse_die 'independent playback requires Google Chrome'
    fi
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' ||
        pulse_die 'independent playback requires Node.js 22 or newer'
    for file in server.mjs bridge.mjs panel.mjs player-core.mjs player.mjs run.mjs index.html style.css; do
        [[ -f "$PULSE_REPO_ROOT/experiments/web-playback/$file" ]] ||
            pulse_die "player source missing: $file"
    done
    pulse_assert_file_destination "$SYSTEMD_DIR/pulse-player.service"
    pulse_assert_file_destination "$SYSTEMD_DIR/pulse-daemon.service.d/50-pulse-player.conf"
    [[ ! -L "$DATA_HOME/pulse/player" ]] || pulse_die 'player code destination must not be a symlink'
}

player_backup() {
    # No database migration occurs. Keep a verified snapshot and previous code
    # before changing installed components; never restore data automatically.
    local backup
    mkdir -p -- "$(pulse_state_dir)/player-backups"
    backup=$(mktemp -d "$(pulse_state_dir)/player-backups/upgrade.XXXXXX")
    chmod 0700 "$backup"
    python3 "$SCRIPT_DIR/player-backup.py" "$backup" "$CONFIG_HOME" "$DATA_HOME" "$BIN_DIR" "$EXTENSION_DIR" "$SYSTEMD_DIR"
    pulse_info "verified pre-upgrade backup: $backup"
}

player_install() {
    local staged
    local unit
    mkdir -p -- "$DATA_HOME/pulse" "$SYSTEMD_DIR/pulse-daemon.service.d"
    staged=$(mktemp -d "$DATA_HOME/pulse/.player-install.XXXXXX")
    for file in server.mjs bridge.mjs panel.mjs player-core.mjs player.mjs run.mjs index.html style.css; do
        cp -- "$PULSE_REPO_ROOT/experiments/web-playback/$file" "$staged/$file"
    done
    chmod 0755 "$staged/run.mjs"
    pulse_replace_tree_atomic "$staged" "$DATA_HOME/pulse/player"
    unit=$(mktemp "$SYSTEMD_DIR/.pulse-player-unit.XXXXXX")
    pulse_render_template "$PULSE_REPO_ROOT/packaging/systemd/pulse-player.service" "$unit" \
        "$DATA_HOME/pulse/player/run.mjs" "$CONFIG_HOME" "$DATA_HOME" "$CACHE_HOME"
    pulse_install_file_atomic "$unit" "$SYSTEMD_DIR/pulse-player.service" 0644
    rm -f -- "$unit"
    pulse_install_file_atomic "$PULSE_REPO_ROOT/packaging/systemd/pulse-browser-backend.conf" \
        "$SYSTEMD_DIR/pulse-daemon.service.d/50-pulse-player.conf" 0644
}
