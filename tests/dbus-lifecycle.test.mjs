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
