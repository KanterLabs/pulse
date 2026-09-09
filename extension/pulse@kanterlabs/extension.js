import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BarLevel from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {PulseConnection, parseAuthState, parseViewPayload} from './dbus.js';

const TOGGLE_SHORTCUT = 'toggle-shortcut';
const PROGRESS_TICK_SECONDS = 1;
const AUTH_POLL_SECONDS = 2;
const AUTH_POLL_LIMIT = 150;
const SEARCH_DELAY_MS = 260;
const MAX_SEARCH_RESULTS = 8;
const MAX_VIEW_ROWS = 36;

function toggleStyleClass(actor, name, enabled) {
    if (enabled)
        actor.add_style_class_name(name);
    else
        actor.remove_style_class_name(name);
}

function displayText(value, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
}

function finitePosition(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, number)) : 0;
}

function cleanup(callback) {
    try {
        callback();
    } catch (error) {
        // One failed teardown step must not leave the remaining sources alive.
        console.error('Pulse cleanup failed', error);
    }
}

function formatTime(microseconds) {
    const seconds = Math.floor(finitePosition(microseconds) / 1000000);
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function localArtworkUri(value) {
    return typeof value === 'string' && (value.startsWith('file://') || value.startsWith('/'));
}

function itemLabel(item) {
    if (!item || typeof item !== 'object')
        return '';
    return displayText(item.name, displayText(item.title, displayText(item.uri, 'Untitled')));
}

function itemSubtitle(item) {
    if (!item || typeof item !== 'object')
        return 'Spotify';
    const artist = displayText(item.artist);
    const subtitle = displayText(item.subtitle);
    const type = displayText(item.type);
    return artist || subtitle || type || 'Spotify';
}

function itemUri(item) {
    if (!item || typeof item !== 'object')
        return '';
    return displayText(item.uri, displayText(item.spotify_url));
}

function safeAuthorizationUri(value) {
    // The daemon's PKCE authorization endpoint is HTTPS. Restricting this to
    // HTTPS avoids turning a login response into an arbitrary local launch.
    return typeof value === 'string' && /^https:\/\//i.test(value.trim())
        ? value.trim()
        : '';
}

const PulseIndicator = GObject.registerClass(
class PulseIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Pulse', false);
        this._destroyed = false;
        this._menuSignalId = 0;
        this._signalIds = [];
        this._settingsSignalIds = [];
        this._themeSettings = null;
        this._themeSignalId = 0;
        this._progressSource = 0;
        this._authPollSource = 0;
        this._authPollAttempts = 0;
        this._searchSource = 0;
        this._currentPositionUs = 0;
        this._artworkUri = '';
        this._view = 'home';
        this._viewData = new Map();
        this._viewRequests = new Map();
        this._searchPayload = {items: []};
        this._pendingAuthorizationUrl = '';
        this._loginInProgress = false;
        this._launchCancellable = null;
        this._positionUpdatedAt = GLib.get_monotonic_time();
    }

    // Keep the actor reachable before any of the fallible menu setup runs.
    // disable() can then destroy the partial tree if initialization throws.
    initialize(connection, settings, extensionDir) {
        this._connection = connection;
        this._settings = settings;
        this._extensionDir = extensionDir;
        this._pulseGIcon = this._loadBundledIcon();
        this._snapshot = connection.snapshot;
        this._authState = connection.authState;
        this._buildPanelButton();
        this._buildPopover();
        this._connectSignals();
        this._syncTheme();
        this._syncSettings();
        this._renderAuthState();
    }

    _buildPanelButton() {
        this._panelBox = new St.BoxLayout({style_class: 'pulse-panel-box'});
        this.add_child(this._panelBox);
        this._panelIcon = new St.Icon({style_class: 'system-status-icon pulse-panel-icon'});
        this._panelBox.add_child(this._panelIcon);
        if (this._pulseGIcon)
            this._panelIcon.gicon = this._pulseGIcon;
        this._panelDot = new St.Widget({style_class: 'pulse-panel-dot'});
        this._panelBox.add_child(this._panelDot);
        this.accessible_name = 'Pulse music controls';
    }

    _buildPopover() {
        this.menu.box.add_style_class_name('pulse-popover');
        this.menu.box.set_width(372);
        this._menuSignalId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (this._destroyed)
                return;
            this._syncProgressTimer();
            if (!open)
                return;
            // Opening is an explicit user action, so refresh the lightweight
            // playback snapshot and the active command-centre view together.
            this._connection.refresh();
            this._connection.getAuthState();
            this._loadView(this._view, '', false);
        });

        this._buildNowPlaying();
        this._buildProgress();
        this._buildControls();
        this._buildAuth();
        this._buildNavigation();
        this._buildPage();
    }

    _buildNowPlaying() {
        this._nowPlayingItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'pulse-now-playing-item',
        });
        this.menu.addMenuItem(this._nowPlayingItem);

        const row = new St.BoxLayout({style_class: 'pulse-now-playing-row'});
        this._nowPlayingItem.add_child(row);
        const artworkFrame = new St.Bin({style_class: 'pulse-artwork-frame'});
        row.add_child(artworkFrame);
        this._artwork = new St.Icon({
            icon_size: 72,
            style_class: 'pulse-artwork',
        });
        artworkFrame.set_child(this._artwork);
        if (this._pulseGIcon)
            this._artwork.gicon = this._pulseGIcon;

        const details = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'pulse-track-details',
        });
        row.add_child(details);
        this._statusLabel = new St.Label({style_class: 'pulse-status-label'});
        details.add_child(this._statusLabel);
        this._titleLabel = new St.Label({style_class: 'pulse-title-label'});
        details.add_child(this._titleLabel);
        this._artistLabel = new St.Label({style_class: 'pulse-artist-label'});
        details.add_child(this._artistLabel);
        this._albumLabel = new St.Label({style_class: 'pulse-album-label'});
        details.add_child(this._albumLabel);
        for (const label of [this._statusLabel, this._titleLabel, this._artistLabel, this._albumLabel]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            label.clutter_text.single_line_mode = true;
        }
    }

    _buildProgress() {
        this._progressItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'pulse-progress-item',
        });
        this.menu.addMenuItem(this._progressItem);
        const column = new St.BoxLayout({vertical: true, x_expand: true});
        this._progressItem.add_child(column);
        this._progress = new BarLevel.BarLevel({
            style_class: 'barlevel pulse-progress-bar',
            x_expand: true,
            value: 0,
        });
        column.add_child(this._progress);
        const times = new St.BoxLayout({x_expand: true, style_class: 'pulse-time-row'});
        column.add_child(times);
        this._positionLabel = new St.Label({text: '0:00', style_class: 'pulse-time-label'});
        times.add_child(this._positionLabel);
        this._durationLabel = new St.Label({text: '0:00', style_class: 'pulse-time-label'});
        times.add_child(this._durationLabel);
        times.add_child(new St.Widget({x_expand: true}));
    }

    _buildControls() {
        this._controlsItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'pulse-controls-item',
        });
        this.menu.addMenuItem(this._controlsItem);
        const column = new St.BoxLayout({vertical: true, x_expand: true});
        this._controlsItem.add_child(column);
        const controls = new St.BoxLayout({
            style_class: 'pulse-controls',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        column.add_child(controls);

        this._previousButton = this._makeIconButton(
            'media-skip-backward-symbolic',
            'Previous track',
            () => this._connection.previous());
        controls.add_child(this._previousButton);
        this._playButton = this._makeIconButton(
            'media-playback-start-symbolic',
            'Play',
            () => this._connection.playPause(),
            'pulse-play-button');
        controls.add_child(this._playButton);
        this._nextButton = this._makeIconButton(
            'media-skip-forward-symbolic',
            'Next track',
            () => this._connection.next());
        controls.add_child(this._nextButton);

        this._openButton = new St.Button({
            style_class: 'pulse-open-button',
            label: 'Open in Spotify',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        column.add_child(this._openButton);
        this._openButton.accessible_name = 'Open current track in Spotify';
        this._openButton.connect('clicked', () => {
            const uri = this._snapshot.spotify_url || 'spotify:';
            this._connection.openUri(uri);
        });
    }

    _buildAuth() {
        this._authItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'pulse-auth-item',
        });
        this.menu.addMenuItem(this._authItem);
        const column = new St.BoxLayout({vertical: true, x_expand: true});
        this._authItem.add_child(column);
        this._authStatusLabel = new St.Label({style_class: 'pulse-auth-status'});
        column.add_child(this._authStatusLabel);
        this._authStatusLabel.clutter_text.line_wrap = true;
        this._authStatusLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;

        const actions = new St.BoxLayout({style_class: 'pulse-auth-actions', x_expand: true});
        column.add_child(actions);
        this._loginButton = new St.Button({
            style_class: 'pulse-auth-button',
            label: 'Connect Spotify',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        actions.add_child(this._loginButton);
        this._loginButton.accessible_name = 'Connect Spotify';
        this._loginButton.connect('clicked', () => this._beginLogin());

        this._authorizationButton = new St.Button({
            style_class: 'pulse-auth-button',
            label: 'Open Spotify sign-in',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        actions.add_child(this._authorizationButton);
        this._authorizationButton.accessible_name = 'Open Spotify sign-in in a browser';
        this._authorizationButton.visible = false;
        this._authorizationButton.connect('clicked', () => this._openAuthorizationUrl());

        this._logoutButton = new St.Button({
            style_class: 'pulse-auth-button',
            label: 'Log out',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        actions.add_child(this._logoutButton);
        this._logoutButton.accessible_name = 'Log out of Spotify';
        this._logoutButton.visible = false;
        this._logoutButton.connect('clicked', () => this._connection.logout());
    }

    _buildNavigation() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._navigationItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'pulse-navigation-item',
        });
        this.menu.addMenuItem(this._navigationItem);
        const nav = new St.BoxLayout({style_class: 'pulse-navigation', x_expand: true});
        this._navigationItem.add_child(nav);
        this._homeButton = this._makeNavButton('Home', 'home', 'go-home-symbolic');
        nav.add_child(this._homeButton);
        this._searchButton = this._makeNavButton('Search', 'search', 'system-search-symbolic');
        nav.add_child(this._searchButton);
        this._libraryButton = this._makeNavButton('Library', 'library', 'folder-music-symbolic');
        nav.add_child(this._libraryButton);
        this._queueButton = this._makeNavButton('Queue', 'queue', 'view-list-symbolic');
        nav.add_child(this._queueButton);
    }

    _buildPage() {
        this._pageItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'pulse-page-item',
        });
        this.menu.addMenuItem(this._pageItem);
        this._pageBox = new St.BoxLayout({vertical: true, x_expand: true});
        this._pageItem.add_child(this._pageBox);
        this._pageTitle = new St.Label({style_class: 'pulse-page-title'});
        this._pageBox.add_child(this._pageTitle);
        this._pageBody = new St.Label({style_class: 'pulse-page-body'});
        this._pageBox.add_child(this._pageBody);
        this._pageBody.clutter_text.line_wrap = true;
        this._pageBody.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;

        this._searchEntry = new St.Entry({
            style_class: 'pulse-search-entry',
            hint_text: 'Search your music',
            can_focus: true,
            reactive: true,
            x_expand: true,
        });
        this._pageBox.add_child(this._searchEntry);
        this._searchEntry.accessible_name = 'Search your music';
        this._searchEntry.get_clutter_text().connect('text-changed', () => this._scheduleSearch());
        this._resultsBox = new St.BoxLayout({
            vertical: true,
            style_class: 'pulse-search-results',
            x_expand: true,
        });
        this._pageBox.add_child(this._resultsBox);
        this._loadMoreButton = new St.Button({
            style_class: 'pulse-load-more-button',
            label: 'Load more',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        this._pageBox.add_child(this._loadMoreButton);
        this._loadMoreButton.accessible_name = 'Load more items';
        this._loadMoreButton.connect('clicked', () => {
            const data = this._viewData.get(this._view);
            if (data?.next_cursor)
                this._loadView(this._view, data.next_cursor, true);
        });

        this._setView(this._settings.get_string('default-view'));
    }

    _makeIconButton(iconName, accessibleName, callback, styleClass = 'pulse-control-button') {
        const button = new St.Button({
            style_class: styleClass,
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        try {
            const icon = new St.Icon({icon_name: iconName, style_class: 'pulse-control-icon'});
            button.set_child(icon);
            button.accessible_name = accessibleName;
            button.connect('clicked', callback);
            button._pulseIcon = icon;
            return button;
        } catch (error) {
            button.destroy();
            throw error;
        }
    }

    _loadBundledIcon() {
        if (!this._extensionDir)
            return null;
        try {
            const file = this._extensionDir
                .get_child('icons')
                .get_child('hicolor')
                .get_child('symbolic')
                .get_child('apps')
                .get_child('pulse-symbolic.svg');
            return Gio.FileIcon.new(file);
        } catch (_error) {
            return null;
        }
    }

    _makeNavButton(label, view, iconName) {
        const button = new St.Button({
            style_class: 'pulse-nav-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        try {
            const box = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER});
            button.set_child(box);
            box.add_child(new St.Icon({icon_name: iconName, style_class: 'pulse-nav-icon'}));
            box.add_child(new St.Label({text: label, style_class: 'pulse-nav-label'}));
            button.accessible_name = label;
            button.connect('clicked', () => this._setView(view));
            return button;
        } catch (error) {
            button.destroy();
            throw error;
        }
    }

    _connectSignals() {
        this._signalIds.push(this._connection.connect('snapshot-changed', () => {
            this._snapshot = this._connection.snapshot;
            this._renderSnapshot();
        }));
        this._signalIds.push(this._connection.connect('connection-changed', (_connection, connected) => {
            if (!connected) {
                this._loginInProgress = false;
                this._pendingAuthorizationUrl = '';
                this._stopAuthPolling();
                if (this._launchCancellable)
                    this._launchCancellable.cancel();
                this._launchCancellable = null;
                this._viewRequests.clear();
            }
            this._renderSnapshot();
            this._renderAuthState();
            if (connected && this.menu.isOpen) {
                this._connection.getAuthState();
                this._loadView(this._view, '', false);
            }
        }));
        this._signalIds.push(this._connection.connect('error-changed', () => {
            this._renderAuthState();
        }));
        this._signalIds.push(this._connection.connect('auth-state-changed', (_connection, raw) => {
            this._authState = parseAuthState(raw);
            this._renderAuthState();
        }));
        this._signalIds.push(this._connection.connect('search-results', (_connection, result) => {
            this._searchPayload = parseViewPayload(result);
            if (this._view === 'search')
                this._renderSearchResults(result);
        }));
        this._signalIds.push(this._connection.connect('view-results', (_connection, view, result) => {
            this._handleViewResults(view, result);
        }));

        this._settingsSignalIds.push(this._settings.connect('changed::show-progress', () => this._syncSettings()));
        this._settingsSignalIds.push(this._settings.connect('changed::compact-mode', () => this._syncSettings()));
        this._settingsSignalIds.push(this._settings.connect('changed::theme', () => this._syncTheme()));
        this._settingsSignalIds.push(this._settings.connect('changed::default-view', () => {
            if (!this.menu.isOpen)
                this._setView(this._settings.get_string('default-view'));
        }));

        try {
            this._themeSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            this._themeSignalId = this._themeSettings.connect('changed::color-scheme', () => this._syncTheme());
        } catch (_error) {
            this._themeSettings = null;
        }
    }

    _syncSettings() {
        const showProgress = this._settings.get_boolean('show-progress');
        this._progressItem.visible = showProgress;
        toggleStyleClass(this._controlsItem, 'pulse-compact-controls', this._settings.get_boolean('compact-mode'));
        this._renderSnapshot();
    }

    _syncTheme() {
        let theme = this._settings.get_string('theme');
        if (theme === 'system') {
            theme = 'dark';
            try {
                if (this._themeSettings?.get_string('color-scheme') === 'prefer-light')
                    theme = 'light';
            } catch (_error) {
                // Keep the dark, high-contrast fallback when the desktop schema
                // is unavailable (for example in a nested test shell).
            }
        }
        this.menu.box.remove_style_class_name('pulse-theme-light');
        this.menu.box.remove_style_class_name('pulse-theme-dark');
        this.menu.box.add_style_class_name(theme === 'light' ? 'pulse-theme-light' : 'pulse-theme-dark');
    }

    _renderSnapshot() {
        const snapshot = this._snapshot;
        const offline = Boolean(snapshot.offline) || !this._connection.connected;
        const hasTrack = Boolean(snapshot.title || snapshot.artist);
        const title = displayText(snapshot.title, offline ? 'Spotify is unavailable' : 'Nothing playing');
        const artist = displayText(snapshot.artist, offline ? 'Start Spotify to connect Pulse' : 'Choose something to play');

        this._statusLabel.text = offline ? 'Not connected' : (snapshot.playing ? 'Now playing' : 'Paused');
        this._titleLabel.text = title;
        this._artistLabel.text = artist;
        this._albumLabel.text = hasTrack ? displayText(snapshot.album, 'Spotify') : '';
        toggleStyleClass(this._statusLabel, 'pulse-status-offline', offline);

        this._currentPositionUs = Math.min(
            finitePosition(snapshot.position_us), finitePosition(snapshot.length_us));
        this._positionUpdatedAt = GLib.get_monotonic_time();
        this._renderProgress();
        this._syncProgressTimer();
        this._updateArtwork(snapshot.art_url);

        const canControl = !offline && Boolean(snapshot.can_control);
        this._setButtonEnabled(this._previousButton, canControl && Boolean(snapshot.can_go_previous));
        this._setButtonEnabled(this._nextButton, canControl && Boolean(snapshot.can_go_next));
        this._setButtonEnabled(this._playButton, canControl);
        this._playButton._pulseIcon.icon_name = snapshot.playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._playButton.accessible_name = snapshot.playing ? 'Pause' : 'Play';

        toggleStyleClass(this._panelDot, 'pulse-dot-active', !offline);
        toggleStyleClass(this._panelDot, 'pulse-dot-playing', Boolean(snapshot.playing));
        toggleStyleClass(this._panelBox, 'pulse-panel-offline', offline);
        this.accessible_name = offline ? 'Pulse, Spotify unavailable' : `Pulse, ${title}`;
    }

    _setButtonEnabled(button, enabled) {
        button.reactive = enabled;
        button.can_focus = enabled;
        if (enabled)
            button.remove_style_pseudo_class('insensitive');
        else
            button.add_style_pseudo_class('insensitive');
    }

    _renderProgress() {
        if (this._destroyed)
            return;
        const length = finitePosition(this._snapshot.length_us);
        const elapsed = this._snapshot.playing && this._connection.connected
            ? Math.max(0, GLib.get_monotonic_time() - this._positionUpdatedAt) : 0;
        const position = Math.min(finitePosition(this._currentPositionUs + elapsed), length);
        this._progress.value = length > 0 ? position / length : 0;
        this._positionLabel.text = formatTime(position);
        this._durationLabel.text = formatTime(length);
    }

    _syncProgressTimer() {
        const active = !this._destroyed && this.menu.isOpen &&
            this._progressItem.visible && this._connection.connected &&
            this._snapshot.playing && finitePosition(this._snapshot.length_us) > 0;
        if (!active) {
            this._removeSource('_progressSource');
            return;
        }
        this._renderProgress();
        if (!this._progressSource) {
            this._progressSource = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, PROGRESS_TICK_SECONDS, () => {
                    if (this._destroyed) {
                        this._progressSource = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                    this._renderProgress();
                    return GLib.SOURCE_CONTINUE;
                });
        }
    }

    _updateArtwork(uri) {
        const value = typeof uri === 'string' ? uri : '';
        if (value === this._artworkUri)
            return;
        this._artworkUri = value;

        if (!localArtworkUri(value)) {
            this._artwork.gicon = this._pulseGIcon;
            this._artwork.icon_name = null;
            return;
        }

        try {
            const file = value.startsWith('/') ? Gio.File.new_for_path(value) : Gio.File.new_for_uri(value);
            this._artwork.icon_name = null;
            this._artwork.gicon = Gio.FileIcon.new(file);
        } catch (_error) {
            this._artwork.gicon = this._pulseGIcon;
            this._artwork.icon_name = null;
        }
    }

    _setView(view) {
        const selected = ['home', 'search', 'library', 'queue'].includes(view) ? view : 'home';
        this._view = selected;
        for (const button of [this._homeButton, this._searchButton, this._libraryButton, this._queueButton])
            button.remove_style_pseudo_class('checked');

        const button = {
            home: this._homeButton,
            search: this._searchButton,
            library: this._libraryButton,
            queue: this._queueButton,
        }[selected];
        button.add_style_pseudo_class('checked');

        this._searchEntry.visible = selected === 'search';
        this._resultsBox.visible = true;
        this._loadMoreButton.visible = false;
        switch (selected) {
        case 'search':
            this._pageTitle.text = 'Search';
            this._pageBody.text = 'Find music in your Spotify library.';
            this._renderSearchResults(JSON.stringify(this._searchPayload));
            break;
        case 'library':
            this._pageTitle.text = 'Library';
            this._pageBody.text = 'Saved Tracks and Playlists from Spotify.';
            this._loadView(selected, '', false);
            break;
        case 'queue':
            this._pageTitle.text = 'Queue';
            this._pageBody.text = 'Read-only queue. Choose a row to open it in Spotify.';
            this._loadView(selected, '', false);
            break;
        default:
            this._pageTitle.text = 'Home';
            this._pageBody.text = 'Recently played and saved music from your Spotify session.';
            this._connection.refresh();
            this._loadView('home', '', false);
            break;
        }
    }

    _loadView(view, cursor = '', append = false) {
        if (view === 'search')
            return;
        const name = ['home', 'library', 'queue'].includes(view) ? view : 'home';
        const pageCursor = String(cursor || '');
        if (!this._connection.connected) {
            if (!append)
                this._renderViewMessage('Start the Pulse daemon to load this view.', name);
            return;
        }

        this._viewRequests.set(name, {cursor: pageCursor, append});
        if (!append)
            this._renderViewMessage('Loading…', name);
        this._connection.getView(name, pageCursor);
    }

    _handleViewResults(view, raw) {
        const request = this._viewRequests.get(view) || {cursor: '', append: false};
        this._viewRequests.delete(view);
        const payload = parseViewPayload(raw);
        const previous = this._viewData.get(view);
        let merged = payload;
        if (request.append && previous) {
            merged = {
                ...payload,
                items: [...(previous.items || []), ...(payload.items || [])].slice(0, MAX_VIEW_ROWS),
            };
        }
        this._viewData.set(view, merged);
        if (view === this._view)
            this._renderViewPayload(merged, view);
    }

    _renderViewPayload(payload, view) {
        this._clearResults();
        const items = Array.isArray(payload?.items) ? payload.items : [];
        const error = displayText(payload?.error);
        if (error && items.length === 0) {
            this._renderViewMessage(error, view);
            return;
        }
        if (items.length === 0) {
            const message = view === 'library'
                ? 'No saved tracks or playlists yet.'
                : view === 'queue'
                    ? 'Your Spotify queue is empty.'
                    : 'Nothing to show yet.';
            this._renderViewMessage(message, view);
            return;
        }

        for (const item of items.slice(0, MAX_VIEW_ROWS))
            this._resultsBox.add_child(this._makeItemButton(item, view));
        if (error)
            this._resultsBox.add_child(this._messageLabel(error));
        if (payload.stale)
            this._resultsBox.add_child(this._messageLabel('Showing cached data.'));

        const canLoadMore = typeof payload.next_cursor === 'string' &&
            payload.next_cursor && items.length < MAX_VIEW_ROWS;
        this._loadMoreButton.visible = canLoadMore;
        this._loadMoreButton.reactive = canLoadMore;
        this._loadMoreButton.can_focus = canLoadMore;
    }

    _renderViewMessage(message, view) {
        if (view !== this._view)
            return;
        this._clearResults();
        this._resultsBox.add_child(this._messageLabel(message));
        this._loadMoreButton.visible = false;
    }

    _makeItemButton(item, view) {
        const title = itemLabel(item);
        const subtitle = itemSubtitle(item);
        const button = new St.Button({
            style_class: 'pulse-result-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        try {
            const row = new St.BoxLayout({style_class: 'pulse-result-row', x_expand: true});
            button.set_child(row);
            const artwork = new St.Icon({
                icon_size: 32,
                style_class: 'pulse-result-artwork',
            });
            const artUrl = displayText(item?.art_url);
            if (localArtworkUri(artUrl)) {
                try {
                    const file = artUrl.startsWith('/') ? Gio.File.new_for_path(artUrl) : Gio.File.new_for_uri(artUrl);
                    artwork.gicon = Gio.FileIcon.new(file);
                } catch (_error) {
                    artwork.gicon = this._pulseGIcon;
                }
            } else {
                artwork.gicon = this._pulseGIcon;
            }
            row.add_child(artwork);
            const details = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'pulse-result-details'});
            row.add_child(details);
            const titleLabel = new St.Label({text: title, style_class: 'pulse-result-title'});
            details.add_child(titleLabel);
            const subtitleLabel = new St.Label({text: subtitle, style_class: 'pulse-result-subtitle'});
            titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            subtitleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            details.add_child(subtitleLabel);
            button.accessible_name = `${title}, ${subtitle}`;
            button.connect('clicked', () => {
                const uri = itemUri(item);
                if (uri)
                    this._connection.openUri(uri);
            });
            return button;
        } catch (error) {
            button.destroy();
            throw error;
        }
    }

    _scheduleSearch() {
        if (this._destroyed)
            return;
        if (this._searchSource) {
            GLib.Source.remove(this._searchSource);
            this._searchSource = 0;
        }

        const query = this._searchEntry.get_text().trim();
        if (!query) {
            // Passing the empty query through the bridge also cancels a request
            // already in flight, preventing obsolete results from resurfacing.
            this._connection.search('');
            return;
        }

        this._searchSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this._searchSource = 0;
            if (!this._destroyed)
                this._connection.search(query);
            return GLib.SOURCE_REMOVE;
        });
    }

    _renderSearchResults(raw) {
        const payload = parseViewPayload(raw);
        this._searchPayload = payload;
        this._clearResults();
        this._loadMoreButton.visible = false;
        const items = Array.isArray(payload.items) ? payload.items : [];
        if (payload.error && items.length === 0) {
            this._addSearchMessage(payload.error);
            return;
        }
        if (items.length === 0) {
            if (this._searchEntry.get_text().trim())
                this._addSearchMessage('No matches yet.');
            return;
        }

        for (const item of items.slice(0, MAX_SEARCH_RESULTS))
            this._resultsBox.add_child(this._makeItemButton(item, 'search'));
    }

    _clearResults() {
        for (const child of this._resultsBox.get_children())
            child.destroy();
    }

    _messageLabel(message) {
        return new St.Label({text: displayText(message), style_class: 'pulse-search-message'});
    }

    _addSearchMessage(message) {
        this._resultsBox.add_child(this._messageLabel(message));
    }

    _beginLogin() {
        if (this._destroyed || this._loginInProgress)
            return;
        this._loginInProgress = true;
        this._pendingAuthorizationUrl = '';
        this._renderAuthState();
        this._connection.beginLogin(authorizationUrl => {
            if (this._destroyed)
                return;
            // Do not launch here: this callback is asynchronous and no longer
            // itself represents a user gesture. Show a second, explicit action.
            this._pendingAuthorizationUrl = authorizationUrl;
            this._loginInProgress = false;
            this._renderAuthState();
        }, () => {
            if (this._destroyed)
                return;
            this._loginInProgress = false;
            this._renderAuthState();
        });
    }

    _openAuthorizationUrl() {
        if (this._destroyed || this._launchCancellable)
            return;
        const uri = safeAuthorizationUri(this._pendingAuthorizationUrl);
        if (!uri) {
            this._authStatusLabel.text = 'Pulse returned an invalid sign-in URL.';
            this._authorizationButton.visible = false;
            return;
        }

        const cancellable = new Gio.Cancellable();
        this._launchCancellable = cancellable;
        try {
            const shellGlobal = globalThis.global;
            const context = shellGlobal?.create_app_launch_context?.() || null;
            Gio.AppInfo.launch_default_for_uri_async(uri, context, cancellable, (_source, result) => {
                let launched = false;
                try {
                    launched = Gio.AppInfo.launch_default_for_uri_finish(result);
                } catch (_error) {
                    // Cancellation during disable is expected. Consume the
                    // GIO result, but do not access actors after teardown.
                }
                if (this._destroyed || this._launchCancellable !== cancellable)
                    return;
                this._launchCancellable = null;
                if (launched) {
                    this._pendingAuthorizationUrl = '';
                    this._startAuthPolling();
                    this._renderAuthState();
                } else {
                    this._authStatusLabel.text = 'Could not open a browser for Spotify sign-in.';
                }
            });
        } catch (_error) {
            this._launchCancellable = null;
            this._authStatusLabel.text = 'Could not open a browser for Spotify sign-in.';
        }
    }

    _renderAuthState() {
        if (this._destroyed || !this._authStatusLabel)
            return;
        const auth = this._authState || this._connection.authState || {};
        const offline = !this._connection.connected;
        const configured = auth.client_id_configured;
        const authenticated = Boolean(auth.authenticated);
        if (authenticated)
            this._stopAuthPolling();
        const authError = displayText(auth.error);

        if (offline) {
            this._authStatusLabel.text = 'Start the Pulse daemon to connect Spotify.';
        } else if (authenticated) {
            this._authStatusLabel.text = 'Connected to Spotify.';
        } else if (configured === false) {
            this._authStatusLabel.text = 'Add a Spotify client ID to the Pulse daemon config to connect.';
        } else if (configured === true) {
            this._authStatusLabel.text = authError || 'Connect Spotify to browse your music.';
        } else {
            this._authStatusLabel.text = authError || 'Spotify connection status is unavailable.';
        }

        const canLogin = !offline && configured === true && !authenticated && !this._loginInProgress;
        this._loginButton.visible = canLogin;
        this._loginButton.reactive = canLogin;
        this._loginButton.can_focus = canLogin;
        this._authorizationButton.visible = !authenticated && Boolean(this._pendingAuthorizationUrl);
        this._authorizationButton.reactive = this._authorizationButton.visible;
        this._authorizationButton.can_focus = this._authorizationButton.visible;
        this._logoutButton.visible = authenticated;
        this._logoutButton.reactive = authenticated;
        this._logoutButton.can_focus = authenticated;
        this._authItem.visible = !authenticated || Boolean(this._logoutButton.visible);
    }

    _startAuthPolling() {
        if (this._destroyed)
            return;
        this._stopAuthPolling();
        this._authPollAttempts = 0;
        this._connection.getAuthState();
        this._authPollSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            AUTH_POLL_SECONDS,
            () => {
                this._authPollAttempts++;
                if (this._destroyed || this._authState?.authenticated || this._authPollAttempts >= AUTH_POLL_LIMIT) {
                    this._authPollSource = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._connection.getAuthState();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopAuthPolling() {
        this._removeSource('_authPollSource');
        this._authPollAttempts = 0;
    }

    _removeSource(property) {
        const id = this[property];
        this[property] = 0;
        if (id)
            cleanup(() => GLib.Source.remove(id));
    }

    _releaseResources() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._stopAuthPolling();
        this._removeSource('_progressSource');
        this._removeSource('_searchSource');
        if (this._launchCancellable)
            cleanup(() => this._launchCancellable.cancel());
        this._launchCancellable = null;
        if (this._menuSignalId)
            cleanup(() => this.menu.disconnect(this._menuSignalId));
        this._menuSignalId = 0;
        for (const id of this._signalIds)
            cleanup(() => this._connection.disconnect(id));
        this._signalIds = [];
        for (const id of this._settingsSignalIds)
            cleanup(() => this._settings.disconnect(id));
        this._settingsSignalIds = [];
        if (this._themeSettings && this._themeSignalId)
            cleanup(() => this._themeSettings.disconnect(this._themeSignalId));
        this._themeSignalId = 0;
        this._themeSettings = null;
        this._viewData.clear();
        this._viewRequests.clear();
        this._searchPayload = {items: []};
        this._pendingAuthorizationUrl = '';
        this._connection = null;
        this._settings = null;
    }

    _onDestroy() {
        // Shell can destroy the panel from native code during logout without
        // calling this JavaScript destroy() method. Cancel callbacks before
        // PanelMenu destroys the menu, including its open-state handlers.
        this._releaseResources();
        super._onDestroy();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._releaseResources();
        super.destroy();
    }
});

export default class PulseExtension extends Extension {
    enable() {
        // Retain each resource until startup succeeds. Shell does not call
        // disable() after every failed enable().
        this._settingsSignalIds = [];
        try {
            this._settings = this.getSettings();
            this._connection = new PulseConnection();
            this._indicator = new PulseIndicator();
            this._indicatorDestroyId = this._indicator.connect('destroy', () => {
                // Native panel teardown must also retire the daemon client,
                // settings callbacks and shortcut owned by the extension.
                this._indicator = null;
                this._indicatorDestroyId = 0;
                this.disable();
            });
            this._indicator.initialize(this._connection, this._settings, this.dir);
            Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');

            for (const [signal, callback] of [
                ['changed::show-indicator', () => this._syncIndicatorVisibility()],
                ['changed::shortcut-enabled', () => this._syncShortcut()],
                ['changed::toggle-shortcut', () => this._syncShortcut()],
            ])
                this._settingsSignalIds.push(this._settings.connect(signal, callback));
            this._syncIndicatorVisibility();
            this._syncShortcut();
            this._connection.start();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    disable() {
        this._removeShortcut();
        for (const id of this._settingsSignalIds ?? [])
            cleanup(() => this._settings.disconnect(id));
        this._settingsSignalIds = [];
        const indicator = this._indicator;
        this._indicator = null;
        if (indicator && this._indicatorDestroyId)
            cleanup(() => indicator.disconnect(this._indicatorDestroyId));
        this._indicatorDestroyId = 0;
        if (indicator)
            cleanup(() => indicator.destroy());
        const connection = this._connection;
        this._connection = null;
        if (connection)
            cleanup(() => connection.destroy());
        this._settings = null;
        // GNOME's extension manager owns stylesheet.css loading/unloading.
    }

    _syncIndicatorVisibility() {
        if (this._indicator)
            this._indicator.visible = this._settings.get_boolean('show-indicator');
    }

    _syncShortcut() {
        this._removeShortcut();
        if (!this._settings || !this._settings.get_boolean('shortcut-enabled'))
            return;

        // Mutter treats the binding name as a settings key. A missing key
        // aborts the native Shell process, bypassing JavaScript try/catch.
        const schema = this._settings.settings_schema;
        if (!schema.has_key(TOGGLE_SHORTCUT) ||
            schema.get_key(TOGGLE_SHORTCUT).get_value_type().dup_string() !== 'as') {
            console.error('Pulse shortcut schema is missing or incompatible; shortcut disabled');
            return;
        }

        try {
            Main.wm.addKeybinding(
                TOGGLE_SHORTCUT,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._indicator?.menu?.toggle());
            this._shortcutRegistered = true;
        } catch (_error) {
            // A conflicting accelerator should not prevent the panel control
            // from loading. Preferences can still choose another shortcut.
            this._shortcutRegistered = false;
        }
    }

    _removeShortcut() {
        if (!this._shortcutRegistered)
            return;
        try {
            Main.wm.removeKeybinding(TOGGLE_SHORTCUT);
        } catch (_error) {
            // Shell teardown can already have removed the binding.
        }
        this._shortcutRegistered = false;
    }
}
