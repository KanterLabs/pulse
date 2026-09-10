// Browser-independent lifecycle logic. Never runs inside GNOME Shell.
export function trackUri(value) {
    const input = value.trim();
    if (/^spotify:track:[A-Za-z0-9]{22}$/.test(input)) return input;
    try {
        const url = new URL(input);
        const match = /^\/track\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
        if (url.protocol === 'https:' && url.hostname === 'open.spotify.com' && match)
            return `spotify:track:${match[1]}`;
    } catch { /* Report a useful input error below. */ }
    throw new Error('Enter a Spotify track link or spotify:track URI.');
}

export function playbackBody(value) {
    if (typeof value === 'string' && /^spotify:(album|playlist|artist):[A-Za-z0-9]{22}$/.test(value))
        return {context_uri: value};
    return {uris: [trackUri(value)]};
}

export class PlaybackProbe {
    constructor({createPlayer, getToken, fetchImpl = (...args) => globalThis.fetch(...args),
        onChange = () => {}, connectionTimeoutMs = 15000}) {
        Object.assign(this, {createPlayer, getToken, fetchImpl, onChange, connectionTimeoutMs});
        this.generation = 0;
        this.player = null;
        this.deviceId = null;
        this.controller = null;
        this.state = {phase: 'idle', message: 'Connect your Spotify account.', track: null};
    }

    update(value) {
        this.state = {...this.state, ...value};
        this.onChange(this.state);
    }

    async connect() {
        this.disconnect();
        const generation = this.generation;
        const current = () => this.generation === generation;
        this.controller = new AbortController();
        this.update({phase: 'connecting', message: 'Starting the Spotify player…'});
        const player = this.createPlayer({
            name: 'Pulse playback prototype', volume: 0.5,
            getOAuthToken: callback => {
                this.getToken().then(token => {
                    if (current()) callback(token);
                }).catch(() => {
                    if (current()) this.fail('Sign in again to refresh Spotify access.');
                });
            },
        });
        this.player = player;
        const listen = (name, callback) => player.addListener(name, payload => {
            if (current()) callback(payload);
        });
        listen('ready', ({device_id}) => {
            this.deviceId = device_id;
            this.update({phase: 'ready', message: 'Ready. Choose a track and press Play here.'});
        });
        listen('not_ready', () => {
            this.disconnect();
            this.update({phase: 'offline', message: 'Player offline. Check your connection, then reconnect.'});
        });
        listen('player_state_changed', state => this.applyState(state));
        for (const [event, message] of Object.entries({
            initialization_error: 'This browser cannot initialize Spotify audio. Check protected-content support.',
            authentication_error: 'Spotify authorization failed. Sign out and connect again.',
            account_error: 'Spotify rejected this account. The playback SDK requires Premium.',
            playback_error: 'Spotify could not play this selection. Try another track or reconnect.',
        })) listen(event, () => this.fail(message));
        listen('autoplay_failed', () => this.update({message: 'Browser blocked playback. Press Play here again.'}));
        const signal = this.controller.signal;
        let timer;
        let cancel;
        const deadline = new Promise((_, reject) => {
            cancel = () => reject(new Error('Player retired.'));
            signal.addEventListener('abort', cancel, {once: true});
            timer = setTimeout(() => reject(new Error('Connection timed out.')), this.connectionTimeoutMs);
        });
        try {
            const connected = await Promise.race([player.connect(), deadline]);
            if (current() && !connected) this.fail('Spotify connection failed. Reconnect to try again.');
        } catch {
            if (current()) this.fail('Spotify connection failed. Reconnect to try again.');
        } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
        }
    }

    fail(message) {
        this.disconnect();
        this.update({phase: 'error', message});
    }

    disconnect() {
        this.generation++;
        this.controller?.abort();
        this.controller = null;
        const old = this.player;
        this.player = null;
        this.deviceId = null;
        // Retire callbacks first, including callbacks emitted by disconnect().
        try { old?.disconnect(); } catch { /* Already disconnected. */ }
        this.update({phase: 'idle', track: null, paused: true, position: 0, duration: 0});
    }

    applyState(state) {
        if (!state) {
            this.update({track: null, paused: true, position: 0, duration: 0});
            return;
        }
        this.update({track: state.track_window.current_track, paused: state.paused,
            position: state.position, duration: state.duration, disallows: state.disallows || {}});
    }

    async sampleState() {
        if (!this.player?.getCurrentState) return;
        const generation = this.generation;
        let timer;
        try {
            const state = await Promise.race([this.player.getCurrentState(), new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('State request timed out.')), 2000);
            })]);
            if (generation === this.generation) this.applyState(state);
        } finally { clearTimeout(timer); }
    }

    async play(input) {
        const body = playbackBody(input);
        if (!this.deviceId || !this.player) throw new Error('Wait for the player to be ready.');
        const generation = this.generation;
        const deviceId = this.deviceId;
        const controller = this.controller;
        // Invoke synchronously in the click handler before awaiting token I/O.
        await this.player.activateElement();
        const token = await this.getToken();
        if (generation !== this.generation) return;
        const response = await this.fetchImpl(
            `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
                method: 'PUT', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
                headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
                body: JSON.stringify(body),
            });
        if (generation !== this.generation) return;
        if (!response.ok) {
            const reason = {401: 'Sign in again.', 403: 'Check Premium and app access.',
                404: 'Reconnect the player.', 429: 'Spotify rate limit reached; wait before retrying.'};
            throw new Error(`Spotify could not start playback (${response.status}). ${reason[response.status] ?? 'Try again later.'}`);
        }
        this.update({message: 'Playback requested. Confirm you hear audio from this browser.'});
    }

    async command(name, value) {
        if (!this.deviceId || !this.player) throw new Error('The player is not ready.');
        if (name === 'seek' && (!Number.isFinite(value) || value < 0 || value > this.state.duration))
            throw new Error('Choose a position within the track.');
        if (name === 'setVolume' && (!Number.isFinite(value) || value < 0 || value > 1))
            throw new Error('Volume must be between zero and one.');
        if (!['pause', 'resume', 'previousTrack', 'nextTrack', 'seek', 'setVolume'].includes(name))
            throw new Error('Unsupported playback command.');
        const generation = this.generation;
        const player = this.player;
        if (name === 'resume') await player.activateElement();
        if (generation === this.generation) await player[name](value);
    }
}
