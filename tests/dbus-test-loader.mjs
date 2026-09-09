const gioSource = `
let nextSignalId = 1;

export const BusType = {SESSION: 0};
export const DBusProxyFlags = {NONE: 0};
export const DBusCallFlags = {NONE: 0};
export const DBusError = {SERVICE_UNKNOWN: 'SERVICE_UNKNOWN'};

export const testBus = {
    pendingProxy: [],
    pendingCalls: [],
    reset() {
        this.pendingProxy = [];
        this.pendingCalls = [];
    },
};

export class Cancellable {
    constructor() {
        this.cancelled = false;
    }

    cancel() {
        this.cancelled = true;
    }

    is_cancelled() {
        return this.cancelled;
    }
}

export class DBusNodeInfo {
    static new_for_xml() {
        return {interfaces: [{}]};
    }
}

export class FakeProxy {
    constructor(owner = 'owner', failConnectSignal = '') {
        this.g_name_owner = owner;
        this.failConnectSignal = failConnectSignal;
        this.handlers = new Map();
        this.cachedPlayback = null;
        this.calls = [];
        this.finishCount = 0;
    }

    connect(signal, callback) {
        if (signal === this.failConnectSignal)
            throw new Error('connect failed for ' + signal);
        const id = nextSignalId++;
        this.handlers.set(id, {signal, callback});
        return id;
    }

    disconnect(id) {
        this.handlers.delete(id);
    }

    emitSignal(name, parameters) {
        for (const {signal, callback} of this.handlers.values()) {
            if (signal === 'g-signal')
                callback(this, null, name, parameters);
        }
    }

    loseOwner(owner = '') {
        this.g_name_owner = owner;
        for (const {signal, callback} of this.handlers.values()) {
            if (signal === 'notify::g-name-owner')
                callback(this);
        }
    }

    setCachedPlayback(raw) {
        this.cachedPlayback = raw;
        for (const {signal, callback} of this.handlers.values()) {
            if (signal === 'g-properties-changed')
                callback(this);
        }
    }

    get_cached_property() {
        return this.cachedPlayback === null ? null : new Variant('s', [this.cachedPlayback]);
    }

    call(method, parameters, _flags, _timeout, cancellable, callback) {
        const request = {proxy: this, method, parameters, cancellable, callback};
        this.calls.push(request);
        testBus.pendingCalls.push(request);
    }

    call_finish(result) {
        this.finishCount++;
        if (result.error)
            throw result.error;
        return result.reply;
    }
}

export const DBusProxy = {
    new_for_bus(_busType, _flags, _info, _name, _path, _interface, cancellable, callback) {
        testBus.pendingProxy.push({cancellable, callback});
    },
    new_for_bus_finish(result) {
        if (result.error)
            throw result.error;
        return result.proxy;
    },
};

export class Variant {
    constructor(signature, values) {
        this.signature = signature;
        this.values = values;
    }

    deep_unpack() {
        return this.values;
    }
}

export default {BusType, DBusProxyFlags, DBusCallFlags, DBusError, Cancellable,
    DBusNodeInfo, DBusProxy, Variant};
`;

const glibSource = `
export const PRIORITY_DEFAULT = 0;
export const SOURCE_REMOVE = false;
export const SOURCE_CONTINUE = true;
let nextSourceId = 1;
const sources = new Map();

export function timeout_add_seconds(_priority, seconds, callback) {
    const id = nextSourceId++;
    sources.set(id, {seconds, callback});
    return id;
}

export const Source = {
    remove(id) {
        sources.delete(id);
    },
};

export function getSource(id) {
    return sources.get(id);
}

export function runSource(id) {
    const source = sources.get(id);
    if (!source)
        return;
    if (source.callback() === SOURCE_REMOVE)
        sources.delete(id);
}

export class Variant {
    constructor(signature, values) {
        this.signature = signature;
        this.values = values;
    }

    deep_unpack() {
        return this.values;
    }
}

export default {PRIORITY_DEFAULT, SOURCE_REMOVE, SOURCE_CONTINUE,
    timeout_add_seconds, Source, Variant};
`;

const gobjectSource = `
export const TYPE_BOOLEAN = Boolean;

export class Object {
    constructor() {
        this._signalHandlers = new Map();
        this._init?.();
    }

    _init() {}

    connect(signal, callback) {
        const id = Symbol(signal);
        this._signalHandlers.set(id, {signal, callback});
        return id;
    }

    disconnect(id) {
        this._signalHandlers.delete(id);
    }

    emit(signal, ...args) {
        for (const {signal: name, callback} of [...this._signalHandlers.values()]) {
            if (name === signal)
                callback(this, ...args);
        }
    }

}

export function registerClass(_metadata, klass) {
    return klass;
}

export default {TYPE_BOOLEAN, Object, registerClass};
`;

const sources = {
    'gi://Gio': gioSource,
    'gi://GLib': glibSource,
    'gi://GObject': gobjectSource,
};

function moduleUrl(source) {
    return `data:text/javascript,${encodeURIComponent(source)}`;
}

export async function resolve(specifier, context, defaultResolve) {
    if (sources[specifier])
        return {url: moduleUrl(sources[specifier]), shortCircuit: true};
    return defaultResolve(specifier, context, defaultResolve);
}
