// Actual daemon + private D-Bus + helper + headless Chromium. Spotify is simulated.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:http';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createProbeServer} from '../experiments/web-playback/server.mjs';

const exec = promisify(execFile);
const {chromium} = await import(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const root = await mkdtemp(join(tmpdir(), 'pulse-gnome-player-'));
const runtime = join(root, 'runtime');
const config = join(root, 'config');
for (const directory of [runtime, join(config, 'pulse'), join(root, 'data'), join(root, 'cache')])
    await mkdir(directory, {recursive: true, mode: 0o700});
const env = {...process.env, HOME: root, XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtime, 'bus')}`, PULSE_PLAYBACK_BACKEND: 'browser'};
let bus, daemon, browser, helper;
let storedToken = 'test-refresh';
const tokenStore = {load: () => storedToken, save: (_id, value) => { storedToken = value; return true; },
    clear: () => { storedToken = null; return true; }};
const makeHelper = () => createProbeServer({port: 0, integration: true, runtimeDir: runtime,
    configHome: config, home: root, clientId: '0123456789abcdef0123456789abcdef', tokenStore,
    fetchImpl: async () => Response.json({access_token: 'test-access', expires_in: 3600}),
});
const listen = server => new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const close = server => new Promise(resolveClose => {
    server.closeAllConnections(); server.close(resolveClose);
});
async function eventually(action, predicate = Boolean, timeoutMs = 15000) {
    const end = Date.now() + timeoutMs;
    let value;
    while (Date.now() < end) {
        try { value = await action(); if (predicate(value)) return value; } catch { /* startup */ }
        await new Promise(resolveWait => setTimeout(resolveWait, 200));
    }
    throw new Error(`Integration condition timed out: ${String(value).slice(0, 300)}`);
}
async function call(method, ...args) {
    const result = await exec('gdbus', ['call', '--session', '--dest', 'io.kanterlabs.Pulse',
        '--object-path', '/io/kanterlabs/Pulse', '--method', `io.kanterlabs.Pulse1.${method}`, ...args],
    {env, timeout: 12000, maxBuffer: 1024 * 1024});
    return result.stdout;
}
const track = {id: '19Shlms2uTnOjIUg50TXzd', uri: 'spotify:track:19Shlms2uTnOjIUg50TXzd',
    name: 'Integration track', artists: [{name: 'Fixture artist'}], album: {name: 'Fixture album', images: []},
    duration_ms: 180000, type: 'track'};
const api = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer test-access');
    const data = request.url.includes('/search') ? {tracks: {items: [track], total: 1, next: null}}
        : request.url.includes('/recently-played') ? {items: [{track}], next: null}
            : request.url.includes('/queue') ? {queue: [track]} : {items: [], next: null};
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify(data));
});
try {
    await listen(api);
    await writeFile(join(config, 'pulse/config.toml'), `[spotify]\napi_base_url = "http://127.0.0.1:${api.address().port}/"\n[server]\npoll_interval_seconds = 1\n`);
    helper = makeHelper();
    await listen(helper);
    const origin = `http://127.0.0.1:${helper.address().port}`;
    bus = spawn('dbus-daemon', ['--session', '--nofork', `--address=${env.DBUS_SESSION_BUS_ADDRESS}`], {env, stdio: 'ignore'});
    await eventually(async () => { await access(join(runtime, 'bus')); return true; });
    browser = await chromium.launch({headless: true,
        ...(process.env.PULSE_CHROMIUM_PATH ? {executablePath: process.env.PULSE_CHROMIUM_PATH} : {})});
    const context = await browser.newContext();
    await context.addInitScript(() => { navigator.requestMediaKeySystemAccess = async () => ({}); });
    await context.route('https://sdk.scdn.co/spotify-player.js', route => route.fulfill({
        contentType: 'text/javascript', body: `
        window.Spotify = {Player: class {
            constructor(options) { this.options = options; this.events = {}; window.fakePlayer = this;
                this.state = {paused:false,position:12000,duration:180000,disallows:{},track_window:{current_track:${JSON.stringify(track)}}}; }
            addListener(name, fn) {this.events[name] = fn;}
            async connect() {await new Promise(done => this.options.getOAuthToken(() => done())); this.events.ready({device_id:'fixture-device'}); this.changed(); return true;}
            disconnect() {}
            changed() {this.events.player_state_changed(this.state);}
            async getCurrentState() {return this.state;}
            async activateElement() {}
            async pause() {this.state.paused = true; this.changed();}
            async resume() {this.state.paused = false; this.changed();}
            async nextTrack() {this.state.track_window.current_track.name='Next integration track'; this.changed();}
            async previousTrack() {this.state.track_window.current_track.name='Integration track'; this.changed();}
            async seek(value) {this.state.position=value; this.changed();}
        }};window.onSpotifyWebPlaybackSDKReady();`,
    }));
    let selectionPlayed = false;
    await context.route('https://api.spotify.com/**', async route => {
        if (route.request().method() === 'PUT') {
            assert.equal(new URL(route.request().url()).searchParams.get('device_id'), 'fixture-device');
            selectionPlayed = true;
        }
        await route.fulfill({status: 204, headers: {'access-control-allow-origin': origin,
            'access-control-allow-methods': 'PUT,OPTIONS', 'access-control-allow-headers': 'authorization,content-type'}});
    });
    const page = await context.newPage();
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.goto(`${origin}/?player=1`);
    daemon = spawn(resolve(process.env.PULSE_TEST_DAEMON || 'target/debug/pulse-daemon'), [], {env, stdio: 'ignore'});
    await eventually(() => call('GetSnapshot'), value => value.includes('Integration track'));
    assert.match(await call('GetAuthState'), /"playback_backend":"browser"/);
    const setup = await context.newPage();
    await setup.goto(origin);
    await setup.getByText('Spotify is connected. You can close this window and use the GNOME panel.').waitFor();
    assert.equal(await setup.evaluate(() => typeof window.Spotify), 'undefined');
    await setup.close();
    await call('PlayPause');
    await eventually(() => call('GetSnapshot'), value => value.includes('"playing":false'));
    await call('PlayPause');
    await eventually(() => call('GetSnapshot'), value => value.includes('"playing":true'));
    await call('Next');
    await eventually(() => call('GetSnapshot'), value => value.includes('Next integration track'));
    await call('Seek', '30000000');
    await eventually(() => call('GetSnapshot'), value => value.includes('"position_us":30000000'));
    assert.match(await call('Search', 'integration'), /Integration track/);
    await call('OpenUri', track.uri);
    assert(selectionPlayed, 'track selection must reach the helper device');
    await page.close();
    await eventually(() => call('GetSnapshot'), value => value.includes('"offline":true'));
    assert.equal(daemon.exitCode, null, 'closing the audio process must not kill the daemon');
    await call('Logout');
    assert.equal(storedToken, null);
    assert.match(await call('GetAuthState'), /"authenticated":false/);
    assert.deepEqual(browserErrors, []);
    console.log('PASS: private D-Bus daemon, helper and headless browser; playback/search/seek/logout; setup closure preserves control; player loss degrades without daemon exit. Spotify and DRM simulated.');
} finally {
    daemon?.kill('SIGTERM');
    bus?.kill('SIGTERM');
    await browser?.close();
    if (helper) await close(helper);
    await close(api);
    await rm(root, {recursive: true, force: true});
}
