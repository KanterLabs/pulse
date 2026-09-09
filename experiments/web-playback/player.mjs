import {PlaybackProbe} from './player-core.mjs';

const element = id => document.getElementById(id);
const status = message => { element('status').textContent = message; };
const formatTime = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
let authenticated = false;
let sdkPromise;

async function api(path, body) {
    const response = await fetch(`/api/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {'X-Pulse-Probe': '1', ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Pulse request failed (${response.status}). Reconnect your account or restart the prototype.`);
    return response.json();
}

function loadSdk() {
    if (!sdkPromise) sdkPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Spotify SDK did not load. Check your network and reload.')), 20000);
        window.onSpotifyWebPlaybackSDKReady = () => { clearTimeout(timer); resolve(); };
        const script = document.createElement('script');
        script.src = 'https://sdk.scdn.co/spotify-player.js';
        script.onerror = () => { clearTimeout(timer); reject(new Error('Spotify SDK could not load. Reload to retry.')); };
        document.head.append(script);
    });
    return sdkPromise;
}

const probe = new PlaybackProbe({
    createPlayer: options => new window.Spotify.Player(options),
    getToken: async () => (await api('token')).access_token,
    onChange: state => {
        status(state.message);
        for (const control of document.querySelectorAll('[data-playback]'))
            control.disabled = state.phase !== 'ready';
        element('track').textContent = state.track
            ? `${state.track.name} — ${state.track.artists.map(artist => artist.name).join(', ')}`
            : 'No track playing';
        element('position').max = state.duration || 0;
        element('position').value = state.position || 0;
        element('time').textContent = `${formatTime(state.position || 0)} / ${formatTime(state.duration || 0)}`;
    },
});

// Display only our sanitized errors, never SDK payloads or OAuth responses.
const run = action => Promise.resolve().then(action).catch(error => {
    status(error instanceof Error ? error.message : 'Playback failed. Reconnect and try again.');
});

async function connectPlayer() {
    await loadSdk();
    if (authenticated) await probe.connect();
}

element('callback').textContent = `${location.origin}/callback`;
element('login').addEventListener('submit', event => {
    event.preventDefault();
    run(async () => {
        const {url} = await api('login', {clientId: element('client-id').value.trim()});
        const target = new URL(url);
        if (target.origin !== 'https://accounts.spotify.com') throw new Error('Invalid login destination.');
        location.assign(target.href);
    });
});
element('logout').onclick = () => run(async () => {
    authenticated = false;
    probe.disconnect();
    await api('logout', {});
    location.replace('/');
});
element('reconnect').onclick = () => run(connectPlayer);
element('play').addEventListener('submit', event => {
    event.preventDefault();
    // Call directly so activateElement retains the user gesture.
    probe.play(element('track-link').value).catch(error => status(error.message));
});
for (const button of document.querySelectorAll('[data-command]'))
    button.onclick = () => probe.command(button.dataset.command).catch(() => status('Playback command failed. Reconnect and try again.'));
element('position').onchange = () => run(() => probe.command('seek', Number(element('position').value)));
element('volume').onchange = () => run(() => probe.command('setVolume', Number(element('volume').value)));
window.addEventListener('pagehide', () => probe.disconnect());

run(async () => {
    let supported = false;
    try {
        await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
            initDataTypes: ['cenc'], audioCapabilities: [{contentType: 'audio/mp4; codecs="mp4a.40.2"'}],
        }]);
        supported = true;
    } catch { /* Runtime capability check is deliberately independent of login. */ }
    element('runtime').textContent = supported
        ? 'Protected audio support detected. Real Spotify playback still needs verification.'
        : 'Protected audio unavailable. Open this page in a browser with Widevine enabled.';
    element('connect').disabled = !supported;
    const state = await api('status');
    authenticated = state.authenticated;
    element('client-id').value = state.clientId || '';
    element('login').hidden = authenticated;
    element('logout').hidden = !authenticated;
    element('reconnect').hidden = !authenticated || !supported;
    const callbackFailed = location.search.length > 0 && !authenticated;
    history.replaceState(null, '', '/');
    status(callbackFailed ? 'Spotify login did not complete. Connect again to retry.' : 'Connect your Spotify account.');
    if (authenticated && supported) await connectPlayer();
});
