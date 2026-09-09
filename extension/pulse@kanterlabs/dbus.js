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
const MAX_INFLIGHT_CALLS = 32;
const MAX_VIEW_REQUESTS = 16;
const MAX_JSON_LENGTH = 4 * 1024 * 1024;

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
    try {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    } catch (_error) {
        return fallback;
    }
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
    if (raw.length > MAX_JSON_LENGTH)
        return null;
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

function hasProperty(properties, name) {
    if (properties === null || properties === undefined)
        return false;

    let value = properties;
    try {
        if (typeof properties.deep_unpack === 'function')
            value = properties.deep_unpack();
    } catch (_error) {
        return false;
    }

    if (Array.isArray(value)) {
        if (value.length === 1 && value[0] && typeof value[0] === 'object' &&
            !Array.isArray(value[0]))
            return hasProperty(value[0], name);
        return value.some(entry => Array.isArray(entry)
            ? entry[0] === name
            : entry === name);
    }
    if (value instanceof Map)
        return value.has(name);
    return typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, name);
}

function errorMessage(error, fallback = 'Pulse could not complete that action.') {
    return textOr(error?.message, fallback);
}

function reportCallbackError(error) {
    try {
        globalThis.logError?.(error);
    } catch (_logError) {
        // Logging must never turn a contained callback failure into a shell
        // exception. The callback has already been prevented from escaping.
    }
}

