import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, test } from 'node:test';

import { createProbeServer } from '../experiments/web-playback/server.mjs';

const CLIENT_ID = '0123456789abcdef0123456789abcdef';
const CALLBACK_CODE = 'test-code-only';
const runningServers = new Set();

afterEach(async () => {
  await Promise.all([...runningServers].map(server => closeServer(server)));
  runningServers.clear();
});

function responseJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function startServer(options = {}) {
  const server = createProbeServer({ port: 0, ...options });
  runningServers.add(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { port: server.address().port, server };
}

async function request(port, pathname, {
  body,
  headers = {},
  method = 'GET',
  omitOrigin = false,
  origin = `http://127.0.0.1:${port}`,
  probe = true,
  redirect = 'manual',
  secFetchSite = 'same-origin',
} = {}) {
  const requestHeaders = {
    ...(probe ? { 'X-Pulse-Probe': '1' } : {}),
    ...(secFetchSite === undefined || secFetchSite === null ? {} : { 'Sec-Fetch-Site': secFetchSite }),
    ...(omitOrigin ? {} : { Origin: origin }),
    ...headers,
  };
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    body,
    headers: requestHeaders,
    method,
    redirect,
  });
}

function rawRequest(port, pathname, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      headers,
      host: '127.0.0.1',
      method,
      path: pathname,
      port,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        body: Buffer.concat(chunks).toString(),
        headers: response.headers,
        status: response.statusCode,
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function api(port, pathname, options = {}) {
  const requestOptions = { ...options };
  if (requestOptions.body !== undefined && typeof requestOptions.body !== 'string') {
    requestOptions.body = JSON.stringify(requestOptions.body);
    requestOptions.headers = {
      'Content-Type': 'application/json',
      ...requestOptions.headers,
    };
  }
  return request(port, pathname, requestOptions);
}

async function loginAndCallback(port, fakeFetch, options = {}) {
  const loginResponse = await api(port, '/api/login', {
    body: { clientId: CLIENT_ID },
    method: 'POST',
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  const authorize = new URL(login.url);
  const callback = await request(port,
    `/callback?state=${encodeURIComponent(authorize.searchParams.get('state'))}&code=${encodeURIComponent(CALLBACK_CODE)}`,
    { ...options, redirect: 'manual' });
  assert.equal(callback.status, 303);
  assert.equal(new URL(callback.headers.get('location'), `http://127.0.0.1:${port}`).pathname, '/');
  return { authorize, callback, fakeFetch };
}

test('serves the allowlisted prototype files with safe response headers', async () => {
  const { port } = await startServer();
  for (const pathname of ['/', '/player.mjs', '/player-core.mjs', '/style.css']) {
    const response = await request(port, pathname);
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.ok((await response.text()).length > 0, pathname);
  }
  const traversal = await request(port, '/../server.mjs');
  assert.equal(traversal.status, 404);
});

test('login creates a valid PKCE authorization request and callback consumes state once', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ init, url });
    return responseJson({
      access_token: 'access-after-code',
      expires_in: 3600,
      refresh_token: 'refresh-after-code',
    });
  };
  const { port } = await startServer({ fetchImpl: fakeFetch });
  const { authorize, callback } = await loginAndCallback(port, fakeFetch);

  assert.equal(authorize.origin, 'https://accounts.spotify.com');
  assert.equal(authorize.pathname, '/authorize');
  assert.equal(authorize.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/callback`);
  assert.deepEqual(authorize.searchParams.get('scope')?.split(' '), [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-modify-playback-state',
    'user-read-playback-state',
  ]);
  assert.equal(new URL(callback.headers.get('location'), `http://127.0.0.1:${port}`).search, '?status=success');
  assert.equal(calls.length, 1);

  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(calls[0].url, 'https://accounts.spotify.com/api/token');
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), CALLBACK_CODE);
  assert.equal(form.get('client_id'), CLIENT_ID);
  assert.equal(form.get('redirect_uri'), `http://127.0.0.1:${port}/callback`);
  assert.equal(
    createHash('sha256').update(form.get('code_verifier')).digest('base64url'),
    authorize.searchParams.get('code_challenge'),
  );

  const duplicate = await request(
    port,
    `/callback?state=${encodeURIComponent(authorize.searchParams.get('state'))}&code=second-code`,
  );
  assert.equal(duplicate.status, 303);
  assert.notEqual(new URL(duplicate.headers.get('location'), `http://127.0.0.1:${port}`).search, '?status=success');
  assert.equal(calls.length, 1);
  const token = await api(port, '/api/token');
  assert.deepEqual(await token.json(), { access_token: 'access-after-code' });
});

