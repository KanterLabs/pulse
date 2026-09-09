import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const MARKER = '__pulseSmokeSentinelEnabled';

export default class PulseSmokeSentinel extends Extension {
    enable() {
        globalThis[MARKER] = true;
    }

    disable() {
        globalThis[MARKER] = false;
    }
}