function observeCallbackResult(result) {
    if (!result || typeof result.catch !== 'function')
        return;
    try {
        result.catch(reportCallbackError);
    } catch (error) {
        reportCallbackError(error);
    }
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
        this._destroyed = false;
        this._proxy = null;
        this._proxySignals = [];
        this._proxyCancellable = null;
        this._proxyOwner = null;
        this._ownerEpoch = 0;
        this._pendingCancellables = new Set();
        this._searchCancellable = null;
        this._searchSequence = 0;
        this._refreshCancellable = null;
        this._snapshotCancellable = null;
        this._snapshotSequence = 0;
        this._viewCancellables = new Map();
        this._viewSequences = new Map();
        this._viewRequestOrder = [];
        this._authSequence = 0;
        this._authCancellable = null;
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
        if (!this._isAlive())
            return;

        const generation = ++this._generation;
        const cancellable = new Gio.Cancellable();
        this._proxyCancellable = cancellable;
        try {
            Gio.DBusProxy.new_for_bus(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                getInterfaceInfo(),
                BUS_NAME,
                OBJECT_PATH,
                INTERFACE_NAME,
                cancellable,
                (_source, result) => {
                    if (this._proxyCancellable === cancellable)
                        this._proxyCancellable = null;
                    let proxy;
                    try {
                        proxy = Gio.DBusProxy.new_for_bus_finish(result);
                    } catch (error) {
                        if (this._isCurrent(generation))
                            this._handleConnectionError(error);
                        return;
                    }
                    if (!this._isCurrent(generation))
                        return;
                    this._attachProxy(proxy, generation);
                });
        } catch (error) {
            if (this._proxyCancellable === cancellable)
                this._proxyCancellable = null;
            this._handleConnectionError(error);
        }
    }

    stop() {
        this._generation++;
        this._cancelCancellable(this._proxyCancellable);
        this._proxyCancellable = null;
        this._cancelPendingRequests();
        this._proxyOwner = null;
        this._ownerEpoch++;
        if (this._retrySource) {
            try {
                GLib.Source.remove(this._retrySource);
            } catch (_error) {
                // The source may already have fired and removed itself.
            }
            this._retrySource = 0;
        }

        for (const [object, id] of this._proxySignals) {
            try {
                object.disconnect(id);
            } catch (_error) {
                // A proxy can dispose itself while its owner disappears.
            }
        }
        this._proxySignals = [];
        this._proxy = null;
        // Disconnecting the proxy signals and dropping our reference lets GIO
        // release it naturally after any cancelled calls have settled.

        if (this._connected) {
            this._connected = false;
            if (this._isAlive())
                this._emitSafely('connection-changed', false);
        }

        if (!this._isAlive())
            return;

        this._setAuthState(normalizeAuthState(null));
        if (this._isAlive())
            this._setSnapshot(disconnectedSnapshot());
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this.stop();
    }

    refresh() {
        if (!this._isAlive())
            return;
        this._cancelCancellable(this._refreshCancellable);
        const cancellable = new Gio.Cancellable();
        this._refreshCancellable = cancellable;
        const clear = () => {
            if (this._refreshCancellable === cancellable)
                this._refreshCancellable = null;
        };
        this._call(
            'Refresh',
            new GLib.Variant('()', []),
            () => {
                clear();
                if (this._isAlive())
                    this._requestSnapshot();
            },
            cancellable,
            () => clear());
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
        if (!this._isAlive() || !uri)
            return;
        let value;
        try {
            value = String(uri);
        } catch (_error) {
            this._setError('Pulse received an invalid URI.');
            return;
        }
        if (!value.trim())
            return;
        this._call('OpenUri', new GLib.Variant('(s)', [value]));
    }

    search(query) {
        if (!this._isAlive())
            return;
        let value;
        try {
            value = String(query ?? '').trim();
        } catch (_error) {
            value = '';
        }
        this._searchSequence++;
        const sequence = this._searchSequence;
        if (this._searchCancellable) {
            this._cancelCancellable(this._searchCancellable);
            this._searchCancellable = null;
        }
        if (!value) {
            this._emitSafely('search-results', normalizeViewPayload({items: []}));
            return;
        }

        const cancellable = new Gio.Cancellable();
        this._searchCancellable = cancellable;
        this._call('Search', new GLib.Variant('(s)', [value]), reply => {
            if (sequence !== this._searchSequence || this._searchCancellable !== cancellable)
                return;
            this._searchCancellable = null;
            const result = unpackFirst(reply);
            this._emitSafely('search-results', normalizeViewPayload(result));
        }, cancellable, error => {
            if (sequence !== this._searchSequence || this._searchCancellable !== cancellable)
                return;
            this._searchCancellable = null;
            this._emitSafely('search-results', normalizeViewPayload(null, errorMessage(error)));
        });
    }

    getView(view, cursor = '', onSuccess = null) {
        if (!this._isAlive())
            return;
        let name;
        let pageCursor;
        try {
            name = String(view || 'home').trim() || 'home';
            pageCursor = String(cursor || '');
        } catch (_error) {
            name = 'home';
            pageCursor = '';
        }
        const previous = this._viewCancellables.get(name);
        if (previous)
            this._cancelCancellable(previous);

        const sequence = (this._viewSequences.get(name) || 0) + 1;
        this._viewSequences.set(name, sequence);
        const cancellable = new Gio.Cancellable();
        this._viewCancellables.set(name, cancellable);
        this._viewRequestOrder = this._viewRequestOrder.filter(entry => entry !== name);
        this._viewRequestOrder.push(name);
        while (this._viewRequestOrder.length > MAX_VIEW_REQUESTS) {
            const evicted = this._viewRequestOrder.shift();
            if (evicted === name)
                continue;
            this._cancelCancellable(this._viewCancellables.get(evicted));
            this._viewCancellables.delete(evicted);
            this._viewSequences.delete(evicted);
        }
        const emitResult = payload => {
            if (this._viewSequences.get(name) !== sequence ||
                this._viewCancellables.get(name) !== cancellable)
                return;
            this._emitSafely('view-results', name, payload);
            if (!this._isAlive() || this._viewSequences.get(name) !== sequence ||
                this._viewCancellables.get(name) !== cancellable)
                return;
            this._viewCancellables.delete(name);
            this._viewSequences.delete(name);
            this._viewRequestOrder = this._viewRequestOrder.filter(entry => entry !== name);
            this._invokeCallback(onSuccess, payload);
        };
        const emitError = error => {
            if (this._viewSequences.get(name) !== sequence ||
                this._viewCancellables.get(name) !== cancellable)
                return;
            const payload = normalizeViewPayload(null, errorMessage(error));
            this._emitSafely('view-results', name, payload);
            if (!this._isAlive() || this._viewSequences.get(name) !== sequence ||
                this._viewCancellables.get(name) !== cancellable)
                return;
            this._viewCancellables.delete(name);
            this._viewSequences.delete(name);
            this._viewRequestOrder = this._viewRequestOrder.filter(entry => entry !== name);
        };

        this._call(
            'GetView',
            new GLib.Variant('(ss)', [name, pageCursor]),
            reply => emitResult(normalizeViewPayload(unpackFirst(reply))),
            cancellable,
            emitError);
    }

    getAuthState(onSuccess = null) {
        if (!this._isAlive())
            return;
        this._authSequence++;
        const sequence = this._authSequence;
        this._cancelCancellable(this._authCancellable);
        const cancellable = new Gio.Cancellable();
        this._authCancellable = cancellable;
        const clear = () => {
            if (this._authCancellable === cancellable)
                this._authCancellable = null;
        };
        this._call('GetAuthState', new GLib.Variant('()', []), reply => {
            if (sequence !== this._authSequence)
                return;
            clear();
            const state = normalizeAuthState(unpackFirst(reply));
            this._setAuthState(state);
            if (this._isAlive())
                this._invokeCallback(onSuccess, state);
        }, cancellable, error => {
            if (sequence !== this._authSequence)
                return;
            clear();
            const state = normalizeAuthState(this._authState, errorMessage(error));
            this._setAuthState(state);
            if (this._isAlive())
                this._invokeCallback(onSuccess, state);
        });
    }

    beginLogin(onSuccess = null, onError = null) {
        if (!this._isAlive())
            return;
        this._call('BeginLogin', new GLib.Variant('()', []), reply => {
            const authorizationUrl = textOr(unpackFirst(reply));
            if (authorizationUrl) {
                this._invokeCallback(onSuccess, authorizationUrl);
            } else if (this._isAlive()) {
                this._setError('Pulse returned an empty authorization URL.');
            }
        }, null, error => {
            if (!this._isAlive())
                return;
            this._setError(errorMessage(error));
            if (this._isAlive())
                this._invokeCallback(onError, error);
        });
    }

    logout(onSuccess = null) {
        if (!this._isAlive())
            return;
        this._call('Logout', new GLib.Variant('()', []), () => {
            if (!this._isAlive())
                return;
            this._setAuthState(normalizeAuthState(false));
            if (!this._isAlive())
                return;
            this._invokeCallback(onSuccess);
            if (this._isAlive())
                this.getAuthState();
        });
    }

    _attachProxy(proxy, generation) {
        if (!proxy) {
            if (this._isCurrent(generation))
                this._handleConnectionError(new Error('Pulse returned an empty DBus proxy.'));
            return;
        }
        if (!this._isCurrent(generation))
            return;

        if (this._proxy && this._proxy !== proxy)
            this._detachProxy();
        this._proxy = proxy;
        this._proxyOwner = null;
        try {
            this._proxySignals = [];
            this._proxySignals.push([
                proxy,
                proxy.connect('g-signal', (_proxy, _sender, signalName, parameters) => {
                    this._runSafely(() => this._handleSignal(proxy, generation, signalName, parameters));
                }),
            ]);
            this._proxySignals.push([
                proxy,
                proxy.connect('g-properties-changed', (_proxy, changedProperties, invalidatedProperties) => {
                    this._runSafely(() => this._readCachedSnapshot(
                        proxy, generation, changedProperties, invalidatedProperties));
                }),
            ]);
            this._proxySignals.push([
                proxy,
                proxy.connect('notify::g-name-owner', () => {
                    this._runSafely(() => this._syncProxyOwner(proxy, generation));
                }),
            ]);
        } catch (error) {
            this._detachProxy();
            if (this._isCurrent(generation))
                this._handleConnectionError(error);
            return;
        }

        this._runSafely(() => this._syncProxyOwner(proxy, generation));
    }

    _syncProxyOwner(proxy = this._proxy, generation = this._generation) {
        if (!this._isCurrent(generation) || !proxy || this._proxy !== proxy)
            return;

        let hasOwner;
        let owner;
        try {
            owner = textOr(proxy.g_name_owner);
            hasOwner = Boolean(owner);
        } catch (error) {
            this._handleConnectionError(error);
            return;
        }
        if (owner !== this._proxyOwner) {
            const replacingOwner = Boolean(this._proxyOwner);
            this._proxyOwner = owner;
            this._ownerEpoch++;
            this._cancelPendingRequests();
            // A bus name can move directly between owners without an empty
            // intermediate value. Clear UI actions tied to the old daemon.
            if (replacingOwner)
                this._setDisconnected('The Pulse daemon connection changed.');
            if (!this._isCurrent(generation))
                return;
        }
        if (!hasOwner) {
            this._setDisconnected('The Pulse daemon is offline.');
            if (this._isAlive())
                this._scheduleRetry(generation);
            return;
        }

        if (!this._connected) {
            this._connected = true;
            this._error = '';
            this._emitSafely('connection-changed', true);
        }
        if (!this._isCurrent(generation))
            return;
        this._requestSnapshot();
        if (this._isCurrent(generation))
            this.getAuthState();
    }

    _requestSnapshot() {
        if (!this._isAlive())
            return;
        this._invalidateSnapshotRequest();
        const sequence = this._snapshotSequence;
        const cancellable = new Gio.Cancellable();
        this._snapshotCancellable = cancellable;
        const clear = () => {
            if (this._snapshotCancellable === cancellable)
                this._snapshotCancellable = null;
        };
        this._call('GetSnapshot', new GLib.Variant('()', []), reply => {
            clear();
            if (sequence !== this._snapshotSequence)
                return;
            const raw = unpackFirst(reply);
            if (raw !== null && this._isAlive())
                this._setSnapshot(normalizeSnapshot(raw));
        }, cancellable, () => clear());
    }

    _readCachedSnapshot(
        proxy = this._proxy,
        generation = this._generation,
        changedProperties = undefined,
        invalidatedProperties = undefined) {
        if (!this._isCurrentProxy(proxy, generation))
            return;
        const hasChangedPlayback = hasProperty(changedProperties, 'Playback');
        const hasInvalidatedPlayback = hasProperty(invalidatedProperties, 'Playback');
        if (changedProperties !== undefined || invalidatedProperties !== undefined) {
            if (!hasChangedPlayback && !hasInvalidatedPlayback)
                return;
            if (hasInvalidatedPlayback && !hasChangedPlayback) {
                this._requestSnapshot();
                return;
            }
        }

        try {
            const value = proxy.get_cached_property('Playback');
            const raw = unpackFirst(value);
            if (raw !== null && this._isCurrent(generation))
                this._applyAuthoritativeSnapshot(raw);
        } catch (_error) {
            // GetSnapshot remains authoritative with daemons that do not expose
            // a cached Playback property.
        }
    }

    _handleSignal(proxy, generation, signalName, parameters) {
        // Keep the old private-call shape usable for lightweight harnesses and
        // callers that only have a signal name. Proxy-bound callbacks always
        // use the generation-aware form above.
        if (typeof proxy === 'string') {
            parameters = generation;
            signalName = proxy;
            proxy = this._proxy;
            generation = this._generation;
        }
        if (!this._isCurrentProxy(proxy, generation))
            return;
        switch (signalName) {
        case 'SnapshotChanged':
        case 'PlaybackChanged': {
            const raw = unpackFirst(parameters);
            if (raw !== null && this._isCurrent(generation))
                this._applyAuthoritativeSnapshot(raw);
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
            if (this._isCurrent(generation))
                this.getAuthState();
            break;
        }
        default:
            break;
        }
    }

    _call(method, parameters, onSuccess = null, cancellable = null, onError = null) {
        if (!this._isAlive())
            return false;

        let proxy = this._proxy;
        let hasOwner = false;
        try {
            hasOwner = Boolean(proxy?.g_name_owner);
        } catch (error) {
            this._handleCallError(error, cancellable);
            if (this._isAlive())
                this._invokeCallback(onError, error);
            return false;
        }
        if (!proxy || !hasOwner) {
            const error = new Error('The Pulse daemon is offline.');
            this._invalidateOwnerRequests(cancellable);
            this._setDisconnected(error.message);
            if (this._isAlive()) {
                this._scheduleRetry();
                this._invokeCallback(onError, error);
            }
            return false;
        }

        const generation = this._generation;
        const ownerEpoch = this._ownerEpoch;
        const requestCancellable = cancellable || new Gio.Cancellable();
        if (requestCancellable.is_cancelled?.())
            return false;
        if (!this._trackCancellable(requestCancellable)) {
            const error = new Error('Pulse has too many pending DBus requests.');
            this._handleCallError(error);
            if (this._isAlive())
                this._invokeCallback(onError, error);
            return false;
        }
        let settled = false;
        const cleanup = () => {
            if (settled)
                return;
            settled = true;
            this._pendingCancellables.delete(requestCancellable);
        };
        try {
            proxy.call(
                method,
                parameters,
                Gio.DBusCallFlags.NONE,
                -1,
                requestCancellable,
                (replyProxy, result) => {
                    cleanup();
                    let reply;
                    try {
                        reply = replyProxy.call_finish(result);
                    } catch (error) {
                        if (requestCancellable.is_cancelled?.() || !this._isCurrent(generation) ||
                            this._ownerEpoch !== ownerEpoch || this._proxy !== proxy ||
                            replyProxy !== proxy)
                            return;
                        this._handleCallError(error, requestCancellable);
                        if (this._isAlive())
                            this._invokeCallback(onError, error);
                        return;
                    }
                    if (this._isCurrent(generation) && this._ownerEpoch === ownerEpoch &&
                        this._proxy === proxy && replyProxy === proxy &&
                        !requestCancellable.is_cancelled?.())
                        this._invokeCallback(onSuccess, reply);
                });
        } catch (error) {
            cleanup();
            if (!this._isCurrent(generation) || requestCancellable.is_cancelled?.())
                return false;
            this._handleCallError(error, requestCancellable);
            if (this._isAlive())
                this._invokeCallback(onError, error);
            return false;
        }
        return true;
    }

    _handleConnectionError(error) {
        if (!this._isAlive())
            return;
        const message = errorMessage(error, 'The Pulse daemon is unavailable.');
        this._setDisconnected(message);
        if (this._isAlive())
            this._scheduleRetry(this._generation);
    }

    _handleCallError(error, requestCancellable = null) {
        if (!this._isAlive())
            return;
        const message = errorMessage(error);
        this._setError(message);
        if (!this._isAlive())
            return;
        const serviceUnknown = Boolean(error?.matches?.(Gio.DBusError, Gio.DBusError.SERVICE_UNKNOWN));
        if (serviceUnknown) {
            this._invalidateOwnerRequests(requestCancellable);
            this._setDisconnected('The Pulse daemon is offline.');
            if (this._isAlive())
                this._scheduleRetry(this._generation);
        }
    }

    _setDisconnected(message) {
        if (!this._isAlive())
            return;
        this._setError(message);
        if (!this._isAlive())
            return;
        this._invalidateSnapshotRequest();
        this._setSnapshot(disconnectedSnapshot(message));
        if (!this._isAlive())
            return;
        this._setAuthState(normalizeAuthState(null, message));
        if (!this._isAlive())
            return;
        if (this._connected) {
            this._connected = false;
            this._emitSafely('connection-changed', false);
        }
    }

    _setError(message) {
        if (!this._isAlive())
            return;
        const value = textOr(message);
        if (value === this._error)
            return;
        this._error = value;
        this._emitSafely('error-changed', value);
    }

    _setAuthState(state) {
        if (!this._isAlive())
            return;
        const value = state && typeof state === 'object' ? state : normalizeAuthState(state);
        this._authState = value;
        let payload;
        try {
            payload = JSON.stringify(value);
        } catch (_error) {
            payload = JSON.stringify(normalizeAuthState(null, 'The daemon returned invalid authentication state.'));
        }
        this._emitSafely('auth-state-changed', textOr(payload, '{}'));
    }

    _setSnapshot(snapshot) {
        if (!this._isAlive())
            return;
        this._snapshot = snapshot;
        this._emitSafely('snapshot-changed');
    }

    _scheduleRetry(generation = this._generation) {
        if (!this._isCurrent(generation) || this._retrySource)
            return;

        let sourceId = 0;
        try {
            sourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RETRY_SECONDS, () => {
                if (this._retrySource === sourceId)
                    this._retrySource = 0;
                if (!this._isCurrent(generation))
                    return GLib.SOURCE_REMOVE;
                try {
                    if (!this._proxy || !this._connected)
                        this.start();
                } catch (error) {
                    if (this._isCurrent(generation))
                        this._handleConnectionError(error);
                }
                return GLib.SOURCE_REMOVE;
            });
            this._retrySource = sourceId;
        } catch (error) {
            if (this._isCurrent(generation))
                this._setError(errorMessage(error, 'Pulse could not schedule a reconnect.'));
        }
    }

    _isAlive() {
        return !this._destroyed;
    }

    _isCurrent(generation) {
        return this._isAlive() && generation === this._generation;
    }

    _isCurrentProxy(proxy, generation) {
        if (!this._isCurrent(generation) || !proxy || this._proxy !== proxy)
            return false;
        try {
            const owner = textOr(proxy.g_name_owner);
            return Boolean(owner) && owner === this._proxyOwner;
        } catch (_error) {
            return false;
        }
    }

    _invokeCallback(callback, ...args) {
        if (!this._isAlive() || typeof callback !== 'function')
            return;
        try {
            observeCallbackResult(callback(...args));
        } catch (error) {
            reportCallbackError(error);
        }
    }

    _emitSafely(signalName, ...args) {
        if (!this._isAlive())
            return;
        try {
            this.emit(signalName, ...args);
        } catch (error) {
            reportCallbackError(error);
        }
    }

    _runSafely(callback) {
        if (!this._isAlive() || typeof callback !== 'function')
            return;
        try {
            observeCallbackResult(callback());
        } catch (error) {
            reportCallbackError(error);
        }
    }

    _cancelCancellable(cancellable) {
        if (!cancellable)
            return;
        this._pendingCancellables.delete(cancellable);
        try {
            cancellable.cancel();
        } catch (error) {
            reportCallbackError(error);
        }
    }

    _cancelPendingRequests(except = null) {
        if (this._searchCancellable !== except) {
            this._searchSequence++;
            this._searchCancellable = null;
        }
        if (this._refreshCancellable !== except)
            this._refreshCancellable = null;
        if (this._snapshotCancellable !== except) {
            this._snapshotSequence++;
            this._snapshotCancellable = null;
        }
        if (this._authCancellable !== except) {
            this._authSequence++;
            this._authCancellable = null;
        }
        for (const [name, cancellable] of [...this._viewCancellables]) {
            if (cancellable === except)
                continue;
            this._cancelCancellable(cancellable);
            this._viewCancellables.delete(name);
            this._viewSequences.delete(name);
        }
        this._viewRequestOrder = this._viewRequestOrder.filter(name =>
            this._viewCancellables.has(name));
        for (const cancellable of this._pendingCancellables) {
            if (cancellable !== except)
                this._cancelCancellable(cancellable);
        }
        this._pendingCancellables.clear();
    }

    _invalidateOwnerRequests(except = null) {
        this._ownerEpoch++;
        this._proxyOwner = null;
        this._cancelPendingRequests(except);
    }

    _invalidateSnapshotRequest() {
        this._snapshotSequence++;
        this._cancelCancellable(this._snapshotCancellable);
        this._snapshotCancellable = null;
    }

    _applyAuthoritativeSnapshot(raw) {
        this._invalidateSnapshotRequest();
        this._setSnapshot(normalizeSnapshot(raw));
    }

    _trackCancellable(cancellable) {
        if (!cancellable)
            return false;
        if (this._pendingCancellables.size >= MAX_INFLIGHT_CALLS &&
            !this._pendingCancellables.has(cancellable))
            return false;
        this._pendingCancellables.add(cancellable);
        return true;
    }

    _detachProxy() {
        for (const [object, id] of this._proxySignals) {
            try {
                object.disconnect(id);
            } catch (_error) {
                // Disconnection is best effort during bus teardown.
            }
        }
        this._proxySignals = [];
        this._proxy = null;
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
