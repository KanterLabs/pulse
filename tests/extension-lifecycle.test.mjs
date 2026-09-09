import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Execute the actual extension, with a deliberately small Shell API surface.
// Missing constructors/methods throw instead of being accepted by permissive
// Proxy stubs. Native allocation/GC is covered separately by the Shell smoke.
const source = fs.readFileSync(new URL('../extension/pulse@kanterlabs/extension.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class PulseExtension', 'class PulseExtension') +
    '\nglobalThis.subject = {PulseExtension, PulseIndicator};';
const schema = fs.readFileSync(new URL('../extension/pulse@kanterlabs/schemas/org.gnome.shell.extensions.pulse.gschema.xml', import.meta.url), 'utf8');
const schemaKeys = new Map([...schema.matchAll(/<key name="([^"]+)" type="([^"]+)"/g)]
    .map(([, name, type]) => [name, type]));

function fixture({failActorAt = 0} = {}) {
    let next = 1;
    let clock = 1000000;
    let actorCount = 0;
    const actors = new Set();
    const signals = new Set();
    const sources = new Map();
    const bindings = new Set();
    const connections = [];
    const errors = [];
    const launches = [];
    const launchResults = [];
    class Emitter {
        constructor() { this.handlers = new Map(); }
        connect(name, callback) {
            const id = next++;
            this.handlers.set(id, {name, callback});
            signals.add(id);
            return id;
        }
        disconnect(id) {
            assert(this.handlers.delete(id), `disconnect of unknown signal ${id}`);
            signals.delete(id);
        }
        emit(name, ...args) {
            for (const handler of [...this.handlers.values()]) {
                if (handler.name === name) handler.callback(this, ...args);
            }
        }
        clearSignals() {
            for (const id of [...this.handlers.keys()]) this.disconnect(id);
        }
    }
    class Actor extends Emitter {
        constructor(...args) {
            super();
            if (++actorCount === failActorAt) throw new Error('actor construction failed');
            this._init(...args);
        }
        _init(params = {}) {
            this.children = [];
            this.classes = new Set();
            this.pseudos = new Set();
            this.visible = true;
            this.nativeDestroyed = false;
            Object.assign(this, params);
            actors.add(this);
        }
        add_child(actor) {
            assert(!this.nativeDestroyed);
            assert(!actor.parent);
            this.children.push(actor);
            actor.parent = this;
        }
        set_child(actor) { this.add_child(actor); }
        get_children() { return [...this.children]; }
        set_width(width) { this.width = width; }
        add_style_class_name(name) { this.classes.add(name); }
        remove_style_class_name(name) { this.classes.delete(name); }
        add_style_pseudo_class(name) { this.pseudos.add(name); }
        remove_style_pseudo_class(name) { this.pseudos.delete(name); }
        destroy() {
            assert(!this.nativeDestroyed, 'native actor destroyed twice');
            for (const child of [...this.children]) child.destroy();
            if (this.parent) {
                this.parent.children = this.parent.children.filter(child => child !== this);
                this.parent = null;
            }
            this.nativeDestroyed = true;
            this.emit('destroy');
            this.clearSignals();
            actors.delete(this);
        }
    }
    class Label extends Actor {
        _init(params) { super._init(params); this.clutter_text = {}; }
    }
    class Entry extends Actor {
        _init(params) { super._init(params); this.clutter_text = new Emitter(); this.text = ''; }
        get_clutter_text() { return this.clutter_text; }
        get_text() { return this.text; }
        destroy() { this.clutter_text.clearSignals(); super.destroy(); }
    }
    class Menu extends Emitter {
        constructor() { super(); this.box = new Actor(); this.isOpen = false; }
        addMenuItem(item) { this.box.add_child(item); }
        toggle() { this.isOpen = !this.isOpen; this.emit('open-state-changed', this.isOpen); }
        destroy() { this.box.destroy(); this.clearSignals(); }
    }
    class PanelButton extends Actor {
        _init() {
            super._init();
            this.menu = new Menu();
            // Mirrors the Shell's destroy callback: orphaned indicators with
            // this signal are exactly what generated the reported GC warning.
            this.connect('destroy', this._onDestroy.bind(this));
        }
        _onDestroy() { this.menu.destroy(); }
    }
    class BarLevel extends Actor {
        set value(value) {
            assert(Number.isFinite(value) && value >= 0 && value <= 1);
            this._value = value;
        }
        get value() { return this._value; }
    }
    class Settings extends Emitter {
        constructor() {
            super();
            this.settings_schema = {
                has_key: key => schemaKeys.has(key),
                get_key: key => ({get_value_type: () => ({dup_string: () => schemaKeys.get(key)})}),
            };
            this.values = {'show-progress': true, 'show-indicator': true, 'shortcut-enabled': true,
                'compact-mode': false, theme: 'system', 'default-view': 'home'};
        }
        get_boolean(key) { return Boolean(this.values[key]); }
        get_string(key) { return this.values[key] ?? ''; }
    }
    const settings = new Settings();
    const dir = {get_child() { return this; }};
    class Extension {
        constructor() { this.dir = dir; this.uuid = 'pulse@kanterlabs'; }
        getSettings() { return settings; }
    }
    class PulseConnection extends Emitter {
        constructor() {
            super(); this.connected = false; this.snapshot = {}; this.authState = {};
            this.destroyed = false; connections.push(this);
        }
        start() { this.started = true; }
        destroy() { this.destroyed = true; this.clearSignals(); }
        refresh() {}
        getAuthState() {}
        getView() {}
        search(query) { this.query = query; }
        beginLogin(success, failure) { this.loginCallbacks = [success, failure]; }
    }
    const addSource = (_priority, _delay, callback) => {
        const id = next++; sources.set(id, callback); return id;
    };
    const Main = {
        panel: {addToStatusArea() {}},
        wm: {
            addKeybinding(key) {
                assert.equal(schemaKeys.get(key), 'as', 'native binding requires a real string-array schema key');
                bindings.add(key);
            },
            removeKeybinding(key) { bindings.delete(key); },
        },
    };
    const context = vm.createContext({
        console: {error: (...args) => errors.push(args)},
        Clutter: {ActorAlign: {CENTER: 1}},
        Pango: {EllipsizeMode: {END: 1}, WrapMode: {WORD_CHAR: 1}},
        Meta: {KeyBindingFlags: {NONE: 0}}, Shell: {ActionMode: {NORMAL: 1, OVERVIEW: 2}},
        GLib: {get_monotonic_time: () => clock, timeout_add: addSource, timeout_add_seconds: addSource,
            PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
            Source: {remove(id) { assert(sources.delete(id), 'removing unknown source'); }}},
        Gio: {Settings, FileIcon: {new: () => ({})}, File: {new_for_path: () => ({}), new_for_uri: () => ({})},
            Cancellable: class { cancel() { this.cancelled = true; } },
            AppInfo: {
                launch_default_for_uri_async(uri, ctx, cancellable, callback) {
                    launches.push({uri, cancellable, callback});
                },
                launch_default_for_uri_finish(result) { launchResults.push(result); return result; },
            }},
        GObject: {registerClass: cls => cls},
        St: {Widget: Actor, BoxLayout: Actor, Bin: Actor, Button: Actor, Label, Icon: Actor, Entry},
        BarLevel: {BarLevel}, PanelMenu: {Button: PanelButton},
        PopupMenu: {PopupBaseMenuItem: Actor, PopupSeparatorMenuItem: Actor},
        Extension, Main, PulseConnection,
        parseAuthState: value => typeof value === 'string' ? JSON.parse(value) : value,
        parseViewPayload: value => typeof value === 'string' ? JSON.parse(value) : value,
    });
    vm.runInContext(source, context);
    const {PulseExtension, PulseIndicator} = context.subject;
    return {extension: new PulseExtension(), PulseIndicator, settings, actors, signals, sources,
        nativeDestroy: actor => Actor.prototype.destroy.call(actor),
        bindings, connections, errors, launches, launchResults, Main, count: () => actorCount,
        advance: delta => { clock += delta; },
        assertClean() {
            assert.equal(actors.size, 0, 'orphan actors');
            assert.equal(signals.size, 0, 'live signals');
            assert.equal(sources.size, 0, 'live timers');
            assert.equal(bindings.size, 0, 'live shortcut');
            assert(connections.every(connection => connection.destroyed));
            assert.equal(errors.length, 0, 'cleanup error');
        },
    };
}

test('100 enable/disable cycles leave no actors, timers, signals or keybindings', () => {
    const f = fixture();
    f.extension.disable(); // harmless even before enable
    for (let i = 0; i < 100; i++) {
        f.extension.enable();
        assert(f.bindings.has('toggle-shortcut'));
        assert.equal(f.sources.size, 0, 'closed menu must not poll progress');
        f.extension.disable();
        f.extension.disable();
        f.assertClean();
    }
});

test('native panel destruction retires callbacks and connection before later disable', () => {
    const f = fixture();
    f.extension.enable();
    const indicator = f.extension._indicator;
    const connection = f.connections[0];
    indicator.menu.toggle();
    indicator._searchEntry.text = 'queued search';
    indicator._scheduleSearch();
    const queuedCallbacks = [...f.sources.values()];

    // C-level destruction bypasses the public JavaScript destroy() override.
    // Shell can then dispatch queued D-Bus/timer work from its shutdown loop.
    f.nativeDestroy(indicator);
    assert.equal(f.extension._indicator, null);
    assert.equal(connection.destroyed, true);
    for (const callback of queuedCallbacks)
        callback();
    connection.emit('connection-changed', false);
    connection.emit('snapshot-changed');
    f.extension.disable();
    f.assertClean();
});

test('a stale shortcut schema never reaches the native keybinding API', () => {
    for (const invalidType of [undefined, 's']) {
        const f = fixture();
        f.settings.settings_schema = {
            has_key: key => key !== 'toggle-shortcut' || invalidType !== undefined,
            get_key: () => ({get_value_type: () => ({dup_string: () => invalidType})}),
        };
        f.Main.wm.addKeybinding = () => assert.fail('native call with invalid schema');
        f.extension.enable();
        assert.equal(f.errors.length, 1);
        assert.match(f.errors[0][0], /shortcut schema/);
        f.errors.length = 0;
        f.extension.disable();
        f.assertClean();
    }
});

for (const stage of ['_buildPanelButton', '_buildNowPlaying', '_buildProgress', '_buildControls',
    '_buildAuth', '_buildNavigation', '_buildPage', '_connectSignals', '_syncSettings']) {
    test(`startup failure after ${stage} rolls back all resources`, () => {
        const f = fixture();
        const original = f.PulseIndicator.prototype[stage];
        f.PulseIndicator.prototype[stage] = function (...args) {
            original.apply(this, args);
            throw new Error('injected startup failure');
        };
        assert.throws(() => f.extension.enable(), /injected startup failure/);
        f.extension.disable();
        f.assertClean();
    });
}

test('panel registration failure rolls back widgets and connections', () => {
    const f = fixture();
    f.Main.panel.addToStatusArea = () => { throw new Error('panel unavailable'); };
    assert.throws(() => f.extension.enable(), /panel unavailable/);
    f.assertClean();
});

test('late login and queued search callbacks cannot reach destroyed widgets', () => {
    const f = fixture();
    f.extension.enable();
    const indicator = f.extension._indicator;
    const connection = f.connections[0];
    indicator._beginLogin();
    indicator._searchEntry.text = 'test';
    indicator._scheduleSearch();
    const pending = [...f.sources.values()];
    indicator._startAuthPolling();
    f.extension.disable();
    indicator._renderAuthState = () => assert.fail('rendered destroyed UI');
    connection.search = () => assert.fail('search after destruction');
    for (const callback of connection.loginCallbacks) callback('https://example.com/');
    for (const callback of pending) callback();
    f.assertClean();
});

test('progress uses elapsed time, remains finite, and stops while hidden or paused', () => {
    const f = fixture();
    f.extension.enable();
    const indicator = f.extension._indicator;
    const connection = f.connections[0];
    connection.connected = true;
    connection.snapshot = {playing: true, length_us: 10000000, position_us: 1000000};
    connection.emit('snapshot-changed');
    assert.equal(f.sources.size, 0);
    indicator.menu.toggle();
    assert.equal(f.sources.size, 1);
    f.advance(3000000);
    [...f.sources.values()][0]();
    assert.equal(indicator._progress.value, 0.4);
    indicator.menu.toggle();
    assert.equal(f.sources.size, 0);
    indicator.menu.toggle();
    connection.snapshot.playing = false;
    connection.emit('snapshot-changed');
    assert.equal(f.sources.size, 0);
    for (const bad of [NaN, Infinity, -Infinity, -1, 'garbage', undefined]) {
        connection.snapshot = {playing: true, length_us: bad, position_us: bad};
        connection.emit('snapshot-changed');
        assert.equal(indicator._progress.value, 0);
    }
    f.extension.disable();
    f.assertClean();
});

test('browser launch is async, deduplicated and cancelled before actor destruction', () => {
    const f = fixture();
    f.extension.enable();
    const indicator = f.extension._indicator;
    indicator._pendingAuthorizationUrl = 'https://accounts.spotify.com/authorize';
    indicator._openAuthorizationUrl();
    indicator._openAuthorizationUrl();
    assert.equal(f.launches.length, 1);
    f.extension.disable();
    const launch = f.launches[0];
    assert(launch.cancellable.cancelled);
    indicator._startAuthPolling = () => assert.fail('polling after destruction');
    launch.callback(null, true);
    assert.equal(f.launchResults.length, 1, 'must consume the GIO result even after disable');
    f.assertClean();
});

test('daemon loss resets a cancelled login so reconnect can offer sign-in again', () => {
    const f = fixture();
    f.extension.enable();
    const indicator = f.extension._indicator;
    indicator._beginLogin();
    assert(indicator._loginInProgress);
    f.connections[0].emit('connection-changed', false);
    assert.equal(indicator._loginInProgress, false);
    assert.equal(indicator._pendingAuthorizationUrl, '');
    f.extension.disable();
    f.assertClean();
});

test('replacing result pages destroys prior rows and caps the number of actors', () => {
    const f = fixture();
    f.extension.enable();
    const indicator = f.extension._indicator;
    const payload = {items: Array.from({length: 100}, (_, i) => ({
        name: `Track ${i}`, artist: 'Fixture artist', uri: `spotify:track:${i}`,
    }))};
    indicator._renderViewPayload(payload, 'home');
    const actorCount = f.actors.size;
    const signalCount = f.signals.size;
    assert.equal(indicator._resultsBox.get_children().length, 36);
    for (let i = 0; i < 100; i++) {
        indicator._renderViewPayload(payload, 'home');
        assert.equal(f.actors.size, actorCount);
        assert.equal(f.signals.size, signalCount);
    }
    indicator._renderSearchResults(JSON.stringify(payload));
    assert.equal(indicator._resultsBox.get_children().length, 8);
    f.extension.disable();
    f.assertClean();
});

test('every widget allocation failure after the base indicator rolls back its partial tree', () => {
    const baseline = fixture();
    baseline.extension.enable();
    const total = baseline.count();
    baseline.extension.disable();
    // First two allocations are GNOME's own PanelMenu.Button and menu box.
    for (let index = 3; index <= total; index++) {
        const f = fixture({failActorAt: index});
        assert.throws(() => f.extension.enable(), /actor construction failed/);
        try { f.assertClean(); } catch (error) { error.message += ` at allocation ${index}`; throw error; }
    }
});
