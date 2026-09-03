import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

// The Shell talks only to the local daemon. Keeping the introspection data here
// means that the extension can be installed independently of the daemon package
// while still using the same, versioned contract.
const BUS_NAME = 'io.kanterlabs.Pulse';
const OBJECT_PATH = '/io/kanterlabs/Pulse';
const INTERFACE_NAME = 'io.kanterlabs.Pulse1';
const RETRY_SECONDS = 12;
const MAX_ITEMS = 100;

// Keep this in lockstep with dbus/io.kanterlabs.Pulse1.xml. In particular,
// BeginLogin returns a URL and LoginStateChanged/ErrorChanged use the typed
// arguments from the daemon contract.
const INTERFACE_XML = `
<node>
  <interface name="io.kanterlabs.Pulse1">
    <property name="Status" type="s" access="read"/>
    <property name="Playback" type="s" access="read"/>
    <property name="ActiveView" type="s" access="read"/>
    <property name="Offline" type="b" access="read"/>
    <property name="LastRefresh" type="x" access="read"/>
    <method name="Health">
      <arg name="health_json" type="s" direction="out"/>
    </method>
    <method name="GetSnapshot">
      <arg name="snapshot_json" type="s" direction="out"/>
    </method>
    <method name="Refresh"/>
    <method name="Search">
      <arg name="query" type="s" direction="in"/>
      <arg name="results_json" type="s" direction="out"/>
    </method>
    <method name="GetView">
      <arg name="view" type="s" direction="in"/>
      <arg name="cursor" type="s" direction="in"/>
      <arg name="view_json" type="s" direction="out"/>
    </method>
    <method name="GetAuthState">
      <arg name="auth_state_json" type="s" direction="out"/>
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
    <method name="BeginLogin">
      <arg name="authorization_url" type="s" direction="out"/>
    </method>
    <method name="Logout"/>
    <signal name="SnapshotChanged">
      <arg name="snapshot_json" type="s"/>
    </signal>
    <signal name="PlaybackChanged">
      <arg name="snapshot_json" type="s"/>
    </signal>
    <signal name="LoginStateChanged">
      <arg name="authenticated" type="b"/>
    </signal>
    <signal name="ErrorChanged">
      <arg name="code" type="s"/>
      <arg name="message" type="s"/>
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

function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return '';
}

function parseJsonValue(raw) {
    if (typeof raw !== 'string')
        return raw;
    try {
        return JSON.parse(raw);
    } catch (_error) {
        return null;
    }
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
    const value = parseJsonValue(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return disconnectedSnapshot(typeof raw === 'string'
            ? 'The daemon returned an invalid playback snapshot.'
            : '');

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

function namesFrom(value) {
    if (typeof value === 'string')
        return value.trim();
    if (!Array.isArray(value))
        return '';
    return value
        .map(entry => {
            if (typeof entry === 'string')
                return entry.trim();
            return firstString(entry?.name, entry?.title);
        })
        .filter(Boolean)
        .join(', ');
}

function imageUrl(value) {
    if (Array.isArray(value)) {
        for (const image of value) {
            const url = imageUrl(image);
            if (url)
                return url;
        }
        return '';
    }
    if (!value || typeof value !== 'object')
        return firstString(value);
    return firstString(value.url, value.uri, value.path);
}

function typeFromHint(hint) {
    const value = textOr(hint).toLowerCase().replace(/s$/, '');
    if (value === 'saved_track' || value === 'savedtrack' || value === 'track')
        return value === 'savedtrack' ? 'saved_track' : value;
    if (value === 'playlist' || value === 'album' || value === 'artist')
        return value;
    return value;
}

function normalizeResultItem(item, hint = '') {
    const value = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const nestedTrack = value.track && typeof value.track === 'object' ? value.track : null;
    const source = nestedTrack || value;
    const artists = namesFrom(source.artists || source.artist);
    const album = source.album && typeof source.album === 'object' ? source.album : null;
    const name = firstString(source.name, source.title, value.name, value.title);
    const title = firstString(source.title, source.name, value.title, value.name, name);
    const artist = firstString(source.artist, artists, value.artist);
    const sourceType = firstString(source.type, value.type, typeFromHint(hint));
    const subtitle = firstString(
        source.subtitle,
        value.subtitle,
        artist,
        album?.name,
        sourceType,
        'Spotify');
    const uri = firstString(source.uri, source.spotify_uri, value.uri, value.spotify_uri);
    const spotifyUrl = firstString(
        source.spotify_url,
        source.external_urls?.spotify,
        value.spotify_url,
        value.external_urls?.spotify,
        uri.startsWith('http') ? uri : '');
    const artUrl = firstString(
        source.art_url,
        source.artwork_url,
        source.image_url,
        value.art_url,
        value.artwork_url,
        value.image_url,
        imageUrl(source.images),
        imageUrl(album?.images),
        imageUrl(value.images));

    return {
        name,
        title,
        artist,
        subtitle,
        uri,
        spotify_url: spotifyUrl,
        art_url: artUrl,
        type: sourceType,
    };
}

const RESULT_BUCKETS = new Set([
    'tracks', 'albums', 'artists', 'playlists', 'episodes', 'shows',
    'saved_tracks', 'savedtracks', 'recently_played', 'recentlyplayed',
    'saved', 'liked', 'recent', 'sections', 'queue', 'items', 'results', 'data',
]);

function looksLikeItem(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    return Boolean(
        value.name || value.title || value.uri || value.spotify_url ||
        value.external_urls?.spotify || value.track);
}

function collectResultItems(value, hint = '', output = [], depth = 0) {
    if (output.length >= MAX_ITEMS || depth > 5 || value === null || value === undefined)
        return output;

    if (Array.isArray(value)) {
        for (const entry of value) {
            collectResultItems(entry, hint, output, depth + 1);
            if (output.length >= MAX_ITEMS)
                break;
        }
        return output;
    }

    if (typeof value !== 'object')
        return output;

    if (value.track && typeof value.track === 'object') {
        collectResultItems(value.track, firstString(hint, 'saved_track'), output, depth + 1);
        return output;
    }

    if (looksLikeItem(value)) {
        output.push(normalizeResultItem(value, hint));
        return output;
    }

    if (Array.isArray(value.items))
        collectResultItems(value.items, hint, output, depth + 1);
    if (Array.isArray(value.results))
        collectResultItems(value.results, hint, output, depth + 1);

    for (const [key, child] of Object.entries(value)) {
        if (key === 'items' || key === 'results' || !RESULT_BUCKETS.has(key.toLowerCase()))
            continue;
        collectResultItems(child, key, output, depth + 1);
        if (output.length >= MAX_ITEMS)
            break;
    }
    return output;
}

function optionalText(value, ...keys) {
    for (const key of keys) {
        if (typeof value?.[key] === 'string')
            return value[key];
    }
    return undefined;
}

function payloadError(value) {
    if (typeof value === 'string')
        return value.trim();
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return '';
    return firstString(value.message, value.error, value.code);
}

/**
 * Normalize all view and search replies to the extension's small UI contract.
 * Missing fields are harmless, nested Spotify response buckets are flattened,
 * and backend failures are represented as an empty page with an error string.
 */
export function normalizeViewPayload(raw, fallbackError = '') {
    const value = parseJsonValue(raw);
    if (value === null || value === undefined) {
        return JSON.stringify({
            items: [],
            state: 'error',
            error: textOr(fallbackError, 'The daemon returned invalid view data.'),
        });
    }

    if (typeof value !== 'object') {
        return JSON.stringify({
            items: [],
            state: 'error',
            error: textOr(fallbackError, 'The daemon returned invalid view data.'),
        });
    }

    const collectedItems = collectResultItems(value);
    const seenItems = new Set();
    const items = collectedItems.filter(item => {
        const key = item.uri || `${item.type}\u0000${item.name}\u0000${item.artist}`;
        if (seenItems.has(key))
            return false;
        seenItems.add(key);
        return true;
    });
    const payload = {items};
    const nextCursor = optionalText(value, 'next_cursor', 'nextCursor', 'cursor');
    if (nextCursor)
        payload.next_cursor = nextCursor;
    if (typeof value.stale === 'boolean')
        payload.stale = value.stale;
    if (typeof value.state === 'string' && value.state.trim())
        payload.state = value.state;
    else if (typeof value.status === 'string' && value.status.trim())
        payload.state = value.status;
    else if (typeof value.capability === 'string' && value.capability.trim())
        payload.state = value.capability;
    const error = payloadError(value.error);
    if (error)
        payload.error = error;
    else if (fallbackError)
        payload.error = fallbackError;

    return JSON.stringify(payload);
}

export function parseViewPayload(raw, fallbackError = '') {
    try {
        return JSON.parse(normalizeViewPayload(raw, fallbackError));
    } catch (_error) {
        return {items: [], state: 'error', error: 'The daemon returned invalid view data.'};
    }
}

function normalizeAuthState(raw, fallbackError = '') {
    const value = parseJsonValue(raw);
    if (typeof value === 'boolean') {
        return {
            authenticated: value,
            client_id_configured: null,
            state: value ? 'authenticated' : 'unauthenticated',
            error: textOr(fallbackError),
        };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {
            authenticated: false,
            client_id_configured: null,
            state: 'unknown',
            error: textOr(fallbackError, 'The daemon returned invalid authentication state.'),
        };
    }

    const configured = typeof value.client_id_configured === 'boolean'
        ? value.client_id_configured
        : typeof value.clientIdConfigured === 'boolean'
            ? value.clientIdConfigured
            : typeof value.configured === 'boolean'
                ? value.configured
                : typeof value.client_id === 'string'
                    ? Boolean(value.client_id.trim())
                    : null;
    const authenticated = typeof value.authenticated === 'boolean'
        ? value.authenticated
        : typeof value.spotify_authenticated === 'boolean'
            ? value.spotify_authenticated
            : typeof value.logged_in === 'boolean'
                ? value.logged_in
                : false;
    const state = firstString(value.state, value.status,
        authenticated ? 'authenticated' : 'unauthenticated');
    return {
        authenticated,
        client_id_configured: configured,
        state,
        error: firstString(value.error, fallbackError),
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

function unpackValues(parameters) {
    if (!parameters)
        return [];
    try {
        const values = parameters.deep_unpack();
        return Array.isArray(values) ? values : [values];
    } catch (_error) {
        return [];
    }
}

function errorMessage(error, fallback = 'Pulse could not complete that action.') {
    return textOr(error?.message, fallback);
}

export const PulseConnection = GObject.registerClass({
    Signals: {
        'snapshot-changed': {},
        'connection-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        'error-changed': {param_types: [GObject.TYPE_STRING]},
        'search-results': {param_types: [GObject.TYPE_STRING]},
        'view-results': {param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]},
        'auth-state-changed': {param_types: [GObject.TYPE_STRING]},
    },
}, class PulseConnection extends GObject.Object {
    _init() {
        super._init();
        this._proxy = null;
        this._proxySignals = [];
        this._searchCancellable = null;
        this._searchSequence = 0;
        this._viewCancellables = new Map();
        this._viewSequences = new Map();
        this._authSequence = 0;
        this._retrySource = 0;
        this._generation = 0;
        this._connected = false;
        this._error = '';
        this._snapshot = disconnectedSnapshot();
        this._authState = normalizeAuthState(null);
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

    get authState() {
        return this._authState;
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
        for (const cancellable of this._viewCancellables.values())
            cancellable.cancel();
        this._viewCancellables.clear();
        this._viewSequences.clear();
        this._searchSequence++;
        this._authSequence++;
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

        this._setAuthState(normalizeAuthState(null));
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
        this._searchSequence++;
        const sequence = this._searchSequence;
        if (this._searchCancellable) {
            this._searchCancellable.cancel();
            this._searchCancellable = null;
        }
        if (!value) {
            this.emit('search-results', normalizeViewPayload({items: []}));
            return;
        }

        const cancellable = new Gio.Cancellable();
        this._searchCancellable = cancellable;
        this._call('Search', new GLib.Variant('(s)', [value]), reply => {
            if (sequence !== this._searchSequence || this._searchCancellable !== cancellable)
                return;
            this._searchCancellable = null;
            const result = unpackFirst(reply);
            this.emit('search-results', normalizeViewPayload(result));
        }, cancellable, error => {
            if (sequence !== this._searchSequence || this._searchCancellable !== cancellable)
                return;
            this._searchCancellable = null;
            this.emit('search-results', normalizeViewPayload(null, errorMessage(error)));
        });
    }

    getView(view, cursor = '', onSuccess = null) {
        const name = String(view || 'home').trim() || 'home';
        const pageCursor = String(cursor || '');
        const previous = this._viewCancellables.get(name);
        if (previous)
            previous.cancel();

        const sequence = (this._viewSequences.get(name) || 0) + 1;
        this._viewSequences.set(name, sequence);
        const cancellable = new Gio.Cancellable();
        this._viewCancellables.set(name, cancellable);
        const emitResult = payload => {
            if (this._viewSequences.get(name) !== sequence ||
                this._viewCancellables.get(name) !== cancellable)
                return;
            this._viewCancellables.delete(name);
            this.emit('view-results', name, payload);
            if (onSuccess)
                onSuccess(payload);
        };
        const emitError = error => {
            if (this._viewSequences.get(name) !== sequence ||
                this._viewCancellables.get(name) !== cancellable)
                return;
            this._viewCancellables.delete(name);
            const payload = normalizeViewPayload(null, errorMessage(error));
            this.emit('view-results', name, payload);
        };

        this._call(
            'GetView',
            new GLib.Variant('(ss)', [name, pageCursor]),
            reply => emitResult(normalizeViewPayload(unpackFirst(reply))),
            cancellable,
            emitError);
    }

    getAuthState(onSuccess = null) {
        this._authSequence++;
        const sequence = this._authSequence;
        this._call('GetAuthState', new GLib.Variant('()', []), reply => {
            if (sequence !== this._authSequence)
                return;
            const state = normalizeAuthState(unpackFirst(reply));
            this._setAuthState(state);
            if (onSuccess)
                onSuccess(state);
        }, null, error => {
            if (sequence !== this._authSequence)
                return;
            const state = normalizeAuthState(this._authState, errorMessage(error));
            this._setAuthState(state);
            if (onSuccess)
                onSuccess(state);
        });
    }

    beginLogin(onSuccess = null, onError = null) {
        this._call('BeginLogin', new GLib.Variant('()', []), reply => {
            const authorizationUrl = textOr(unpackFirst(reply));
            if (authorizationUrl)
                onSuccess?.(authorizationUrl);
            else
                this._setError('Pulse returned an empty authorization URL.');
        }, null, error => {
            this._setError(errorMessage(error));
            onError?.(error);
        });
    }

    logout(onSuccess = null) {
        this._call('Logout', new GLib.Variant('()', []), () => {
            this._setAuthState(normalizeAuthState(false));
            onSuccess?.();
            this.getAuthState();
        });
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
        this.getAuthState();
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
            // GetSnapshot remains authoritative with daemons that do not expose
            // a cached Playback property.
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
            const values = unpackValues(parameters);
            const code = textOr(values[0]);
            const message = textOr(values[1], code);
            this._setError(code && message !== code ? `${code}: ${message}` : message);
            break;
        }
        case 'LoginStateChanged': {
            const authenticated = boolOr(unpackFirst(parameters));
            this._setAuthState(normalizeAuthState(authenticated));
            // The signal carries the fast path; GetAuthState fills in whether a
            // client ID is configured and any explanatory daemon state.
            this.getAuthState();
            break;
        }
        default:
            break;
        }
    }

    _call(method, parameters, onSuccess = null, cancellable = null, onError = null) {
        if (!this._proxy || !this._proxy.g_name_owner) {
            const error = new Error('The Pulse daemon is offline.');
            this._setDisconnected(error.message);
            this._scheduleRetry();
            onError?.(error);
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
                        onError?.(error);
                    }
                });
        } catch (error) {
            this._handleCallError(error);
            onError?.(error);
        }
    }

    _handleConnectionError(error) {
        const message = errorMessage(error, 'The Pulse daemon is unavailable.');
        this._setDisconnected(message);
        this._scheduleRetry();
    }

    _handleCallError(error) {
        const message = errorMessage(error);
        this._setError(message);
        if (error?.matches?.(Gio.DBusError, Gio.DBusError.SERVICE_UNKNOWN))
            this._setDisconnected('The Pulse daemon is offline.');
    }

    _setDisconnected(message) {
        this._setError(message);
        this._setSnapshot(disconnectedSnapshot(message));
        this._setAuthState(normalizeAuthState(null, message));
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

    _setAuthState(state) {
        const value = state && typeof state === 'object' ? state : normalizeAuthState(state);
        this._authState = value;
        this.emit('auth-state-changed', JSON.stringify(value));
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

export function parseAuthState(raw) {
    return normalizeAuthState(raw);
}
