import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'io.kanterlabs.Pulse';
const OBJECT_PATH = '/io/kanterlabs/Pulse';

// Keep this fixture aligned with the production bridge and dbus/io.kanterlabs.Pulse1.xml.
// The smoke test loads this file from the read-only repository mount; it is never
// installed as a production service.
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

const ARTWORK_URI = 'file:///workspace/assets/pulse-symbolic.svg';

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function json(value) {
    return JSON.stringify(value);
}

class PulseFixture {
    constructor() {
        this._snapshot = {
            status: 'ready',
            title: 'Fixture Track',
            artist: 'Fixture Artist',
            album: 'Fixture Album',
            art_url: ARTWORK_URI,
            spotify_url: 'https://open.spotify.com/track/pulse-smoke-fixture',
            length_us: 180000000,
            position_us: 42000000,
            playing: true,
            can_control: true,
            can_go_next: true,
            can_go_previous: true,
            can_seek: true,
            offline: false,
            error: '',
        };
        this._activeView = 'home';
        this._lastRefresh = GLib.get_real_time();
        this._authenticated = true;
        this._impl = null;
    }

    get Status() {
        return 'ready';
    }

    get Playback() {
        return json(this._snapshot);
    }

    get ActiveView() {
        return this._activeView;
    }

    get Offline() {
        return false;
    }

    get LastRefresh() {
        return this._lastRefresh;
    }

    Health() {
        return json({status: 'ok', fixture: 'pulse-gnome-smoke', authenticated: true});
    }

    GetSnapshot() {
        return json(clone(this._snapshot));
    }

    Refresh() {
        this._lastRefresh = GLib.get_real_time();
        this._emitSnapshot();
    }

    Search(query) {
        const value = String(query || '').trim();
        this._activeView = 'search';
        return json({
            state: value ? 'ready' : 'empty',
            items: value ? this._items().slice(0, 2) : [],
        });
    }

    GetView(view, _cursor) {
        const selected = String(view || 'home').trim() || 'home';
        this._activeView = selected;
        const items = {
            home: this._items().slice(0, 2),
            library: this._items(),
            queue: this._items().slice(0, 1),
        }[selected] || [];
        const payload = {
            state: 'ready',
            stale: false,
            items,
        };
        // Exercise both sides of the UI's `next_cursor` truthiness check:
        // home omits it, library sends an empty cursor, and queue exposes a
        // real cursor so the load-more button becomes visible.
        if (selected === 'library')
            payload.next_cursor = '';
        else if (selected === 'queue')
            payload.next_cursor = 'fixture-cursor';
        return json(payload);
    }

    GetAuthState() {
        return json({
            authenticated: this._authenticated,
            client_id_configured: true,
            state: this._authenticated ? 'authenticated' : 'unauthenticated',
            error: '',
        });
    }

    OpenUri(_uri) {
        // The UI path is exercised without launching a browser or a desktop app.
    }

    PlayPause() {
        this._snapshot.playing = !this._snapshot.playing;
        this._emitPlayback();
    }

    Next() {
        this._snapshot.title = 'Fixture Next Track';
        this._snapshot.position_us = 0;
        this._snapshot.playing = true;
        this._emitPlayback();
    }

    Previous() {
        this._snapshot.title = 'Fixture Previous Track';
        this._snapshot.position_us = 0;
        this._snapshot.playing = true;
        this._emitPlayback();
    }

    Seek(positionUs) {
        const value = Number(positionUs);
        this._snapshot.position_us = Number.isFinite(value) ? Math.max(0, value) : 0;
        this._emitPlayback();
    }

    BeginLogin() {
        return 'https://example.com/pulse-gnome-smoke-login';
    }

    Logout() {
        this._authenticated = false;
        this._emitLoginState();
    }

    _items() {
        return [
            {
                name: 'Fixture Track',
                artist: 'Fixture Artist',
                album: 'Fixture Album',
                uri: 'spotify:track:pulse-smoke-fixture',
                spotify_url: 'https://open.spotify.com/track/pulse-smoke-fixture',
                art_url: ARTWORK_URI,
                type: 'track',
            },
            {
                name: 'Fixture Album',
                artist: 'Fixture Artist',
                uri: 'spotify:album:pulse-smoke-fixture',
                art_url: ARTWORK_URI,
                type: 'album',
            },
            {
                name: 'Fixture Playlist',
                artist: 'Fixture Artist',
                uri: 'spotify:playlist:pulse-smoke-fixture',
                art_url: ARTWORK_URI,
                type: 'playlist',
            },
        ];
    }

    _emitSnapshot() {
        if (!this._impl)
            return;
        this._impl.emit_signal('SnapshotChanged', new GLib.Variant('(s)', [this.Playback]));
    }

    _emitPlayback() {
        if (!this._impl)
            return;
        this._impl.emit_signal('PlaybackChanged', new GLib.Variant('(s)', [this.Playback]));
    }

    _emitLoginState() {
        if (!this._impl)
            return;
        this._impl.emit_signal('LoginStateChanged', new GLib.Variant('(b)', [this._authenticated]));
    }
}

let fixture;
let exportedObject;

function onBusAcquired(connection, _name) {
    fixture = new PulseFixture();
    exportedObject = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, fixture);
    fixture._impl = exportedObject;
    exportedObject.export(connection, OBJECT_PATH);
}

function onNameAcquired(_connection, name) {
    print(`${name} fixture ready`);
}

function onNameLost(_connection, name) {
    print(`${name} fixture name lost`);
}

Gio.bus_own_name(
    Gio.BusType.SESSION,
    BUS_NAME,
    Gio.BusNameOwnerFlags.NONE,
    onBusAcquired,
    onNameAcquired,
    onNameLost);

GLib.MainLoop.new(null, false).run();
