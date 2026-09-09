import assert from 'node:assert/strict';
import {register} from 'node:module';
import test, {beforeEach} from 'node:test';

register('./dbus-test-loader.mjs', import.meta.url);

const Gio = await import('gi://Gio');
const GLib = await import('gi://GLib');
const {PulseConnection, parseAuthState, parseSnapshot, parseViewPayload} =
    await import('../extension/pulse@kanterlabs/dbus.js');

beforeEach(() => Gio.testBus.reset());

function proxyResult(proxy) {
    const pending = Gio.testBus.pendingProxy.shift();
    assert.ok(pending, 'a DBus proxy request should be pending');
    pending.callback(null, {proxy});
    return proxy;
}

function replyFor(request, value) {
    request.callback(request.proxy, {reply: new Gio.Variant('()', [value])});
}

function errorFor(request, error) {
    request.callback(request.proxy, {error});
}

test('destroy invalidates delayed proxy initialization and public methods', () => {
    const connection = new PulseConnection();
    let signalCount = 0;
    for (const signal of ['connection-changed', 'snapshot-changed', 'error-changed',
        'search-results', 'view-results', 'auth-state-changed']) {
        connection.connect(signal, () => signalCount++);
    }

    connection.start();
    const pending = Gio.testBus.pendingProxy.shift();
    assert.ok(pending);
    signalCount = 0;
    connection.destroy();
    assert.equal(pending.cancellable.is_cancelled(), true);

    const lateProxy = new Gio.FakeProxy();
    pending.callback(null, {proxy: lateProxy});
    connection.start();
    connection.search('after destroy');
    connection.getView('home', '', () => signalCount++);
    connection.getAuthState(() => signalCount++);

    assert.equal(signalCount, 0);
    assert.equal(Gio.testBus.pendingProxy.length, 0);
    assert.equal(lateProxy.handlers.size, 0);
});

test('destroy cancels pending calls and ignores every late reply or callback', () => {
    const connection = new PulseConnection();
    const callbackValues = [];
    connection.start();
    const proxy = proxyResult(new Gio.FakeProxy());
    const beforeDestroy = Gio.testBus.pendingCalls.splice(0);
    assert.equal(beforeDestroy.length, 2, 'attach should request snapshot and auth state');

    connection.search('slow query');
    connection.getView('home', '', value => callbackValues.push(value));
    connection.getAuthState(value => callbackValues.push(value));
    connection.refresh();
    const pendingCalls = Gio.testBus.pendingCalls.splice(0);
    assert.ok(pendingCalls.length >= 4);

    let eventCount = 0;
    connection.connect('snapshot-changed', () => eventCount++);
    connection.connect('auth-state-changed', () => eventCount++);
    connection.destroy();
    const eventsAfterDestroy = eventCount;
    for (const request of [...beforeDestroy, ...pendingCalls]) {
        assert.equal(request.cancellable.is_cancelled(), true);
        replyFor(request, request.method === 'GetAuthState' ? '{}' : '{}');
    }

    assert.equal(callbackValues.length, 0);
    assert.equal(eventCount, eventsAfterDestroy);
    assert.equal(connection.connected, false);
    assert.equal(proxy.handlers.size, 0);
    assert.equal(proxy.finishCount, beforeDestroy.length + pendingCalls.length);
});

test('owner changes cancel old requests and retry cannot resurrect a destroyed connection', () => {
    const connection = new PulseConnection();
    connection.start();
    const proxy = proxyResult(new Gio.FakeProxy());
    const initialCalls = Gio.testBus.pendingCalls.splice(0);
    assert.equal(initialCalls.length, 2);

    connection.search('owner race');
    const oldSearch = Gio.testBus.pendingCalls.shift();
    assert.ok(oldSearch);
    let callbackCount = 0;
    connection.getAuthState(() => callbackCount++);
    const oldAuth = Gio.testBus.pendingCalls.at(-1);
    assert.ok(oldAuth);
    proxy.loseOwner('');
    assert.equal(oldSearch.cancellable.is_cancelled(), true);
    assert.equal(oldAuth.cancellable.is_cancelled(), true);
    proxy.emitSignal('SnapshotChanged', new Gio.Variant('s', ['{"title":"stale owner"}']));
    assert.equal(connection.snapshot.offline, true);
    const retryId = connection._retrySource;
    assert.ok(retryId);

    replyFor(oldSearch, '{"items":[{"name":"stale"}]}');
    replyFor(oldAuth, '{}');
    assert.equal(callbackCount, 0);

    const retryCallback = GLib.getSource(retryId)?.callback;
    connection.destroy();
    // Calling the captured retry callback models a timeout already queued when
    // Source.remove() ran during destroy(). It must observe the new lifecycle.
    assert.equal(retryId > 0, true);
    assert.equal(connection._retrySource, 0);
    retryCallback?.();
    proxy.loseOwner('new-owner');
    proxy.emitSignal('SnapshotChanged', new Gio.Variant('s', ['{"title":"late"}']));
    assert.equal(Gio.testBus.pendingProxy.length, 0);
});

