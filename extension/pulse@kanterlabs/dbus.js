import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

// The Shell talks only to the local daemon.  Keeping the introspection data
// here means that the extension remains useful when the daemon is installed
// independently of the extension package.
const BUS_NAME = 'io.kanterlabs.Pulse';
const OBJECT_PATH = '/io/kanterlabs/Pulse';
const INTERFACE_NAME = 'io.kanterlabs.Pulse1';
const RETRY_SECONDS = 12;

const INTERFACE_XML = `
<node>
  <interface name="io.kanterlabs.Pulse1">
    <property name="Status" type="s" access="read"/>
    <property name="Playback" type="s" access="read"/>
    <property name="ActiveView" type="s" access="read"/>
    <property name="Offline" type="b" access="read"/>
    <property name="LastRefresh" type="x" access="read"/>
    <method name="GetSnapshot">
      <arg name="snapshot" type="s" direction="out"/>
    </method>
    <method name="Refresh"/>
    <method name="Search">
      <arg name="query" type="s" direction="in"/>
      <arg name="results" type="s" direction="out"/>
    </method>
    <method name="OpenUri">
      <arg name="uri" type="s" direction="in"/>
    </method>
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek">
      <arg name="position_us" type="x" direction="in"/>
    </method>
    <method name="BeginLogin"/>
    <method name="Logout"/>
    <signal name="SnapshotChanged">
      <arg name="snapshot" type="s"/>
    </signal>
    <signal name="PlaybackChanged">
      <arg name="snapshot" type="s"/>
    </signal>
    <signal name="LoginStateChanged">
      <arg name="state" type="s"/>
    </signal>
    <signal name="ErrorChanged">
      <arg name="error" type="s"/>
    </signal>
  </interface>
</node>`;

let _interfaceInfo;

function getInterfaceInfo() {
    if (!_interfaceInfo)
        _interfaceInfo = Gio.DBusNodeInfo.new_for_xml(INTERFACE_XML).interfaces[0];
    return _interfaceInfo;
}

function textOr(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
}

