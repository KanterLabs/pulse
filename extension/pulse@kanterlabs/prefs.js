import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const THEME_VALUES = ['system', 'light', 'dark'];
const VIEW_VALUES = ['home', 'search', 'library', 'queue'];

function bindSwitch(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function comboIndex(value, values) {
    const index = values.indexOf(value);
    return index >= 0 ? index : 0;
}

function bindCombo(settings, key, title, subtitle, values, labels) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(labels),
    });
    row.selected = comboIndex(settings.get_string(key), values);
    row.connect('notify::selected', () => {
        const value = values[row.selected];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    settings.connect(`changed::${key}`, () => {
        const index = comboIndex(settings.get_string(key), values);
        if (row.selected !== index)
            row.selected = index;
    });
    return row;
}

export default class PulsePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_search_enabled(true);
        window.set_default_size(560, 520);

        const generalPage = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        const playbackGroup = new Adw.PreferencesGroup({
            title: 'Playback',
            description: 'Keep the controls close while Spotify does the playing.',
        });
        playbackGroup.add(bindSwitch(
            settings,
            'show-indicator',
            'Show panel indicator',
            'Display Pulse in the GNOME top bar.'));
        playbackGroup.add(bindSwitch(
            settings,
            'show-progress',
            'Show playback progress',
            'Include elapsed and total time in the popover.'));
        playbackGroup.add(bindSwitch(
            settings,
            'compact-mode',
            'Compact controls',
            'Use a tighter layout for the playback buttons.'));
        generalPage.add(playbackGroup);

        const appearanceGroup = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Pulse follows your desktop appearance by default.',
        });
        appearanceGroup.add(bindCombo(
            settings,
            'theme',
            'Popover theme',
            'Choose System default, Light, or Dark.',
            THEME_VALUES,
            ['System default', 'Light', 'Dark']));
        appearanceGroup.add(bindCombo(
            settings,
            'default-view',
            'Opening view',
            'Choose the page shown when Pulse opens.',
            VIEW_VALUES,
            ['Home', 'Search', 'Library', 'Queue']));
        generalPage.add(appearanceGroup);

        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Keyboard shortcut',
            description: 'Use a keyboard accelerator to open or close the Pulse popover.',
        });
        const shortcutSwitch = bindSwitch(
            settings,
            'shortcut-enabled',
            'Enable shortcut',
            'The shortcut works in the normal desktop and overview.');
        shortcutGroup.add(shortcutSwitch);

        const shortcutRow = new Adw.EntryRow({
            title: 'Toggle Pulse',
            text: settings.get_strv('toggle-shortcut')[0] || '<Super><Alt>p',
        });
        shortcutRow.set_input_purpose(Gtk.InputPurpose.FREE_FORM);
        shortcutRow.connect('changed', () => {
            const value = shortcutRow.text.trim();
            if (value)
                settings.set_strv('toggle-shortcut', [value]);
        });
        settings.connect('changed::toggle-shortcut', () => {
            const value = settings.get_strv('toggle-shortcut')[0] || '<Super><Alt>p';
            if (shortcutRow.text !== value)
                shortcutRow.text = value;
        });
        shortcutGroup.add(shortcutRow);
        generalPage.add(shortcutGroup);

        const aboutPage = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });
        const aboutGroup = new Adw.PreferencesGroup({
            title: 'Pulse',
            description: 'A small GNOME companion for the official Spotify desktop client.',
        });
        const aboutRow = new Adw.ActionRow({
            title: 'Pulse for GNOME',
            subtitle: 'Playback stays in Spotify; Pulse provides the calm controls.',
        });
        aboutGroup.add(aboutRow);
        aboutPage.add(aboutGroup);

        window.add(generalPage);
        window.add(aboutPage);
    }
}
