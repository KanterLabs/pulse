#!/usr/bin/env bash
# Run the isolated browser experiment; does not install or modify Pulse.
set -Eeuo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    printf '%s\n' 'This playback prototype needs Node.js 22 or newer.' 'On Fedora: sudo dnf install nodejs'
    exit 1
fi
if [[ -r /etc/fedora-release ]]; then
    cat /etc/fedora-release
fi
if command -v gnome-shell >/dev/null 2>&1; then
    gnome-shell --version
fi
printf '%s\n' 'Pulse playback prototype — no extension or daemon files will be changed.' \
    'Keep the player browser tab open. Press Ctrl+C here to end the prototype.'
exec node "$repo_root/experiments/web-playback/server.mjs"