function numberOr(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function boolOr(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
}

function disconnectedSnapshot(error = '') {
    return {
        status: 'offline',
        title: '',
        artist: '',
        album: '',
        art_url: '',
        spotify_url: '',
        length_us: 0,
        position_us: 0,
        playing: false,
        can_control: false,
        can_go_next: false,
        can_go_previous: false,
        can_seek: false,
        offline: true,
        error: textOr(error),
    };
}

function normalizeSnapshot(raw) {
    let value = raw;
    if (typeof raw === 'string') {
        try {
            value = JSON.parse(raw);
        } catch (_error) {
            return disconnectedSnapshot('The daemon returned an invalid playback snapshot.');
        }
    }

    if (!value || typeof value !== 'object' || Array.isArray(value))
        return disconnectedSnapshot();

    return {
        status: textOr(value.status, value.offline ? 'offline' : 'ready'),
        title: textOr(value.title),
        artist: textOr(value.artist),
        album: textOr(value.album),
        art_url: textOr(value.art_url),
        spotify_url: textOr(value.spotify_url),
        length_us: Math.max(0, numberOr(value.length_us)),
        position_us: Math.max(0, numberOr(value.position_us)),
        playing: boolOr(value.playing),
        can_control: boolOr(value.can_control),
        can_go_next: boolOr(value.can_go_next),
        can_go_previous: boolOr(value.can_go_previous),
        can_seek: boolOr(value.can_seek),
        offline: boolOr(value.offline),
        error: textOr(value.error),
    };
}

function unpackFirst(parameters) {
    if (!parameters)
        return null;
    try {
        const values = parameters.deep_unpack();
        return Array.isArray(values) ? values[0] : values;
    } catch (_error) {
        return null;
    }
}

export const PulseConnection = GObject.registerClass({
    Signals: {
        'snapshot-changed': {},
        'connection-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        'error-changed': {param_types: [GObject.TYPE_STRING]},
        'search-results': {param_types: [GObject.TYPE_STRING]},
    },
}, class PulseConnection extends GObject.Object {
    _init() {
        super._init();
        this._proxy = null;
        this._proxySignals = [];
        this._searchCancellable = null;
        this._retrySource = 0;
        this._generation = 0;
        this._connected = false;
        this._error = '';
        this._snapshot = disconnectedSnapshot();
    }

    get connected() {
        return this._connected;
    }

    get snapshot() {
        return this._snapshot;
    }

    get error() {
        return this._error;
    }

    start() {
        this.stop();

        const generation = ++this._generation;
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            getInterfaceInfo(),
            BUS_NAME,
            OBJECT_PATH,
            INTERFACE_NAME,
            null,
            (source, result) => {
                if (generation !== this._generation)
                    return;

                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(result);
                    this._attachProxy(proxy, generation);
                } catch (error) {
                    this._handleConnectionError(error);
                }
            });
    }

    stop() {
        this._generation++;
        if (this._searchCancellable) {
            this._searchCancellable.cancel();
            this._searchCancellable = null;
        }
        if (this._retrySource) {
            GLib.Source.remove(this._retrySource);
            this._retrySource = 0;
        }

        for (const [object, id] of this._proxySignals)
            object.disconnect(id);
        this._proxySignals = [];
        this._proxy = null;

        if (this._connected) {
            this._connected = false;
            this.emit('connection-changed', false);
        }

        this._setSnapshot(disconnectedSnapshot());
    }

    destroy() {
        this.stop();
        this.run_dispose();
    }

    refresh() {
        this._call('Refresh', new GLib.Variant('()', []), () => this._requestSnapshot());
    }

    playPause() {
        this._call('PlayPause', new GLib.Variant('()', []));
    }

    next() {
        this._call('Next', new GLib.Variant('()', []));
    }

    previous() {
        this._call('Previous', new GLib.Variant('()', []));
    }

    seek(positionUs) {
        const position = Math.max(0, Math.round(numberOr(positionUs)));
        this._call('Seek', new GLib.Variant('(x)', [position]));
    }

    openUri(uri) {
        if (!uri)
            return;
        this._call('OpenUri', new GLib.Variant('(s)', [String(uri)]));
    }

    search(query) {
        const value = String(query ?? '').trim();
        if (this._searchCancellable) {
            this._searchCancellable.cancel();
            this._searchCancellable = null;
        }
        if (!value) {
            this.emit('search-results', '');
            return;
        }
        const cancellable = new Gio.Cancellable();
        this._searchCancellable = cancellable;
        this._call('Search', new GLib.Variant('(s)', [value]), reply => {
            if (this._searchCancellable !== cancellable)
                return;
            this._searchCancellable = null;
            const result = unpackFirst(reply);
            this.emit('search-results', typeof result === 'string' ? result : '');
        }, cancellable);
    }

    beginLogin() {
        this._call('BeginLogin', new GLib.Variant('()', []));
    }

    logout() {
        this._call('Logout', new GLib.Variant('()', []));
    }

    _attachProxy(proxy, generation) {
        if (generation !== this._generation) {
            proxy.run_dispose();
            return;
        }

        this._proxy = proxy;
        this._proxySignals = [
            [proxy, proxy.connect('g-signal', (_proxy, _sender, signalName, parameters) => {
                this._handleSignal(signalName, parameters);
            })],
            [proxy, proxy.connect('g-properties-changed', () => {
                this._readCachedSnapshot();
            })],
            [proxy, proxy.connect('notify::g-name-owner', () => {
                this._syncProxyOwner();
            })],
        ];

        this._syncProxyOwner();
    }

    _syncProxyOwner() {
        if (!this._proxy)
            return;

        const hasOwner = Boolean(this._proxy.g_name_owner);
        if (!hasOwner) {
            this._setDisconnected('The Pulse daemon is offline.');
            this._scheduleRetry();
            return;
        }

        if (!this._connected) {
            this._connected = true;
            this._error = '';
            this.emit('connection-changed', true);
        }
        this._requestSnapshot();
    }

    _requestSnapshot() {
        this._call('GetSnapshot', new GLib.Variant('()', []), reply => {
            const raw = unpackFirst(reply);
            if (raw !== null)
                this._setSnapshot(normalizeSnapshot(raw));
        });
    }

    _readCachedSnapshot() {
        if (!this._proxy)
            return;

        try {
            const value = this._proxy.get_cached_property('Playback');
            const raw = unpackFirst(value);
            if (raw !== null)
                this._setSnapshot(normalizeSnapshot(raw));
        } catch (_error) {
            // A daemon built against an older contract may not expose Playback.
            // GetSnapshot remains the authoritative path in that case.
        }
    }

    _handleSignal(signalName, parameters) {
        switch (signalName) {
        case 'SnapshotChanged':
        case 'PlaybackChanged': {
            const raw = unpackFirst(parameters);
            if (raw !== null)
                this._setSnapshot(normalizeSnapshot(raw));
            break;
        }
        case 'ErrorChanged': {
            const error = textOr(unpackFirst(parameters));
            this._setError(error);
            break;
        }
        case 'LoginStateChanged':
            // Login state is reflected by the daemon's next snapshot.  Avoid
            // forcing an extra request for every informational state change.
            break;
        default:
            break;
        }
    }

    _call(method, parameters, onSuccess = null, cancellable = null) {
        if (!this._proxy || !this._proxy.g_name_owner) {
            this._setDisconnected('The Pulse daemon is offline.');
            this._scheduleRetry();
            return;
        }

        const generation = this._generation;
        try {
            this._proxy.call(
                method,
                parameters,
                Gio.DBusCallFlags.NONE,
                -1,
                cancellable,
                (proxy, result) => {
                    if (generation !== this._generation)
                        return;
                    try {
                        const reply = proxy.call_finish(result);
                        if (onSuccess)
                            onSuccess(reply);
                    } catch (error) {
                        if (cancellable?.is_cancelled())
                            return;
                        this._handleCallError(error);
                    }
                });
        } catch (error) {
            this._handleCallError(error);
        }
    }

    _handleConnectionError(error) {
        const message = error?.message ?? 'The Pulse daemon is unavailable.';
        this._setDisconnected(message);
        this._scheduleRetry();
    }

    _handleCallError(error) {
        const message = error?.message ?? 'Pulse could not complete that action.';
        this._setError(message);
        if (error?.matches?.(Gio.DBusError, Gio.DBusError.SERVICE_UNKNOWN))
            this._setDisconnected('The Pulse daemon is offline.');
    }

    _setDisconnected(message) {
        this._setError(message);
        this._setSnapshot(disconnectedSnapshot(message));
        if (this._connected) {
            this._connected = false;
            this.emit('connection-changed', false);
        }
    }

    _setError(message) {
        const value = textOr(message);
        if (value === this._error)
            return;
        this._error = value;
        this.emit('error-changed', value);
    }

    _setSnapshot(snapshot) {
        this._snapshot = snapshot;
        this.emit('snapshot-changed');
    }

    _scheduleRetry() {
        if (this._retrySource)
            return;

        this._retrySource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RETRY_SECONDS, () => {
            this._retrySource = 0;
            if (!this._proxy || !this._connected)
                this.start();
            return GLib.SOURCE_REMOVE;
        });
    }
});

export const PulseBus = {
    name: BUS_NAME,
    path: OBJECT_PATH,
    interface: INTERFACE_NAME,
};

export function parseSnapshot(raw) {
    return normalizeSnapshot(raw);
}