test('partial proxy signal setup is rolled back without leaving handlers attached', () => {
    const connection = new PulseConnection();
    connection.start();
    const proxy = new Gio.FakeProxy('owner', 'g-properties-changed');
    proxyResult(proxy);

    assert.equal(proxy.handlers.size, 0);
    assert.equal(connection._proxy, null);
    assert.ok(connection._retrySource);
    connection.destroy();
});

test('direct daemon replacement clears old UI actions before reconnecting', () => {
    const connection = new PulseConnection();
    connection.start();
    const proxy = proxyResult(new Gio.FakeProxy('old-owner'));
    const transitions = [];
    connection.connect('connection-changed', (_connection, connected) => transitions.push(connected));
    proxy.loseOwner('replacement-owner');
    assert.deepEqual(transitions, [false, true]);
    connection.destroy();
});

test('service loss invalidates late replies while preserving the failing callback and recovery', () => {
    const connection = new PulseConnection();
    const searchResults = [];
    const loginErrors = [];
    connection.connect('search-results', (_connection, payload) => searchResults.push(payload));

    connection.start();
    const proxy = proxyResult(new Gio.FakeProxy('owner'));
    const initialCalls = Gio.testBus.pendingCalls.splice(0);
    for (const request of initialCalls)
        replyFor(request, '{}');

    connection.search('stale after service loss');
    const oldSearch = Gio.testBus.pendingCalls.shift();
    assert.ok(oldSearch);
    connection.beginLogin(null, error => loginErrors.push(error));
    const failedLogin = Gio.testBus.pendingCalls.shift();
    assert.ok(failedLogin);

    const serviceUnknown = {
        message: 'The Pulse daemon disappeared.',
        matches: () => true,
    };
    errorFor(failedLogin, serviceUnknown);

    assert.equal(connection.connected, false);
    assert.equal(oldSearch.cancellable.is_cancelled(), true);
    assert.equal(loginErrors.length, 1);
    replyFor(oldSearch, '{"items":[{"name":"stale"}]}');
    assert.equal(searchResults.length, 0);

    const retryId = connection._retrySource;
    assert.ok(retryId);
    const retryCallback = GLib.getSource(retryId)?.callback;
    retryCallback?.();
    const pendingProxy = Gio.testBus.pendingProxy.shift();
    assert.ok(pendingProxy);
    const replacement = new Gio.FakeProxy('replacement-owner');
    pendingProxy.callback(null, {proxy: replacement});
    assert.equal(connection.connected, true);

    const reconnectCalls = Gio.testBus.pendingCalls.splice(0);
    for (const request of reconnectCalls)
        replyFor(request, '{}');
    connection.search('fresh after recovery');
    const freshSearch = Gio.testBus.pendingCalls.shift();
    assert.ok(freshSearch);
    replyFor(freshSearch, '{"items":[{"name":"fresh"}]}');
    assert.equal(searchResults.length, 1);
    assert.match(searchResults[0], /fresh/);
    connection.destroy();
});

test('authoritative snapshot data cancels stale replies and later requests recover', () => {
    const connection = new PulseConnection();
    connection.start();
    const proxy = proxyResult(new Gio.FakeProxy('owner'));
    const initialCalls = Gio.testBus.pendingCalls.splice(0);
    const initialSnapshot = initialCalls.find(request => request.method === 'GetSnapshot');
    assert.ok(initialSnapshot);
    const initialAuth = initialCalls.find(request => request.method === 'GetAuthState');
    assert.ok(initialAuth);
    replyFor(initialAuth, '{}');

    proxy.emitSignal('SnapshotChanged', new Gio.Variant('s', ['{"title":"new signal"}']));
    assert.equal(initialSnapshot.cancellable.is_cancelled(), true);
    replyFor(initialSnapshot, '{"title":"old reply"}');
    assert.equal(connection.snapshot.title, 'new signal');

    connection.refresh();
    const refresh = Gio.testBus.pendingCalls.shift();
    assert.equal(refresh?.method, 'Refresh');
    replyFor(refresh, '');
    const explicitSnapshot = Gio.testBus.pendingCalls.shift();
    assert.equal(explicitSnapshot?.method, 'GetSnapshot');
    proxy.setCachedPlayback('{"title":"cached property"}');
    assert.equal(explicitSnapshot.cancellable.is_cancelled(), true);
    replyFor(explicitSnapshot, '{"title":"late explicit"}');
    assert.equal(connection.snapshot.title, 'cached property');

    connection.refresh();
    const secondRefresh = Gio.testBus.pendingCalls.shift();
    assert.equal(secondRefresh?.method, 'Refresh');
    replyFor(secondRefresh, '');
    const recoverySnapshot = Gio.testBus.pendingCalls.shift();
    assert.equal(recoverySnapshot?.method, 'GetSnapshot');
    replyFor(recoverySnapshot, '{"title":"recovered"}');
    assert.equal(connection.snapshot.title, 'recovered');
    connection.destroy();
});