test('rejects missing or mismatched probe headers, origin, and host', async () => {
  const { port } = await startServer();
  const noProbe = await request(port, '/api/status', { probe: false });
  assert.equal(noProbe.status, 403);
  const noFetchMetadata = await request(port, '/api/status', {
    omitOrigin: true,
    secFetchSite: null,
  });
  assert.equal(noFetchMetadata.status, 403);
  const wrongOrigin = await request(port, '/api/status', {
    origin: 'http://127.0.0.1:9999',
  });
  assert.equal(wrongOrigin.status, 403);
  const wrongHost = await rawRequest(port, '/api/status', {
    headers: { Host: `127.0.0.1:${port + 1}` },
  });
  assert.equal(wrongHost.status, 400);
  const callbackWrongHost = await rawRequest(port, '/callback?state=bad', {
    headers: { Host: `localhost:${port}` },
  });
  assert.equal(callbackWrongHost.status, 400);
});

test('expires pending callback state without contacting Spotify', async () => {
  let currentTime = 1000;
  let fetchCount = 0;
  const fakeFetch = async () => {
    fetchCount += 1;
    return responseJson({ access_token: 'never-used' });
  };
  const { port } = await startServer({
    fetchImpl: fakeFetch,
    now: () => currentTime,
    stateTtlMs: 10,
  });
  const loginResponse = await api(port, '/api/login', {
    body: { clientId: CLIENT_ID },
    method: 'POST',
  });
  const authorize = new URL(await loginResponse.text().then(body => JSON.parse(body).url));
  currentTime += 11;
  const callback = await request(port, `/callback?state=${authorize.searchParams.get('state')}&code=expired`);
  assert.equal(callback.status, 303);
  assert.equal(new URL(callback.headers.get('location'), `http://127.0.0.1:${port}`).search, '?status=expired');
  assert.equal(fetchCount, 0);
});

test('requires a complete token expiry response before authenticating', async () => {
  const fakeFetch = async () => responseJson({ access_token: 'missing-expiry' });
  const { port } = await startServer({ fetchImpl: fakeFetch });
  const loginResponse = await api(port, '/api/login', {
    body: { clientId: CLIENT_ID },
    method: 'POST',
  });
  const authorize = new URL((await loginResponse.json()).url);
  const callback = await request(
    port,
    `/callback?state=${authorize.searchParams.get('state')}&code=missing-expiry`,
  );
  assert.equal(callback.status, 303);
  assert.equal(new URL(callback.headers.get('location'), `http://127.0.0.1:${port}`).search, '?status=error');
  const status = await api(port, '/api/status');
  assert.deepEqual(await status.json(), { authenticated: false, clientId: CLIENT_ID });
});

test('times out a token exchange whose response body never resolves', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: () => new Promise(() => {}),
  });
  const { port } = await startServer({ exchangeTimeoutMs: 20, fetchImpl: fakeFetch });
  const loginResponse = await api(port, '/api/login', {
    body: { clientId: CLIENT_ID },
    method: 'POST',
  });
  const authorize = new URL((await loginResponse.json()).url);
  const callback = await request(
    port,
    `/callback?state=${authorize.searchParams.get('state')}&code=hanging-body`,
  );
  assert.equal(callback.status, 303);
  assert.equal(new URL(callback.headers.get('location'), `http://127.0.0.1:${port}`).search, '?status=error');
});

test('starting a new login retires a late exchange from the prior session', async () => {
  const pendingFetches = [];
  const fakeFetch = async (_url, init) => await new Promise(resolve => {
    pendingFetches.push({ form: new URLSearchParams(init.body), resolve });
  });
  const { port } = await startServer({ fetchImpl: fakeFetch });

  const firstLogin = await api(port, '/api/login', {
    body: { clientId: CLIENT_ID },
    method: 'POST',
  });
  const firstAuthorize = new URL((await firstLogin.json()).url);
  const firstCallbackPromise = request(
    port,
    `/callback?state=${firstAuthorize.searchParams.get('state')}&code=first`,
  );
  while (pendingFetches.length < 1) await new Promise(resolve => setImmediate(resolve));

  const secondLogin = await api(port, '/api/login', {
    body: { clientId: 'fedcba9876543210fedcba9876543210' },
    method: 'POST',
  });
  const secondAuthorize = new URL((await secondLogin.json()).url);
  pendingFetches.shift().resolve(responseJson({
    access_token: 'late-first',
    expires_in: 3600,
    refresh_token: 'late-refresh',
  }));
  const firstCallback = await firstCallbackPromise;
  assert.equal(new URL(firstCallback.headers.get('location'), `http://127.0.0.1:${port}`).search, '?status=error');

  const secondCallbackPromise = request(
    port,
    `/callback?state=${secondAuthorize.searchParams.get('state')}&code=second`,
  );
  while (pendingFetches.length < 1) await new Promise(resolve => setImmediate(resolve));
  pendingFetches.shift().resolve(responseJson({
    access_token: 'second-access',
    expires_in: 3600,
    refresh_token: 'second-refresh',
  }));
  assert.equal((await secondCallbackPromise).status, 303);
  const token = await api(port, '/api/token');
  assert.deepEqual(await token.json(), { access_token: 'second-access' });
});

