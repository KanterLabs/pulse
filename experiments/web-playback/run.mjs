#!/usr/bin/env node
// User-service entrypoint. The Chrome process is always headless.
import {accessSync, constants, existsSync, mkdirSync, statSync} from 'node:fs';
import {join, isAbsolute} from 'node:path';
import {spawn, execFileSync} from 'node:child_process';

if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error('Pulse player requires Node.js 22 or newer.');
    process.exit(1);
}
const home = process.env.HOME;
const dataHome = process.env.XDG_DATA_HOME || join(home, '.local/share');
const configHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
const runtimeHome = process.env.XDG_RUNTIME_DIR;
if (!isAbsolute(dataHome) || !isAbsolute(configHome) || !runtimeHome || !isAbsolute(runtimeHome)) {
    console.error('Pulse player requires absolute XDG directories and a user runtime directory.');
    process.exit(1);
}
const candidates = process.env.PULSE_CHROME_BINARY ? [process.env.PULSE_CHROME_BINARY]
    : (process.env.PATH || '/usr/bin:/bin').split(':').flatMap(directory =>
        ['google-chrome-stable', 'google-chrome'].map(name => join(directory, name)));
const chrome = candidates.find(path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
});
if (!chrome) {
    console.error('Google Chrome is required for Pulse background playback.');
    process.exit(1);
}
// Reuse only the public ID from an existing daemon configuration, never tokens.
if (!process.env.PULSE_PROBE_CLIENT_ID && !existsSync(join(configHome, 'pulse/player.json'))) {
    try {
        const id = execFileSync('python3', ['-c',
            'import sys,tomllib; print(tomllib.load(open(sys.argv[1],"rb")).get("spotify",{}).get("client_id",""))',
            join(configHome, 'pulse/config.toml')], {encoding: 'utf8', timeout: 2000,
            maxBuffer: 1024, stdio: ['ignore', 'pipe', 'ignore']}).trim();
        if (/^[a-f0-9]{32}$/i.test(id)) process.env.PULSE_PROBE_CLIENT_ID = id;
    } catch { /* A fresh installation configures the public ID in the setup page. */ }
}
process.env.PULSE_PLAYER_INTEGRATION = '1';
const {createProbeServer} = await import('./server.mjs');
const profile = join(dataHome, 'pulse/player-profile');
mkdirSync(profile, {recursive: true, mode: 0o700});
const profileStat = statSync(profile);
if (profileStat.uid !== process.getuid() || (profileStat.mode & 0o077) !== 0) {
    console.error('Pulse player profile must be private to the current user (mode 0700).');
    process.exit(1);
}
const server = createProbeServer();
let child;
let stopping = false;
function stop(code) {
    if (stopping) return;
    stopping = true;
    child?.kill('SIGTERM');
    server.closeAllConnections();
    server.close(() => { process.exitCode = code; });
    // systemd additionally owns the complete Chrome process group.
    setTimeout(() => { child?.kill('SIGKILL'); process.exit(code); }, 5000).unref();
}
process.once('SIGTERM', () => stop(0));
process.once('SIGINT', () => stop(0));
server.once('error', () => {
    console.error('Pulse player could not start its local connection. Check whether port 8888 is in use.');
    stop(1);
});
server.once('listening', () => {
    const {port} = server.address();
    child = spawn(chrome, [
        '--headless=new', '--no-first-run', '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/?player=1`,
    ], {stdio: 'ignore'});
    child.once('error', () => {
        console.error('Pulse could not launch its background audio process.');
        stop(1);
    });
    child.once('exit', () => {
        if (!stopping) {
            console.error('Pulse background audio process exited; restarting the player service.');
            stop(1);
        }
    });
    console.error('Pulse background player started. Control playback from the GNOME panel.');
});
const port = Number(process.env.PULSE_PROBE_PORT || 8888);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Pulse player port must be between 1 and 65535.');
    process.exit(1);
}
server.listen(port, '127.0.0.1');
