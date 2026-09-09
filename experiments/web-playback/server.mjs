import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 8888;
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_EXCHANGE_TIMEOUT_MS = 10 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 10 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

const AUTH_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-modify-playback-state',
  'user-read-playback-state',
].join(' ');

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';

const STATIC_FILES = new Map([
  ['/index.html', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/player.mjs', { file: 'player.mjs', contentType: 'text/javascript; charset=utf-8' }],
  ['/player-core.mjs', { file: 'player-core.mjs', contentType: 'text/javascript; charset=utf-8' }],
  ['/style.css', { file: 'style.css', contentType: 'text/css; charset=utf-8' }],
]);

function parsePort(value, fallback = DEFAULT_PORT) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new TypeError('invalid probe port');
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('invalid probe port');
  }
  return port;
}

function validClientId(value) {
  return typeof value === 'string' && /^[0-9a-f]{32}$/i.test(value);
}

function baseHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    ...baseHeaders(),
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    ...baseHeaders(contentType),
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendApiError(response, statusCode, error = 'request_failed') {
  sendJson(response, statusCode, { error });
}

function redirectToRoot(response, status) {
  const location = `/?status=${encodeURIComponent(status)}`;
  response.writeHead(303, {
    ...baseHeaders('text/plain; charset=utf-8'),
    Location: location,
    'Content-Length': 0,
  });
  response.end();
}

function cleanNumber(value, fallback, minimum = 1) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum) {
    throw new TypeError('invalid timeout');
  }
  return Math.floor(number);
}

function parseJsonBody(body) {
  if (body.length === 0) return null;
  try {
    const value = JSON.parse(body);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function accessTokenStillValid(auth, nowMs) {
  if (typeof auth.accessToken !== 'string' || auth.accessToken.length === 0) return false;
  return nowMs < auth.accessExpiresAt;
}

function responseIsSuccessful(response) {
  return response && response.ok !== false &&
    (response.status === undefined || (response.status >= 200 && response.status < 300));
}

async function readResponseJson(response) {
  if (!response || typeof response.json !== 'function') throw new Error('invalid token response');
  const payload = await response.json();
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('invalid token response');
  }
  return payload;
}

function tokenPayload(payload) {
  if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new Error('missing access token');
  }
  const expiresIn = Number(payload.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('missing token expiry');
  return {
    accessToken: payload.access_token,
    accessExpiresInMs: expiresIn * 1000,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
  };
}

function requestBodyLength(request) {
  const header = request.headers['content-length'];
  if (header === undefined) return null;
  if (!/^\d+$/.test(header)) return -1;
  const length = Number(header);
  return Number.isSafeInteger(length) ? length : -1;
}

function headerExactly(request, name, expected) {
  const value = request.headers[name];
  return typeof value === 'string' && value === expected;
}

function serverPort(server, configuredPort) {
  const address = server.address();
  if (address && typeof address === 'object' && Number.isInteger(address.port)) return address.port;
  return configuredPort;
}

function expectedOrigin(server, configuredPort) {
  return `http://${LOOPBACK_HOST}:${serverPort(server, configuredPort)}`;
}

function isApiRequestFromProbe(request, server, configuredPort) {
  if (!headerExactly(request, 'x-pulse-probe', '1')) return false;
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== expectedOrigin(server, configuredPort)) return false;
  if (origin === undefined && request.headers['sec-fetch-site'] !== 'same-origin') return false;
  return true;
}

async function readRequestBody(request) {
  const knownLength = requestBodyLength(request);
  if (knownLength === -1 || (knownLength !== null && knownLength > MAX_BODY_BYTES)) {
    const error = new Error('request body too large');
    error.code = 'BODY_TOO_LARGE';
    throw error;
  }

  return await new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let done = false;

    const finish = (error, value) => {
      if (done) return;
      done = true;
      request.removeListener('aborted', onAborted);
      request.removeListener('error', onError);
      if (error) rejectBody(error);
      else resolveBody(value);
    };
    const onAborted = () => finish(Object.assign(new Error('request aborted'), { code: 'REQUEST_ABORTED' }));
    const onError = () => finish(Object.assign(new Error('request failed'), { code: 'REQUEST_FAILED' }));
    const onData = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.removeListener('data', onData);
        request.resume();
        finish(Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks).toString('utf8'));

    request.on('aborted', onAborted);
    request.on('error', onError);
    request.on('data', onData);
    request.on('end', onEnd);
  });
}

