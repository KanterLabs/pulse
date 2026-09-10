import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

export const LOOPBACK_HOST = '127.0.0.1';
export const BRIDGE_STATE_TTL_MS = 6_000;
export const BRIDGE_COMMAND_TIMEOUT_MS = 5_000;
export const BRIDGE_COMMAND_QUEUE_LIMIT = 16;

const COMMANDS = new Set(['play_pause', 'next', 'previous', 'seek', 'open_uri']);
const SNAPSHOT_FIELDS = [
  'status', 'title', 'artist', 'album', 'art_url', 'spotify_url', 'length_us',
  'position_us', 'playing', 'can_control', 'can_go_next', 'can_go_previous',
  'can_seek', 'offline', 'error',
];
const ALLOWED_PHASES = new Set(['idle', 'connecting', 'ready', 'offline', 'error']);
const SPOTIFY_URI = /^spotify:(?:track|album|artist|playlist):[A-Za-z0-9]{22}$/;
const ERROR_CODES = new Set([
  'authentication_required', 'bad_request', 'browser_rejected', 'command_expired',
  'command_timeout', 'forbidden', 'invalid_request', 'not_found', 'player_offline',
  'queue_full', 'session_mismatch', 'session_required', 'session_replaced', 'server_restarted',
  'persistence_failed',
]);

function ownUid() {
  if (typeof process.getuid === 'function') return process.getuid();
  try { return userInfo().uid; } catch { return null; }
}

function safeText(value, maximum = 512) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.length > maximum ? text.slice(0, maximum) : text;
}

function safeUrl(value) {
  const text = safeText(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
  } catch { /* Ignore malformed browser metadata. */ }
  return null;
}

function defaultSnapshot(error = null) {
  return {
    status: 'disconnected',
    title: null,
    artist: null,
    album: null,
    art_url: null,
    spotify_url: null,
    length_us: null,
    position_us: null,
    playing: false,
    can_control: false,
    can_go_next: false,
    can_go_previous: false,
    can_seek: false,
    offline: true,
    error: safeText(error, 256),
  };
}

function clampInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return null;
  return value;
}

function trackArtists(track) {
  if (!track || !Array.isArray(track.artists)) return null;
  const names = track.artists.map(artist => safeText(artist?.name, 256)).filter(Boolean);
  return names.length ? names.join(', ') : null;
}

function trackUri(track) {
  const uri = safeText(track?.uri, 512);
  return uri && /^spotify:[A-Za-z0-9:_-]+$/.test(uri) ? uri : null;
}

function stateSnapshot(state, activated) {
  const phase = ALLOWED_PHASES.has(state?.phase) ? state.phase : 'error';
  const track = state?.track && typeof state.track === 'object' ? state.track : null;
  const durationMs = Number(state?.duration);
  const positionMs = Number(state?.position);
  const lengthUs = Number.isFinite(durationMs) && durationMs >= 0
    ? Math.min(Math.floor(durationMs * 1_000), Number.MAX_SAFE_INTEGER) : null;
  let positionUs = Number.isFinite(positionMs) && positionMs >= 0
    ? Math.min(Math.floor(positionMs * 1_000), Number.MAX_SAFE_INTEGER) : null;
  if (lengthUs !== null && positionUs !== null) positionUs = Math.min(positionUs, lengthUs);
  const ready = phase === 'ready';
  const control = ready && Boolean(activated);
  const disallows = state?.disallows && typeof state.disallows === 'object' ? state.disallows : {};
  const playing = ready && state?.paused === false;
  const status = !ready ? 'disconnected' : (playing ? 'playing' : 'paused');
  const error = phase === 'ready' ? null : safeText(state?.message, 256);
  return {
    status,
    title: safeText(track?.name),
    artist: trackArtists(track),
    album: safeText(track?.album?.name),
    art_url: safeUrl(track?.album?.images?.[0]?.url),
    spotify_url: safeUrl(track?.external_urls?.spotify) ?? trackUri(track),
    length_us: lengthUs,
    position_us: positionUs,
    playing,
    can_control: control,
    can_go_next: control && disallows.skipping_next !== true,
    can_go_previous: control && disallows.skipping_prev !== true,
    can_seek: control && lengthUs !== null && disallows.seeking !== true,
    offline: !ready,
    error,
  };
}

