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
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {PulseConnection} from './dbus.js';

const TOGGLE_SHORTCUT = 'toggle-popover';
const PROGRESS_TICK_SECONDS = 1;
const SEARCH_DELAY_MS = 260;
const MAX_SEARCH_RESULTS = 8;

function displayText(value, fallback) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
}

function formatTime(microseconds) {
    const seconds = Math.max(0, Math.floor(Number(microseconds || 0) / 1000000));
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
    return displayText(item.name, displayText(item.title, ''));
}

const PulseIndicator = GObject.registerClass(
class PulseIndicator extends PanelMenu.Button {
    _init(connection, settings, extensionDir) {
        super._init(0.0, 'Pulse', false);

        this._connection = connection;
        this._settings = settings;
        this._extensionDir = extensionDir;
        this._pulseGIcon = this._loadBundledIcon();
        this._signalIds = [];
        this._settingsSignalIds = [];
        this._themeSettings = null;
        this._themeSignalId = 0;
        this._progressSource = 0;
        this._searchSource = 0;
        this._currentPositionUs = 0;
        this._snapshot = connection.snapshot;
        this._artworkUri = '';
        this._view = 'home';

        this._buildPanelButton();
        this._buildPopover();
        this._connectSignals();
        this._syncTheme();
        this._syncSettings();
        this._progressSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            PROGRESS_TICK_SECONDS,
            () => this._tickProgress());
    }

    _buildPanelButton() {
        this._panelBox = new St.BoxLayout({style_class: 'pulse-panel-box'});
        this._panelIcon = new St.Icon({style_class: 'system-status-icon pulse-panel-icon'});
        if (this._pulseGIcon)
            this._panelIcon.gicon = this._pulseGIcon;
        this._panelDot = new St.Widget({style_class: 'pulse-panel-dot'});
        this._panelBox.add_child(this._panelIcon);
        this._panelBox.add_child(this._panelDot);
        this.add_child(this._panelBox);
        this.accessible_name = 'Pulse music controls';
    }

    _buildPopover() {
        this.menu.box.add_style_class_name('pulse-popover');
        this.menu.box.set_width(372);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._connection.refresh();
        });

        this._buildNowPlaying();
        this._buildProgress();
        this._buildControls();
        this._buildNavigation();
        this._buildPage();
    }

    _buildNowPlaying() {
        this._nowPlayingItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'pulse-now-playing-item',
        });

        const row = new St.BoxLayout({style_class: 'pulse-now-playing-row'});
        const artworkFrame = new St.Bin({style_class: 'pulse-artwork-frame'});
        this._artwork = new St.Icon({
            icon_size: 72,
            style_class: 'pulse-artwork',
        });
        if (this._pulseGIcon)
            this._artwork.gicon = this._pulseGIcon;
        artworkFrame.set_child(this._artwork);
        row.add_child(artworkFrame);

        const details = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'pulse-track-details',
        });
        this._statusLabel = new St.Label({style_class: 'pulse-status-label'});
        this._titleLabel = new St.Label({style_class: 'pulse-title-label'});
        this._artistLabel = new St.Label({style_class: 'pulse-artist-label'});
        this._albumLabel = new St.Label({style_class: 'pulse-album-label'});
        for (const label of [this._statusLabel, this._titleLabel, this._artistLabel, this._albumLabel]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            label.clutter_text.single_line_mode = true;
            details.add_child(label);
        }
        row.add_child(details);
        this._nowPlayingItem.add_child(row);
        this.menu.addMenuItem(this._nowPlayingItem);
    }

    _buildProgress() {
        this._progressItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'pulse-progress-item',
        });
        const column = new St.BoxLayout({vertical: true, x_expand: true});
        this._progress = new St.ProgressBar({
            style_class: 'pulse-progress-bar',
            x_expand: true,
            progress: 0,
        });
        column.add_child(this._progress);
        const times = new St.BoxLayout({x_expand: true, style_class: 'pulse-time-row'});
        this._positionLabel = new St.Label({text: '0:00', style_class: 'pulse-time-label'});
        this._durationLabel = new St.Label({text: '0:00', style_class: 'pulse-time-label'});
        times.add_child(this._positionLabel);
        const spacer = new St.Widget({x_expand: true});
        times.add_child(spacer);
        times.add_child(this._durationLabel);
        column.add_child(times);
        this._progressItem.add_child(column);
        this.menu.addMenuItem(this._progressItem);
    }

    _buildControls() {
        this._controlsItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'pulse-controls-item',
        });
        const column = new St.BoxLayout({vertical: true, x_expand: true});
        const controls = new St.BoxLayout({
            style_class: 'pulse-controls',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        this._previousButton = this._makeIconButton(
            'media-skip-backward-symbolic',
            'Previous track',
            () => this._connection.previous());
        this._playButton = this._makeIconButton(
            'media-playback-start-symbolic',
            'Play',
            () => this._connection.playPause(),
            'pulse-play-button');
        this._nextButton = this._makeIconButton(
            'media-skip-forward-symbolic',
            'Next track',
            () => this._connection.next());
        controls.add_child(this._previousButton);
        controls.add_child(this._playButton);
        controls.add_child(this._nextButton);
        column.add_child(controls);

        this._openButton = new St.Button({
            style_class: 'pulse-open-button',
            label: 'Open in Spotify',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        this._openButton.accessible_name = 'Open current track in Spotify';
        this._openButton.connect('clicked', () => {
            const uri = this._snapshot.spotify_url || 'spotify:';
            this._connection.openUri(uri);
        });
        column.add_child(this._openButton);
        this._controlsItem.add_child(column);
        this.menu.addMenuItem(this._controlsItem);
    }

    _buildNavigation() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._navigationItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'pulse-navigation-item',
        });
        const nav = new St.BoxLayout({style_class: 'pulse-navigation', x_expand: true});
        this._homeButton = this._makeNavButton('Home', 'home', 'go-home-symbolic');
        this._searchButton = this._makeNavButton('Search', 'search', 'system-search-symbolic');
        this._libraryButton = this._makeNavButton('Library', 'library', 'folder-music-symbolic');
        this._queueButton = this._makeNavButton('Queue', 'queue', 'view-list-symbolic');
        nav.add_child(this._homeButton);
        nav.add_child(this._searchButton);
        nav.add_child(this._libraryButton);
        nav.add_child(this._queueButton);
        this._navigationItem.add_child(nav);
        this.menu.addMenuItem(this._navigationItem);
    }

    _buildPage() {
        this._pageItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'pulse-page-item',
        });
        this._pageBox = new St.BoxLayout({vertical: true, x_expand: true});
        this._pageTitle = new St.Label({style_class: 'pulse-page-title'});
        this._pageBody = new St.Label({style_class: 'pulse-page-body'});
        this._pageBody.clutter_text.line_wrap = true;
        this._pageBody.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._pageBox.add_child(this._pageTitle);
        this._pageBox.add_child(this._pageBody);

        this._searchEntry = new St.Entry({
            style_class: 'pulse-search-entry',
            hint_text: 'Search your music',
            can_focus: true,
            reactive: true,
            x_expand: true,
        });
        this._searchEntry.accessible_name = 'Search your music';
        this._searchEntry.get_clutter_text().connect('text-changed', () => this._scheduleSearch());
        this._resultsBox = new St.BoxLayout({vertical: true, style_class: 'pulse-search-results'});
        this._pageBox.add_child(this._searchEntry);
        this._pageBox.add_child(this._resultsBox);
        this._pageItem.add_child(this._pageBox);
        this.menu.addMenuItem(this._pageItem);

        this._setView(this._settings.get_string('default-view'));
    }

    _makeIconButton(iconName, accessibleName, callback, styleClass = 'pulse-control-button') {
        const button = new St.Button({
            style_class: styleClass,
            can_focus: true,
            reactive: true,
            track_hover: true,
        });
        const icon = new St.Icon({icon_name: iconName, style_class: 'pulse-control-icon'});
        button.set_child(icon);
        button.accessible_name = accessibleName;
        button.connect('clicked', callback);
        button._pulseIcon = icon;
        return button;
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
        const box = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER});
        box.add_child(new St.Icon({icon_name: iconName, style_class: 'pulse-nav-icon'}));
        box.add_child(new St.Label({text: label, style_class: 'pulse-nav-label'}));
        button.set_child(box);
        button.accessible_name = label;
        button.connect('clicked', () => this._setView(view));
        return button;
    }

    _connectSignals() {
        this._signalIds.push(this._connection.connect('snapshot-changed', () => {
            this._snapshot = this._connection.snapshot;
            this._renderSnapshot();
        }));
        this._signalIds.push(this._connection.connect('connection-changed', () => {
            this._renderSnapshot();
        }));
        this._signalIds.push(this._connection.connect('search-results', (_connection, result) => {
            this._renderSearchResults(result);
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
        this._controlsItem.toggle_style_class_name('pulse-compact-controls', this._settings.get_boolean('compact-mode'));
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
        this._statusLabel.toggle_style_class_name('pulse-status-offline', offline);

        this._currentPositionUs = Math.min(
            Math.max(0, Number(snapshot.position_us || 0)),
            Math.max(0, Number(snapshot.length_us || 0)));
        this._renderProgress();
        this._updateArtwork(snapshot.art_url);

        const canControl = !offline && Boolean(snapshot.can_control);
        this._setButtonEnabled(this._previousButton, canControl && Boolean(snapshot.can_go_previous));
        this._setButtonEnabled(this._nextButton, canControl && Boolean(snapshot.can_go_next));
        this._setButtonEnabled(this._playButton, canControl);
        this._playButton._pulseIcon.icon_name = snapshot.playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._playButton.accessible_name = snapshot.playing ? 'Pause' : 'Play';

        this._panelDot.toggle_style_class_name('pulse-dot-active', !offline);
        this._panelDot.toggle_style_class_name('pulse-dot-playing', Boolean(snapshot.playing));
        this._panelBox.toggle_style_class_name('pulse-panel-offline', offline);
        this.accessible_name = offline ? 'Pulse, Spotify unavailable' : `Pulse, ${title}`;
        try {
            this.set_tooltip_text(offline ? 'Pulse: Spotify is unavailable' : `Pulse: ${title}`);
        } catch (_error) {
            // Tooltips are optional in minimal Shell test environments.
        }
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
        const length = Math.max(0, Number(this._snapshot.length_us || 0));
        const position = Math.min(Math.max(0, Number(this._currentPositionUs || 0)), length || Infinity);
        this._progress.progress = length > 0 ? position / length : 0;
        this._positionLabel.text = formatTime(position);
        this._durationLabel.text = formatTime(length);
    }

    _tickProgress() {
        if (this._snapshot.playing && this._snapshot.length_us > 0) {
            this._currentPositionUs = Math.min(
                Number(this._snapshot.length_us),
                Number(this._currentPositionUs) + PROGRESS_TICK_SECONDS * 1000000);
            this._renderProgress();
        }
        return GLib.SOURCE_CONTINUE;
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
        this._view = view;
        for (const button of [this._homeButton, this._searchButton, this._libraryButton, this._queueButton])
            button.remove_style_pseudo_class('checked');

        const button = {
            home: this._homeButton,
            search: this._searchButton,
            library: this._libraryButton,
            queue: this._queueButton,
        }[view] || this._homeButton;
        button.add_style_pseudo_class('checked');

        this._searchEntry.visible = view === 'search';
        this._resultsBox.visible = view === 'search';
        switch (view) {
        case 'search':
            this._pageTitle.text = 'Search';
            this._pageBody.text = 'Find music in your Spotify library.';
            break;
        case 'library':
            this._pageTitle.text = 'Library';
            this._pageBody.text = 'Your saved music and playlists will appear here.';
            break;
        case 'queue':
            this._pageTitle.text = 'Queue';
            this._pageBody.text = 'Queue browsing is available in Spotify. Use Next and Previous above.';
            break;
        default:
            this._pageTitle.text = 'Home';
            this._pageBody.text = 'A quick, quiet home for your current Spotify session.';
            break;
        }
    }

    _scheduleSearch() {
        if (this._searchSource) {
            GLib.Source.remove(this._searchSource);
            this._searchSource = 0;
        }

        const query = this._searchEntry.get_text().trim();
        if (!query) {
            this._renderSearchResults('');
            return;
        }

        this._searchSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this._searchSource = 0;
            this._connection.search(query);
            return GLib.SOURCE_REMOVE;
        });
    }

    _renderSearchResults(raw) {
        for (const child of this._resultsBox.get_children())
            child.destroy();

        if (!raw)
            return;

        let payload;
        try {
            payload = JSON.parse(raw);
        } catch (_error) {
            this._addSearchMessage('Search results are temporarily unavailable.');
            return;
        }

        const items = Array.isArray(payload) ? payload : (payload.items || payload.results || []);
        if (!Array.isArray(items) || items.length === 0) {
            this._addSearchMessage('No matches yet.');
            return;
        }

        for (const item of items.slice(0, MAX_SEARCH_RESULTS)) {
            const name = itemLabel(item);
            if (!name)
                continue;
            const result = new St.Button({
                style_class: 'pulse-result-button',
                can_focus: true,
                reactive: true,
                track_hover: true,
                x_expand: true,
            });
            const label = displayText(item.artist, displayText(item.subtitle, 'Spotify'));
            result.set_child(this._resultRow(name, label));
            result.accessible_name = `${name}, ${label}`;
            result.connect('clicked', () => {
                const uri = item.uri || item.spotify_url || item.url;
                if (uri)
                    this._connection.openUri(uri);
            });
            this._resultsBox.add_child(result);
        }
    }

    _resultRow(title, subtitle) {
        const row = new St.BoxLayout({vertical: true, x_expand: true});
        const titleLabel = new St.Label({text: title, style_class: 'pulse-result-title'});
        const subtitleLabel = new St.Label({text: subtitle, style_class: 'pulse-result-subtitle'});
        titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        subtitleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(titleLabel);
        row.add_child(subtitleLabel);
        return row;
    }

    _addSearchMessage(message) {
        this._resultsBox.add_child(new St.Label({text: message, style_class: 'pulse-search-message'}));
    }

    destroy() {
        if (this._progressSource) {
            GLib.Source.remove(this._progressSource);
            this._progressSource = 0;
        }
        if (this._searchSource) {
            GLib.Source.remove(this._searchSource);
            this._searchSource = 0;
        }
        for (const id of this._signalIds)
            this._connection.disconnect(id);
        this._signalIds = [];
        for (const id of this._settingsSignalIds)
            this._settings.disconnect(id);
        this._settingsSignalIds = [];
        if (this._themeSettings && this._themeSignalId)
            this._themeSettings.disconnect(this._themeSignalId);
        this._themeSignalId = 0;
        this._themeSettings = null;
        super.destroy();
    }
});