test('refreshes expired access tokens once for concurrent token requests', async () => {
  let currentTime = 1000;
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push(new URLSearchParams(init.body));
    const grant = new URLSearchParams(init.body).get('grant_type');
    if (grant === 'authorization_code') {
      return responseJson({ access_token: 'short-lived', expires_in: 1, refresh_token: 'refresh-1' });
    }
    return responseJson({ access_token: 'refreshed', expires_in: 3600 });
  };
  const { port } = await startServer({ fetchImpl: fakeFetch, now: () => currentTime });
  await loginAndCallback(port, fakeFetch);
  currentTime += 1001;
  const [first, second] = await Promise.all([
    api(port, '/api/token'),
    api(port, '/api/token'),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(await first.json(), { access_token: 'refreshed' });
  assert.deepEqual(await second.json(), { access_token: 'refreshed' });
  assert.equal(calls.filter(form => form.get('grant_type') === 'refresh_token').length, 1);
});

test('logout invalidates a refresh and code exchange that finish later', async () => {
  let currentTime = 1000;
  const deferred = [];
  const fakeFetch = async (url, init) => {
    const form = new URLSearchParams(init.body);
    return await new Promise(resolve => deferred.push({ form, resolve }));
  };
  const { port } = await startServer({ fetchImpl: fakeFetch, now: () => currentTime });

  const loginResponse = await api(port, '/api/login', {
    body: { clientId: CLIENT_ID },
    method: 'POST',
  });
  const authorize = new URL(await loginResponse.json().then(body => body.url));
  const callbackPromise = request(
    port,
    `/callback?state=${authorize.searchParams.get('state')}&code=${CALLBACK_CODE}`,
  );
  while (deferred.length < 1) await new Promise(resolve => setImmediate(resolve));
  const logoutDuringExchange = await api(port, '/api/logout', { method: 'POST' });
  assert.equal(logoutDuringExchange.status, 200);
  deferred.shift().resolve({
    ok: true,
    json: async () => ({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600 }),
  });
  const callback = await callbackPromise;
  assert.equal(new URL(callback.headers.get('location'), `http://127.0.0.1:${port}`).search, '?status=error');
  let status = await api(port, '/api/status');
  assert.deepEqual(await status.json(), { authenticated: false, clientId: CLIENT_ID });

  // Establish a refresh token, then force it to expire and hold the refresh request.
  const secondLogin = await api(port, '/api/login', { body: { clientId: CLIENT_ID }, method: 'POST' });
  const secondAuthorize = new URL(await secondLogin.json().then(body => body.url));
  const secondCallbackPromise = request(
    port,
    `/callback?state=${secondAuthorize.searchParams.get('state')}&code=code-2`,
  );
  while (deferred.length < 1) await new Promise(resolve => setImmediate(resolve));
  deferred.shift().resolve({
    ok: true,
    json: async () => ({ access_token: 'short-lived', refresh_token: 'refresh-2', expires_in: 1 }),
  });
  assert.equal((await secondCallbackPromise).status, 303);
  currentTime += 1001;
  const tokenPromise = api(port, '/api/token');
  while (deferred.length < 1) await new Promise(resolve => setImmediate(resolve));
  const logoutDuringRefresh = await api(port, '/api/logout', { method: 'POST' });
  assert.equal(logoutDuringRefresh.status, 200);
  deferred.shift().resolve({
    ok: true,
    json: async () => ({ access_token: 'late-refresh', expires_in: 3600 }),
  });
  const token = await tokenPromise;
  assert.equal(token.status, 401);
  assert.deepEqual(await token.json(), { error: 'authentication_required' });
  status = await api(port, '/api/status');
  assert.deepEqual(await status.json(), { authenticated: false, clientId: CLIENT_ID });
});