function copySnapshot(snapshot) {
  const copy = {};
  for (const field of SNAPSHOT_FIELDS) copy[field] = snapshot[field] ?? null;
  copy.playing = Boolean(snapshot.playing);
  copy.can_control = Boolean(snapshot.can_control);
  copy.can_go_next = Boolean(snapshot.can_go_next);
  copy.can_go_previous = Boolean(snapshot.can_go_previous);
  copy.can_seek = Boolean(snapshot.can_seek);
  copy.offline = Boolean(snapshot.offline);
  return copy;
}

export class BridgeError extends Error {
  constructor(code, status = 400) {
    super(ERROR_CODES.has(code) ? code : 'bad_request');
    this.name = 'BridgeError';
    this.code = ERROR_CODES.has(code) ? code : 'bad_request';
    this.status = status;
  }
}

export function isBridgeError(value) {
  return value instanceof BridgeError || Boolean(value?.code && ERROR_CODES.has(value.code));
}

export function validateBridgeSecret(request, secret) {
  if (!request || typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) return false;
  const value = request.headers?.authorization;
  const prefix = 'Bearer ';
  if (typeof value !== 'string' || !value.startsWith(prefix)) return false;
  const supplied = value.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/.test(supplied)) return false;
  const expected = Buffer.from(secret, 'utf8');
  const actual = Buffer.from(supplied, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function validateRuntimeBase(runtimeBase) {
  if (typeof runtimeBase !== 'string' || !isAbsolute(runtimeBase)) {
    throw new TypeError('XDG_RUNTIME_DIR must be an absolute path');
  }
  if (!existsSync(runtimeBase)) throw new TypeError('XDG_RUNTIME_DIR is unavailable');
  let stats;
  try { stats = lstatSync(runtimeBase); } catch { throw new TypeError('XDG_RUNTIME_DIR is unavailable'); }
  const uid = ownUid();
  if (stats.isSymbolicLink() || !stats.isDirectory() || (uid !== null && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
    throw new TypeError('XDG_RUNTIME_DIR is not a private directory');
  }
  return runtimeBase;
}

function ensurePrivateDirectory(path, mode = 0o700) {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new TypeError('private directory cannot be a symlink');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
  const stats = lstatSync(path);
  const uid = ownUid();
  if (stats.isSymbolicLink() || !stats.isDirectory() || (uid !== null && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
    throw new TypeError('runtime directory is not private');
  }
}

function atomicWrite(path, content, mode) {
  ensurePrivateDirectory(dirname(path), mode === 0o600 ? 0o700 : 0o700);
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', mode);
    writeFileSync(fd, content, { encoding: 'utf8' });
    try { fsyncSync(fd); } catch { /* Some test filesystems do not support fsync. */ }
    chmodSync(temporary, mode);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, mode);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* Already renamed or absent. */ }
  }
}

