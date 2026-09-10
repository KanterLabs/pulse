import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createProbeServer } from '../experiments/web-playback/server.mjs';
import { createSecretToolStore } from '../experiments/web-playback/bridge.mjs';

const CLIENT_ID = '0123456789abcdef0123456789abcdef';
const servers = new Set();
const fixtures = new Set();

afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  })));
  servers.clear();
  for (const directory of fixtures) rmSync(directory, {recursive: true, force: true});
  fixtures.clear();
});

function responseJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: {'content-type': 'application/json'}, status,
  });
}

async function start(options = {}) {
  const directory = mkdtempSync(join(process.cwd(), '.player-bridge-test-'));
  fixtures.add(directory);
  const server = createProbeServer({
    port: 0,
    integration: true,
    runtimeDir: directory,
    configHome: directory,
    openSetup: () => true,
    ...options,
  });
  servers.add(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const descriptorPath = join(directory, 'pulse-player', 'bridge.json');
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  return {directory, descriptor, descriptorPath, port, server};
}

function api(port, pathname, {body, method = 'GET', ...options} = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      'X-Pulse-Probe': '1',
      Origin: `http://127.0.0.1:${port}`,
      ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      ...(options.headers ?? {}),
    },
    method,
  });
}

function bridge(port, secret, pathname, {body, method = 'GET', ...options} = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      ...(options.headers ?? {}),
    },
    method,
  });
}

async function register(port) {
  return (await (await api(port, '/api/player/register', {method: 'POST', body: {}})).json()).session;
}

async function ready(port, session, activated = true) {
  const response = await api(port, '/api/player/state', {
    body: {activated, session, state: {
      duration: 120_000,
      message: 'Ready.',
      paused: false,
      phase: 'ready',
      position: 100,
      track: {
        album: {images: [{url: 'https://images.example/art.jpg'}], name: 'Album'},
        artists: [{name: 'Artist'}],
        external_urls: {spotify: 'https://open.spotify.com/track/example'},
        name: 'Track',
        uri: 'spotify:track:example',
      },
    }},
    method: 'POST',
  });
  assert.equal(response.status, 200);
}

test('integration descriptor is private and bridge auth requires exact host and bearer secret', async () => {
  const {descriptor, descriptorPath, port, server} = await start();
  assert.equal(descriptor.port, port);
  assert.match(descriptor.secret, /^[0-9a-f]{64}$/);
  assert.equal(statSync(descriptorPath).mode & 0o777, 0o600);

  const missing = await fetch(`http://127.0.0.1:${port}/bridge/auth`);
  assert.equal(missing.status, 401);
  const wrong = await bridge(port, '0'.repeat(64), '/bridge/auth');
  assert.equal(wrong.status, 401);
  const authenticated = await bridge(port, descriptor.secret, '/bridge/auth');
  assert.equal(authenticated.status, 200);
  assert.deepEqual(await authenticated.json(), {configured: false, authenticated: false});
  assert.equal(authenticated.headers.get('access-control-allow-origin'), null);
  await new Promise(resolve => server.close(resolve));
  assert.equal(statSync(descriptorPath, {throwIfNoEntry: false}), undefined);
});

test('heartbeat capability boundary and stale/offline commands', async () => {
  const {port, descriptor} = await start();
  const session = await register(port);
  await ready(port, session, false);
  const limited = await bridge(port, descriptor.secret, '/bridge/snapshot');
  const limitedSnapshot = await limited.json();
  assert.equal(limitedSnapshot.status, 'playing');
  assert.equal(limitedSnapshot.can_control, false);
  assert.equal(limitedSnapshot.can_seek, false);

  await api(port, '/api/player/state', {
    body: {activated: true, session, state: {message: 'Player offline.', paused: true, phase: 'offline'}},
    method: 'POST',
  });
  const offline = await bridge(port, descriptor.secret, '/bridge/snapshot');
  assert.deepEqual(await offline.json(), {
    status: 'disconnected', title: null, artist: null, album: null, art_url: null,
    spotify_url: null, length_us: null, position_us: null, playing: false,
    can_control: false, can_go_next: false, can_go_previous: false, can_seek: false,
    offline: true, error: 'Player offline.',
  });
  const rejected = await bridge(port, descriptor.secret, '/bridge/command', {
    body: {command: 'next'}, method: 'POST',
  });
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), {error: 'player_offline'});
});