function setResponseTimeout(response, timeoutMs) {
  response.setTimeout(timeoutMs, () => {
    if (!response.headersSent) sendApiError(response, 504, 'request_timeout');
    else response.destroy();
  });
}

function withFetchTimeout(fetchImpl, url, options, timeoutMs, controllers, consumeResponse = value => value) {
  const controller = new AbortController();
  controllers.add(controller);
  let timeout;
  const operation = Promise.resolve()
    .then(() => fetchImpl(url, { ...options, signal: controller.signal }))
    .then(consumeResponse);
  // A fake or broken fetch implementation may resolve headers and leave json()
  // pending. Keep the deadline around the complete response consumption and
  // attach a rejection handler so a late upstream failure cannot be unhandled
  // after the timeout has won the race.
  operation.catch(() => {});
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('upstream timeout'), { code: 'UPSTREAM_TIMEOUT' }));
    }, timeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => {
      clearTimeout(timeout);
      controllers.delete(controller);
    });
}

function validState(state) {
  return typeof state === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(state);
}

function createPkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function safeCallbackStatus(status) {
  return ['success', 'denied', 'error', 'expired'].includes(status) ? status : 'error';
}

export function createProbeServer(options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('options must be an object');

  const configuredPort = parsePort(options.port ?? process.env.PULSE_PROBE_PORT, DEFAULT_PORT);
  const staticDir = resolve(options.staticDir ?? dirname(fileURLToPath(import.meta.url)));
  const stateTtlMs = cleanNumber(options.stateTtlMs ?? options.pendingStateTtlMs, DEFAULT_STATE_TTL_MS);
  const exchangeTimeoutMs = cleanNumber(options.exchangeTimeoutMs ?? options.oauthTimeoutMs, DEFAULT_EXCHANGE_TIMEOUT_MS);
  const refreshTimeoutMs = cleanNumber(options.refreshTimeoutMs, DEFAULT_REFRESH_TIMEOUT_MS);
  const requestTimeoutMs = cleanNumber(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');

  const configuredClientId = options.clientId ?? process.env.PULSE_PROBE_CLIENT_ID;
  const auth = {
    accessExpiresAt: 0,
    accessToken: '',
    clientId: validClientId(configuredClientId) ? configuredClientId : '',
    refreshToken: '',
  };
  const pendingStates = new Map();
  const controllers = new Set();
  let generation = 0;
  let refreshPromise = null;

  const cleanupExpiredStates = () => {
    const nowMs = now();
    for (const [state, pending] of pendingStates) {
      if (nowMs - pending.createdAt >= stateTtlMs) pendingStates.delete(state);
    }
  };

  const clearTokens = () => {
    auth.accessToken = '';
    auth.accessExpiresAt = 0;
    auth.refreshToken = '';
  };

  const invalidate = () => {
    generation += 1;
    clearTokens();
    pendingStates.clear();
    for (const controller of controllers) controller.abort();
    refreshPromise = null;
  };

  const configuredRedirectUri = (server) =>
    `http://${LOOPBACK_HOST}:${serverPort(server, configuredPort)}/callback`;

  const exchangeCode = async (server, pending, code, exchangeGeneration) => {
    const params = new URLSearchParams({
      client_id: pending.clientId,
      code,
      code_verifier: pending.verifier,
      grant_type: 'authorization_code',
      redirect_uri: configuredRedirectUri(server),
    });
    const payload = await withFetchTimeout(fetchImpl, TOKEN_ENDPOINT, {
      body: params,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    }, exchangeTimeoutMs, controllers, async response => {
      if (!responseIsSuccessful(response)) throw new Error('token exchange failed');
      return tokenPayload(await readResponseJson(response));
    });
    if (exchangeGeneration !== generation) return false;
    auth.clientId = pending.clientId;
    auth.accessToken = payload.accessToken;
    auth.accessExpiresAt = now() + payload.accessExpiresInMs;
    auth.refreshToken = payload.refreshToken;
    return true;
  };

  const refreshAccessToken = () => {
    if (refreshPromise) return refreshPromise;
    if (!auth.refreshToken || !auth.clientId) return null;

    const refreshGeneration = generation;
    const refreshToken = auth.refreshToken;
    const params = new URLSearchParams({
      client_id: auth.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const promise = withFetchTimeout(fetchImpl, TOKEN_ENDPOINT, {
      body: params,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    }, refreshTimeoutMs, controllers, async response => {
        if (!responseIsSuccessful(response)) throw new Error('token refresh failed');
        return tokenPayload(await readResponseJson(response));
      })
      .then(payload => {
        if (refreshGeneration !== generation) return false;
        auth.accessToken = payload.accessToken;
        auth.accessExpiresAt = now() + payload.accessExpiresInMs;
        if (payload.refreshToken) auth.refreshToken = payload.refreshToken;
        return true;
      })
      .catch(error => {
        if (refreshGeneration === generation) {
          clearTokens();
        }
        throw error;
      });
    refreshPromise = promise;
    promise.then(
      () => { if (refreshPromise === promise) refreshPromise = null; },
      () => { if (refreshPromise === promise) refreshPromise = null; },
    );
    return promise;
  };

  const server = createServer(async (request, response) => {
    setResponseTimeout(response, requestTimeoutMs);
    const expectedHost = `${LOOPBACK_HOST}:${serverPort(server, configuredPort)}`;
    if (request.headers.host !== expectedHost) {
      sendApiError(response, 400, 'bad_request');
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(request.url ?? '/', `http://${expectedHost}`);
    } catch {
      sendApiError(response, 400, 'bad_request');
      return;
    }
    const pathname = parsedUrl.pathname;
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    if (isApi && !isApiRequestFromProbe(request, server, configuredPort)) {
      sendApiError(response, 403, 'forbidden');
      return;
    }

    try {
      if (isApi) {
        if (pathname === '/api/status' && request.method === 'GET') {
          sendJson(response, 200, {
            authenticated: accessTokenStillValid(auth, now()) ||
              Boolean(auth.refreshToken && auth.clientId),
            clientId: auth.clientId,
          });
          return;
        }

        if (pathname === '/api/login' && request.method === 'POST') {
          const body = parseJsonBody(await readRequestBody(request));
          if (!body || !validClientId(body.clientId)) {
            sendApiError(response, 400, 'invalid_request');
            return;
          }
          // Starting a new login retires every previous exchange/refresh and
          // callback state. A late response from the old session must not
          // populate credentials for this one.
          invalidate();
          const pkce = createPkce();
          const state = randomBytes(32).toString('base64url');
          pendingStates.set(state, {
            clientId: body.clientId,
            createdAt: now(),
            verifier: pkce.verifier,
          });
          auth.clientId = body.clientId;
          clearTokens();
          const authorizeUrl = new URL(AUTHORIZE_ENDPOINT);
          authorizeUrl.search = new URLSearchParams({
            client_id: body.clientId,
            code_challenge: pkce.challenge,
            code_challenge_method: 'S256',
            redirect_uri: configuredRedirectUri(server),
            response_type: 'code',
            scope: AUTH_SCOPES,
            state,
          }).toString();
          sendJson(response, 200, { url: authorizeUrl.toString() });
          return;
        }

        if (pathname === '/api/token' && request.method === 'GET') {
          if (accessTokenStillValid(auth, now())) {
            sendJson(response, 200, { access_token: auth.accessToken });
            return;
          }
          const tokenPromise = refreshAccessToken();
          if (!tokenPromise) {
            sendApiError(response, 401, 'authentication_required');
            return;
          }
          const refreshGeneration = generation;
          let refreshed;
          try {
            refreshed = await tokenPromise;
          } catch {
            sendApiError(response, 401, 'authentication_required');
            return;
          }
          if (refreshGeneration !== generation || !refreshed || !accessTokenStillValid(auth, now())) {
            sendApiError(response, 401, 'authentication_required');
            return;
          }
          sendJson(response, 200, { access_token: auth.accessToken });
          return;
        }

        if (pathname === '/api/logout' && request.method === 'POST') {
          invalidate();
          sendJson(response, 200, { ok: true });
          return;
        }

        sendApiError(response, 404, 'not_found');
        return;
      }

      if (pathname === '/callback' && request.method === 'GET') {
        cleanupExpiredStates();
        const state = parsedUrl.searchParams.get('state');
        const pending = validState(state) ? pendingStates.get(state) : undefined;
        if (!pending) {
          const expiredStatus = state && pendingStates.size > 0 ? 'error' : 'expired';
          redirectToRoot(response, safeCallbackStatus(expiredStatus));
          return;
        }
        pendingStates.delete(state);
        const callbackError = parsedUrl.searchParams.get('error');
        const code = parsedUrl.searchParams.get('code');
        if (callbackError || !code || code.length > 4096) {
          redirectToRoot(response, callbackError === 'access_denied' ? 'denied' : 'error');
          return;
        }
        const exchangeGeneration = generation;
        try {
          const committed = await exchangeCode(server, pending, code, exchangeGeneration);
          redirectToRoot(response, committed ? 'success' : 'error');
        } catch {
          redirectToRoot(response, 'error');
        }
        return;
      }

      const staticFile = request.method === 'GET' || request.method === 'HEAD'
        ? STATIC_FILES.get(pathname === '/' ? '/index.html' : pathname)
        : undefined;
      if (staticFile) {
        try {
          const body = await readFile(join(staticDir, staticFile.file));
          response.writeHead(200, {
            ...baseHeaders(staticFile.contentType),
            'Content-Length': body.length,
          });
          if (request.method === 'HEAD') response.end();
          else response.end(body);
        } catch {
          sendText(response, 404, 'Not found\n');
        }
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendApiError(response, 404, 'not_found');
      } else {
        sendText(response, 404, 'Not found\n');
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error?.code === 'BODY_TOO_LARGE') sendApiError(response, 413, 'request_too_large');
      else if (error?.code === 'REQUEST_ABORTED' || error?.code === 'REQUEST_FAILED') return;
      else sendApiError(response, 400, 'bad_request');
    }
  });

  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs;
  server.keepAliveTimeout = Math.min(requestTimeoutMs, 5_000);
  server.probe = Object.freeze({
    get auth() {
      return {
        authenticated: accessTokenStillValid(auth, now()) ||
          Boolean(auth.refreshToken && auth.clientId),
        clientId: auth.clientId,
      };
    },
    get pendingStateCount() {
      cleanupExpiredStates();
      return pendingStates.size;
    },
  });
  return server;
}

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedFile && invokedFile === resolve(thisFile)) {
  const port = parsePort(process.env.PULSE_PROBE_PORT, DEFAULT_PORT);
  const server = createProbeServer({ port });
  server.once('listening', () => {
    process.stdout.write(`Pulse playback probe listening at http://${LOOPBACK_HOST}:${serverPort(server, port)}/\n`);
  });
  server.once('error', error => {
    if (error?.code === 'EADDRINUSE') {
      process.stderr.write(`Pulse playback probe could not bind http://${LOOPBACK_HOST}:${port}/ (port in use)\n`);
    } else {
      process.stderr.write('Pulse playback probe could not start\n');
    }
    process.exitCode = 1;
  });
  server.listen(port, LOOPBACK_HOST);
}
