import assert from 'node:assert/strict';
import test from 'node:test';
import {PlaybackProbe, trackUri} from '../experiments/web-playback/player-core.mjs';

const uri = 'spotify:track:19Shlms2uTnOjIUg50TXzd';
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
};
function fixture(overrides = {}) {
    const players = [];
    const requests = [];
    const probe = new PlaybackProbe({
        createPlayer: options => {
            const handlers = new Map();
            const calls = [];
            const player = {options, calls, addListener: (name, fn) => handlers.set(name, fn),
                emit: (name, payload) => handlers.get(name)?.(payload),
                connect: async () => true, disconnect: () => calls.push('disconnect'),
                activateElement: async () => calls.push('activate'),
                resume: async () => calls.push('resume'), pause: async () => calls.push('pause'),
                setVolume: async volume => calls.push(['volume', volume]),
                seek: async ms => calls.push(['seek', ms]),
            };
            players.push(player);
            return player;
        },
        getToken: async () => 'test-access',
        fetchImpl: async (...args) => { requests.push(args); return {ok: true}; },
        ...overrides,
    });
    return {probe, players, requests};
}

test('accepts only Spotify track links and track URIs', () => {
    assert.equal(trackUri(uri), uri);
    assert.equal(trackUri('https://open.spotify.com/track/19Shlms2uTnOjIUg50TXzd?si=ignored'), uri);
    for (const invalid of ['https://evil.example/track/19Shlms2uTnOjIUg50TXzd',
        'javascript:alert(1)', 'spotify:album:19Shlms2uTnOjIUg50TXzd', 'https://open.spotify.com.evil/track/a'])
        assert.throws(() => trackUri(invalid));
});

test('retired SDK events and token callbacks cannot change the current session', async () => {
    const token = deferred();
    const {probe, players} = fixture({getToken: () => token.promise});
    await probe.connect();
    let tokenDeliveries = 0;
    players[0].options.getOAuthToken(() => tokenDeliveries++);
    await probe.connect();
    players[1].emit('ready', {device_id: 'new'});
    players[0].emit('ready', {device_id: 'old'});
    players[0].emit('authentication_error', {});
    players[0].emit('player_state_changed', {track_window: {current_track: {name: 'stale'}}});
    token.resolve('test-access');
    await Promise.resolve();
    assert.equal(tokenDeliveries, 0);
    assert.equal(probe.deviceId, 'new');
    assert.equal(probe.state.phase, 'ready');
    assert.equal(probe.state.track, null);
    assert.deepEqual(players[0].calls, ['disconnect']);
});

test('direct playback targets the SDK device and never launches an external application', async () => {
    const {probe, players, requests} = fixture();
    await probe.connect();
    players[0].emit('ready', {device_id: 'own-device'});
    const play = probe.play(uri);
    assert.deepEqual(players[0].calls, ['activate'], 'activate during the user gesture');
    await play;
    assert.equal(requests[0][0], 'https://api.spotify.com/v1/me/player/play?device_id=own-device');
    assert.deepEqual(JSON.parse(requests[0][1].body), {uris: [uri]});
    assert.equal(requests[0][1].headers.Authorization, 'Bearer test-access');
});

test('logout while waiting for a token prevents playback from being sent', async () => {
    const token = deferred();
    const {probe, players, requests} = fixture({getToken: () => token.promise});
    await probe.connect();
    players[0].emit('ready', {device_id: 'device'});
    const pending = probe.play(uri);
    await Promise.resolve();
    probe.disconnect();
    token.resolve('test-access');
    await pending;
    assert.equal(requests.length, 0);
});

test('disconnect aborts in-flight playback and ignores late successful responses', async () => {
    const response = deferred();
    let signal;
    const {probe, players} = fixture({fetchImpl: async (_url, options) => {
        signal = options.signal;
        return response.promise;
    }});
    await probe.connect();
    players[0].emit('ready', {device_id: 'device'});
    const pending = probe.play(uri);
    await new Promise(resolve => setImmediate(resolve));
    probe.disconnect();
    assert.equal(signal.aborted, true);
    response.resolve({ok: true});
    await pending;
    assert.equal(probe.state.phase, 'idle');
    assert.notEqual(probe.state.message, 'Playback requested. Confirm you hear audio from this browser.');
});

test('device loss retires the player; explicit reconnect creates a fresh instance', async () => {
    const {probe, players} = fixture();
    await probe.connect();
    players[0].emit('ready', {device_id: 'first'});
    players[0].emit('not_ready', {});
    assert.equal(probe.state.phase, 'offline');
    await assert.rejects(probe.command('resume'), /not ready/);
    players[0].emit('ready', {device_id: 'stale'});
    assert.equal(probe.deviceId, null);
    await probe.connect();
    players[1].emit('ready', {device_id: 'second'});
    assert.equal(probe.deviceId, 'second');
});

test('resume cannot act on a replacement player after asynchronous activation', async () => {
    const activated = deferred();
    const {probe, players} = fixture();
    await probe.connect();
    players[0].emit('ready', {device_id: 'first'});
    players[0].activateElement = () => activated.promise;
    const pending = probe.command('resume');
    await probe.connect();
    players[1].emit('ready', {device_id: 'second'});
    activated.resolve();
    await pending;
    assert.equal(players[0].calls.includes('resume'), false);
    assert.equal(players[1].calls.includes('resume'), false);
});

test('account failure disconnects and does not surface untrusted SDK error payloads', async () => {
    const {probe, players} = fixture();
    await probe.connect();
    players[0].emit('account_error', {message: 'sensitive untrusted data'});
    assert.equal(probe.state.phase, 'error');
    assert.match(probe.state.message, /Premium/);
    assert.doesNotMatch(probe.state.message, /sensitive/);
    assert.equal(probe.player, null);
});

test('range validation prevents invalid seek and volume SDK calls', async () => {
    const {probe, players} = fixture();
    await probe.connect();
    players[0].emit('ready', {device_id: 'device'});
    probe.state.duration = 10000;
    for (const value of [-1, NaN, Infinity, 10001]) await assert.rejects(probe.command('seek', value));
    for (const value of [-1, NaN, 1.1]) await assert.rejects(probe.command('setVolume', value));
    await probe.command('seek', 5000);
    await probe.command('setVolume', 0.4);
    assert.deepEqual(players[0].calls, [['seek', 5000], ['volume', 0.4]]);
});

test('an SDK connection that never resolves times out and retires its late events', async () => {
    const handlers = new Map();
    let disconnected = false;
    const probe = new PlaybackProbe({connectionTimeoutMs: 10, getToken: async () => 'test',
        createPlayer: () => ({addListener: (name, fn) => handlers.set(name, fn),
            connect: () => new Promise(() => {}), disconnect: () => { disconnected = true; }}),
    });
    await probe.connect();
    assert(disconnected);
    assert.equal(probe.state.phase, 'error');
    handlers.get('ready')({device_id: 'late-device'});
    assert.equal(probe.deviceId, null);
});