test('commands are bounded, consume once, acknowledge, and time out', async () => {
  const {port, descriptor} = await start({commandTimeoutMs: 40});
  const session = await register(port);
  await ready(port, session);
  const pending = bridge(port, descriptor.secret, '/bridge/command', {
    body: {command: 'seek', position_us: 10_000}, method: 'POST',
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  const delivered = await (await api(port, `/api/player/commands?session=${session}`)).json();
  assert.equal(delivered.commands.length, 1);
  assert.equal(delivered.commands[0].command, 'seek');
  assert.ok(delivered.commands[0].expires_at > Date.now());
  assert.deepEqual(await (await api(port, `/api/player/commands?session=${session}`)).json(), {commands: []});
  const acknowledged = await api(port, '/api/player/ack', {
    body: {id: delivered.commands[0].id, ok: true, session}, method: 'POST',
  });
  assert.equal(acknowledged.status, 200);
  assert.deepEqual(await (await pending).json(), {ok: true});

  const timeout = await bridge(port, descriptor.secret, '/bridge/command', {
    body: {command: 'next'}, method: 'POST',
  });
  assert.equal(timeout.status, 504);
  assert.deepEqual(await timeout.json(), {error: 'command_timeout'});
});

test('session replacement and logout invalidate old events and pending commands', async () => {
  const {port, descriptor} = await start({commandTimeoutMs: 200});
  const oldSession = await register(port);
  await ready(port, oldSession);
  const pending = bridge(port, descriptor.secret, '/bridge/command', {
    body: {command: 'next'}, method: 'POST',
  });
  const currentSession = await register(port);
  assert.notEqual(currentSession, oldSession);
  assert.deepEqual(await (await pending).json(), {error: 'session_replaced'});
  const staleState = await api(port, '/api/player/state', {
    body: {activated: true, session: oldSession, state: {phase: 'ready'}}, method: 'POST',
  });
  assert.equal(staleState.status, 409);
  await ready(port, currentSession);
  const logout = await bridge(port, descriptor.secret, '/bridge/logout', {method: 'POST'});
  assert.equal(logout.status, 200);
  assert.equal((await (await bridge(port, descriptor.secret, '/bridge/snapshot')).json()).offline, true);
  const staleAck = await api(port, '/api/player/ack', {
    body: {id: 'unknown', ok: true, session: currentSession}, method: 'POST',
  });
  assert.equal(staleAck.status, 409);
});

test('integrated OAuth requests extra scopes and serialized persistence does not resurrect logout', async () => {
  const calls = [];
  const store = {
    clear: async clientId => { calls.push(['clear', clientId]); return true; },
    load: () => null,
    save: async (clientId, token) => { calls.push(['save', clientId, token]); return true; },
  };
  const fakeFetch = async (_url, init) => {
    calls.push(['fetch', new URLSearchParams(init.body).get('grant_type')]);
    return responseJson({access_token: 'access', expires_in: 3600, refresh_token: 'refresh'});
  };
  const {port, descriptor, server} = await start({fetchImpl: fakeFetch, tokenStore: store});
  const login = await api(port, '/api/login', {body: {clientId: CLIENT_ID}, method: 'POST'});
  const authorize = new URL((await login.json()).url);
  for (const scope of ['user-library-read', 'user-read-recently-played', 'playlist-read-private',
    'playlist-read-collaborative', 'user-read-currently-playing'])
    assert.ok(authorize.searchParams.get('scope').split(' ').includes(scope), scope);
  const callback = await api(port, `/callback?state=${authorize.searchParams.get('state')}&code=code`, {
    headers: {Origin: `http://127.0.0.1:${port}`},
    method: 'GET',
    redirect: 'manual',
  });
  assert.equal(callback.status, 303);
  await server.probe.bridge.persistIdle();
  assert.ok(calls.some(call => call[0] === 'save' && call[2] === 'refresh'));
  const logout = await bridge(port, descriptor.secret, '/bridge/logout', {method: 'POST'});
  assert.equal(logout.status, 200);
  await server.probe.bridge.persistIdle();
  assert.equal(calls.at(-1)[0], 'clear');
  const token = await bridge(port, descriptor.secret, '/bridge/token');
  assert.equal(token.status, 401);
});

test('Secret Service receives refresh tokens on stdin and never in process arguments', () => {
  const calls = [];
  const store = createSecretToolStore({spawnSyncImpl: (program, args, options) => {
    calls.push({program, args, input: options.input, timeout: options.timeout});
    return {status: 0, stdout: args[0] === 'lookup' ? 'restored-token\n' : ''};
  }});
  assert.equal(store.save(CLIENT_ID, 'private-refresh-token'), true);
  assert.equal(store.load(CLIENT_ID), 'restored-token');
  assert.equal(store.clear(CLIENT_ID), true);
  assert.equal(calls[0].program, 'secret-tool');
  assert.ok(calls[0].args.includes('--label=Pulse background Spotify session'));
  assert.equal(calls[0].input, 'private-refresh-token\n');
  for (const call of calls)
    assert.equal(call.args.includes('private-refresh-token'), false);
  assert.ok(calls.every(call => call.timeout === 5000));
});

test('logout reports a failed persistent-token deletion after retiring memory state', async () => {
  const store = {load: () => 'stored-refresh', clear: () => false, save: () => true};
  const {port, descriptor} = await start({clientId: CLIENT_ID, tokenStore: store});
  const logout = await bridge(port, descriptor.secret, '/bridge/logout', {method: 'POST'});
  assert.equal(logout.status, 503);
  assert.deepEqual(await logout.json(), {error: 'persistence_failed'});
  const token = await bridge(port, descriptor.secret, '/bridge/token');
  assert.equal(token.status, 401, 'memory session must remain retired even when keyring deletion fails');
});

test('a failed refresh-token save never publishes an authenticated memory session', async () => {
  const store = {load: () => null, clear: () => true, save: () => false};
  const fakeFetch = async () => responseJson({
    access_token: 'must-not-be-published', expires_in: 3600, refresh_token: 'must-be-persisted',
  });
  const {port, descriptor} = await start({fetchImpl: fakeFetch, tokenStore: store});
  const login = await api(port, '/api/login', {body: {clientId: CLIENT_ID}, method: 'POST'});
  const authorize = new URL((await login.json()).url);
  const callback = await api(port, `/callback?state=${authorize.searchParams.get('state')}&code=code`, {
    method: 'GET', redirect: 'manual',
  });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/?status=error');
  const auth = await bridge(port, descriptor.secret, '/bridge/auth');
  assert.deepEqual(await auth.json(), {configured: true, authenticated: false});
  const token = await bridge(port, descriptor.secret, '/bridge/token');
  assert.equal(token.status, 401);
});