function readPrivateJson(path) {
  try {
    const stats = lstatSync(path);
    const uid = ownUid();
    if (stats.isSymbolicLink() || !stats.isFile() || (uid !== null && stats.uid !== uid) || (stats.mode & 0o077) !== 0) return null;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function configBase(options = {}) {
  const configured = options.configHome ?? process.env.XDG_CONFIG_HOME;
  if (configured === undefined || configured === '') {
    const home = options.home ?? homedir();
    return home ? join(home, '.config') : null;
  }
  if (!isAbsolute(configured)) return null;
  return configured;
}

function validClientId(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}

function resolveClientId(options = {}) {
  const explicit = options.clientId ?? process.env.PULSE_PROBE_CLIENT_ID;
  if (validClientId(explicit)) return explicit;
  const base = configBase(options);
  if (!base) return '';
  const saved = readPrivateJson(join(base, 'pulse', 'player.json'));
  return validClientId(saved?.clientId) ? saved.clientId : '';
}

export function createSecretToolStore({ spawnSyncImpl = spawnSync, timeoutMs = 5_000 } = {}) {
  const withClient = (operation, clientId, extra = []) => [
    operation,
    ...(operation === 'store' ? ['--label=Pulse background Spotify session'] : []),
    'application', 'pulse-player', 'client-id', clientId, ...extra,
  ];
  const sync = (operation, clientId, input = undefined) => {
    if (!validClientId(clientId)) return null;
    try {
      const result = spawnSyncImpl('secret-tool', withClient(operation, clientId), {
        input, encoding: 'utf8', maxBuffer: 64 * 1024, stdio: ['pipe', 'pipe', 'ignore'], timeout: timeoutMs,
      });
      if (result?.error || result?.status !== 0) return null;
      const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
      return operation === 'lookup' ? (output || null) : true;
    } catch { return null; }
  };
  return {
    load(clientId) { return sync('lookup', clientId); },
    save(clientId, token) {
      if (typeof token !== 'string' || token.length === 0) return false;
      return sync('store', clientId, `${token}\n`) === true;
    },
    clear(clientId) { return sync('clear', clientId) === true; },
    async loadAsync(clientId) {
      return this.load(clientId);
    },
    async saveAsync(clientId, token) {
      return this.save(clientId, token);
    },
    async clearAsync(clientId) {
      return this.clear(clientId);
    },
  };
}

export function persistClientId(options = {}, clientId) {
  if (!validClientId(clientId)) return false;
  const base = configBase(options);
  if (!base) return false;
  try {
    atomicWrite(join(base, 'pulse', 'player.json'), JSON.stringify({ clientId }) + '\n', 0o600);
    return true;
  } catch { return false; }
}

export function createPlayerBridge(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const stateTtlMs = Number.isFinite(options.stateTtlMs) && options.stateTtlMs > 0
    ? Math.floor(options.stateTtlMs) : BRIDGE_STATE_TTL_MS;
  const commandTimeoutMs = Number.isFinite(options.commandTimeoutMs) && options.commandTimeoutMs > 0
    ? Math.floor(options.commandTimeoutMs) : BRIDGE_COMMAND_TIMEOUT_MS;
  const queueLimit = Number.isSafeInteger(options.queueLimit) && options.queueLimit > 0
    ? Math.min(options.queueLimit, BRIDGE_COMMAND_QUEUE_LIMIT) : BRIDGE_COMMAND_QUEUE_LIMIT;
  const secret = options.secret ?? randomBytes(32).toString('hex');
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new TypeError('bridge secret must be 64 hex characters');
  const runtimeBase = options.runtimeDir ?? process.env.XDG_RUNTIME_DIR;
  const enabled = options.enabled !== false;
  if (enabled) validateRuntimeBase(runtimeBase);
  const auth = typeof options.auth === 'function' ? options.auth : () => ({configured: false, authenticated: false});
  const tokenStore = options.tokenStore ?? options.refreshTokenStore ?? createSecretToolStore({
    spawnSyncImpl: options.spawnSyncImpl,
    timeoutMs: options.secretToolTimeoutMs,
  });
  const configOptions = {
    configHome: options.configHome,
    home: options.home,
    clientId: options.clientId,
  };
  const descriptorPath = runtimeBase && isAbsolute(runtimeBase)
    ? join(runtimeBase, 'pulse-player', 'bridge.json') : null;
  let descriptorWritten = false;
  let currentSession = null;
  let generation = 0;
  let latestState = null;
  let latestSnapshot = defaultSnapshot();
  let latestStateAt = 0;
  let queued = [];
  const delivered = new Map();
  let persistenceTail = Promise.resolve();
  let persistenceGeneration = 0;
  let descriptorPort = null;
  let processExitHandler = null;

  const rejectEntry = (entry, code) => {
    clearTimeout(entry.timer);
    if (entry.session === currentSession) delivered.delete(entry.id);
    entry.reject(new BridgeError(code, code === 'command_timeout' ? 504 : 409));
  };

  const rejectAll = code => {
    const entries = [...queued, ...delivered.values()];
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (typeof entry.reject === 'function') rejectEntry(entry, code);
    }
    delivered.clear();
    queued = [];
  };

  const expireQueued = () => {
    const nowMs = now();
    const kept = [];
    for (const command of queued) {
      if (command.expires_at > nowMs) kept.push(command);
      else if (typeof command.reject === 'function') rejectEntry(command, 'command_expired');
    }
    queued = kept;
  };

  const online = () => Boolean(currentSession && latestState &&
    latestStateAt > 0 && now() - latestStateAt <= stateTtlMs &&
    latestState.phase === 'ready');

  const snapshot = () => {
    if (!latestState || !currentSession || latestStateAt <= 0 || now() - latestStateAt > stateTtlMs) {
      return defaultSnapshot();
    }
    return copySnapshot(latestSnapshot);
  };

  const register = () => {
    generation += 1;
    rejectAll('session_replaced');
    currentSession = randomUUID();
    latestState = null;
    latestSnapshot = defaultSnapshot();
    latestStateAt = 0;
    return currentSession;
  };

  const requireSession = session => {
    if (typeof session !== 'string' || !session) throw new BridgeError('session_required', 400);
    if (!currentSession || session !== currentSession) throw new BridgeError('session_mismatch', 409);
  };

  const updateState = ({session, state, activated = false} = {}) => {
    requireSession(session);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new BridgeError('bad_request', 400);
    latestState = {
      ...state,
      phase: ALLOWED_PHASES.has(state.phase) ? state.phase : 'error',
      message: safeText(state.message, 256),
    };
    latestStateAt = now();
    latestSnapshot = stateSnapshot(latestState, Boolean(activated));
    return snapshot();
  };

  const commands = session => {
    requireSession(session);
    expireQueued();
    const current = now();
    const output = [];
    const remaining = [];
    for (const command of queued) {
      if (command.session !== currentSession || command.expires_at <= current) {
        const entry = delivered.get(command.id);
        if (entry) rejectEntry(entry, 'command_expired');
        continue;
      }
      delivered.set(command.id, command);
      output.push({
        id: command.id,
        command: command.command,
        ...(command.position_us === undefined ? {} : {position_us: command.position_us}),
        ...(command.uri === undefined ? {} : {uri: command.uri}),
        expires_at: command.expires_at,
      });
    }
    queued = remaining;
    return output;
  };

  const acknowledge = ({session, id, ok} = {}) => {
    requireSession(session);
    if (typeof id !== 'string' || !id || typeof ok !== 'boolean') throw new BridgeError('bad_request', 400);
    const entry = delivered.get(id);
    if (!entry || entry.session !== currentSession) throw new BridgeError('not_found', 404);
    delivered.delete(id);
    clearTimeout(entry.timer);
    if (ok) entry.resolve(true);
    else entry.reject(new BridgeError('browser_rejected', 502));
    return true;
  };

  const enqueue = ({command, position_us, uri} = {}) => {
    if (!COMMANDS.has(command)) throw new BridgeError('bad_request', 400);
    if (!online()) throw new BridgeError('player_offline', 409);
    if (queued.length + delivered.size >= queueLimit) throw new BridgeError('queue_full', 429);
    if (command === 'seek') {
      if (clampInteger(position_us) === null) throw new BridgeError('bad_request', 400);
    }
    if (command === 'open_uri' && (typeof uri !== 'string' || !SPOTIFY_URI.test(uri))) {
      throw new BridgeError('bad_request', 400);
    }
    if (command !== 'seek' && position_us !== undefined) throw new BridgeError('bad_request', 400);
    if (command !== 'open_uri' && uri !== undefined) throw new BridgeError('bad_request', 400);
    const entry = {
      id: randomUUID().replaceAll('-', '').slice(0, 16),
      command,
      session: currentSession,
      expires_at: now() + commandTimeoutMs,
      ...(command === 'seek' ? {position_us} : {}),
      ...(command === 'open_uri' ? {uri} : {}),
    };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      entry.timer = setTimeout(() => {
        if (queued.includes(entry)) queued = queued.filter(item => item !== entry);
        if (delivered.get(entry.id) === entry) delivered.delete(entry.id);
        reject(new BridgeError('command_timeout', 504));
      }, commandTimeoutMs);
    });
    queued.push(entry);
    return promise;
  };

  const reset = (code = 'server_restarted') => {
    generation += 1;
    rejectAll(code);
    currentSession = null;
    latestState = null;
    latestSnapshot = defaultSnapshot();
    latestStateAt = 0;
  };

  const persist = (operation, clientId, value) => {
    if (!validClientId(clientId) || !tokenStore) return Promise.resolve(true);
    const epoch = persistenceGeneration;
    persistenceTail = persistenceTail.then(async () => {
      if (epoch !== persistenceGeneration) return true;
      const method = tokenStore[operation] ?? tokenStore[`${operation}Async`];
      if (typeof method !== 'function') return true;
      const result = operation === 'clear'
        ? await method.call(tokenStore, clientId)
        : await method.call(tokenStore, clientId, value);
      return result !== false;
    }).catch(() => false);
    return persistenceTail;
  };

  const saveRefreshToken = (clientId, token) => persist('save', clientId, token);
  const clearRefreshToken = clientId => {
    persistenceGeneration += 1;
    return persist('clear', clientId);
  };

  const loadRefreshToken = clientId => {
    if (!validClientId(clientId) || !tokenStore) return null;
    try {
      const method = tokenStore.load ?? tokenStore.loadAsync;
      const value = typeof method === 'function' ? method.call(tokenStore, clientId) : null;
      return typeof value === 'string' ? value : null;
    } catch { return null; }
  };

  const saveClientId = clientId => persistClientId(configOptions, clientId);

  const writeDescriptor = port => {
    if (!enabled) return null;
    if (!descriptorPath || !runtimeBase) throw new TypeError('XDG_RUNTIME_DIR is required for player integration');
    const base = validateRuntimeBase(runtimeBase);
    const directory = join(base, 'pulse-player');
    ensurePrivateDirectory(directory, 0o700);
    atomicWrite(descriptorPath, JSON.stringify({port, secret}) + '\n', 0o600);
    descriptorWritten = true;
    descriptorPort = port;
    return descriptorPath;
  };

  const cleanupDescriptor = () => {
    if (!descriptorWritten || !descriptorPath) return;
    try {
      const value = readPrivateJson(descriptorPath);
      if (value?.secret === secret && value.port === descriptorPort) unlinkSync(descriptorPath);
    } catch { /* The descriptor may have been replaced by a new helper. */ }
    descriptorWritten = false;
    descriptorPort = null;
  };

  const attachServer = server => {
    if (!enabled) return;
    if (!server || typeof server.once !== 'function') throw new TypeError('server is required');
    processExitHandler = () => cleanupDescriptor();
    process.once('exit', processExitHandler);
    server.once('listening', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      if (!Number.isInteger(port) || port <= 0) throw new TypeError('player bridge requires a bound port');
      writeDescriptor(port);
    });
    server.once('close', () => {
      cleanupDescriptor();
      if (processExitHandler) {
        process.removeListener('exit', processExitHandler);
        processExitHandler = null;
      }
      reset('server_restarted');
    });
  };

  const login = async url => ({url});

  return {
    enabled,
    secret,
    descriptorPath,
    stateTtlMs,
    commandTimeoutMs,
    queueLimit,
    attachServer,
    cleanupDescriptor,
    writeDescriptor,
    register,
    updateState,
    commands,
    acknowledge,
    enqueue,
    reset,
    snapshot,
    online,
    login,
    auth,
    get generation() { return generation; },
    get session() { return currentSession; },
    get configuredClientId() { return resolveClientId(configOptions); },
    loadRefreshToken,
    saveRefreshToken,
    clearRefreshToken,
    saveClientId,
    persistIdle() { return persistenceTail; },
    validateRequest(request, port) {
      const expectedHost = `${LOOPBACK_HOST}:${port}`;
      return request?.headers?.host === expectedHost && validateBridgeSecret(request, secret);
    },
  };
}

export { COMMANDS, SNAPSHOT_FIELDS, defaultSnapshot, resolveClientId, validClientId };
export const createBridge = createPlayerBridge;