export default class PulseExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._stylesheet = this.dir.get_child('stylesheet.css');
        try {
            Main.get_theme().load_stylesheet(this._stylesheet);
        } catch (_error) {
            // Keep the extension functional if a test shell has no theme
            // manager; the widgets still carry accessible names and spacing.
        }
        this._connection = new PulseConnection();
        this._indicator = new PulseIndicator(this._connection, this._settings, this.dir);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');

        this._settingsSignalIds = [
            this._settings.connect('changed::show-indicator', () => this._syncIndicatorVisibility()),
            this._settings.connect('changed::shortcut-enabled', () => this._syncShortcut()),
            this._settings.connect('changed::toggle-shortcut', () => this._syncShortcut()),
        ];
        this._syncIndicatorVisibility();
        this._syncShortcut();
        this._connection.start();
    }

    disable() {
        this._removeShortcut();
        if (this._settings) {
            for (const id of this._settingsSignalIds)
                this._settings.disconnect(id);
        }
        this._settingsSignalIds = [];

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._connection) {
            this._connection.destroy();
            this._connection = null;
        }
        if (this._stylesheet) {
            try {
                Main.get_theme().unload_stylesheet(this._stylesheet);
            } catch (_error) {
                // The theme may already have been torn down during Shell exit.
            }
            this._stylesheet = null;
        }
        this._settings = null;
    }

    _syncIndicatorVisibility() {
        if (this._indicator)
            this._indicator.visible = this._settings.get_boolean('show-indicator');
    }

    _syncShortcut() {
        this._removeShortcut();
        if (!this._settings || !this._settings.get_boolean('shortcut-enabled'))
            return;

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
            // from loading.  Preferences can still choose another shortcut.
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