test('unrelated property changes do not invalidate an explicit snapshot request', () => {
    const connection = new PulseConnection();
    connection.start();
    const proxy = proxyResult(new Gio.FakeProxy('owner'));
    const initialCalls = Gio.testBus.pendingCalls.splice(0);
    const initialSnapshot = initialCalls.find(request => request.method === 'GetSnapshot');
    assert.ok(initialSnapshot);
    replyFor(initialSnapshot, '{"title":"initial"}');
    const initialAuth = initialCalls.find(request => request.method === 'GetAuthState');
    assert.ok(initialAuth);
    replyFor(initialAuth, '{}');

    proxy.emitSignal('SnapshotChanged', new Gio.Variant('s', ['{"title":"signal"}']));
    assert.equal(connection.snapshot.title, 'signal');

    connection.refresh();
    const refresh = Gio.testBus.pendingCalls.shift();
    assert.equal(refresh?.method, 'Refresh');
    replyFor(refresh, '');
    const explicitSnapshot = Gio.testBus.pendingCalls.shift();
    assert.equal(explicitSnapshot?.method, 'GetSnapshot');
    proxy.cachedPlayback = '{"title":"stale cached property"}';
    proxy.emitPropertiesChanged({Status: new Gio.Variant('s', ['ready'])});
    assert.equal(explicitSnapshot.cancellable.is_cancelled(), false);
    assert.equal(connection.snapshot.title, 'signal');

    replyFor(explicitSnapshot, '{"title":"explicit"}');
    assert.equal(connection.snapshot.title, 'explicit');
    connection.destroy();
});

test('invalidated playback cache requests a fresh snapshot', () => {
    const connection = new PulseConnection();
    connection.start();
    const proxy = proxyResult(new Gio.FakeProxy('owner'));
    const initialCalls = Gio.testBus.pendingCalls.splice(0);
    const oldSnapshot = initialCalls.find(request => request.method === 'GetSnapshot');
    assert.ok(oldSnapshot);
    const initialAuth = initialCalls.find(request => request.method === 'GetAuthState');
    assert.ok(initialAuth);
    replyFor(initialAuth, '{}');

    proxy.cachedPlayback = null;
    proxy.emitPropertiesChanged({}, ['Playback']);
    assert.equal(oldSnapshot.cancellable.is_cancelled(), true);
    const freshSnapshot = Gio.testBus.pendingCalls.shift();
    assert.equal(freshSnapshot?.method, 'GetSnapshot');
    assert.notEqual(freshSnapshot, oldSnapshot);
    replyFor(freshSnapshot, '{"title":"fresh after cache invalidation"}');
    assert.equal(connection.snapshot.title, 'fresh after cache invalidation');
    connection.destroy();
});

test('malformed and oversized payloads become bounded safe values', () => {
    assert.equal(parseSnapshot('{not json}').offline, true);
    assert.equal(parseAuthState('{not json}').state, 'unknown');
    const payload = parseViewPayload('x'.repeat(4 * 1024 * 1024 + 1));
    assert.deepEqual(payload.items, []);
    assert.equal(payload.state, 'error');
});

test('in-flight call bound rejects new work through its error callback', () => {
    const connection = new PulseConnection();
    connection.start();
    const proxy = proxyResult(new Gio.FakeProxy());
    const initialCalls = Gio.testBus.pendingCalls.splice(0);
    for (const request of initialCalls)
        replyFor(request, '{}');

    for (let index = 0; index < 32; index++)
        connection.next();
    let errorCallbackCount = 0;
    connection.beginLogin(null, error => {
        assert.match(error.message, /too many pending/i);
        errorCallbackCount++;
    });

    assert.equal(errorCallbackCount, 1);
    assert.equal(connection._pendingCancellables.size, 32);
    assert.equal(Gio.testBus.pendingCalls.length, 32);
    const finishBeforeDestroy = proxy.finishCount;
    connection.destroy();
    assert.equal(proxy.finishCount, finishBeforeDestroy);
});

test('view request bookkeeping stays bounded across arbitrary view names', () => {
    const connection = new PulseConnection();
    connection.start();
    const proxy = proxyResult(new Gio.FakeProxy());
    const initialCalls = Gio.testBus.pendingCalls.splice(0);
    for (const request of initialCalls)
        replyFor(request, '{}');

    for (let index = 0; index < 40; index++)
        connection.getView('view-' + index);

    assert.equal(connection._viewCancellables.size, 16);
    assert.equal(connection._viewSequences.size, 16);
    assert.equal(connection._viewRequestOrder.length, 16);
    assert.ok(connection._pendingCancellables.size <= 16);
    connection.destroy();
    assert.equal(proxy.handlers.size, 0);
});
