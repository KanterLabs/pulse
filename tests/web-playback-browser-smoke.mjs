// Optional real-browser integration test. Spotify traffic is entirely simulated.
// Requires Playwright, installed separately from the dependency-free prototype.
import assert from 'node:assert/strict';
import {createProbeServer} from '../experiments/web-playback/server.mjs';

const {chromium} = await import(process.env.PULSE_PLAYWRIGHT_MODULE || 'playwright');
const server = createProbeServer({port: 0, fetchImpl: async () => Response.json({
    access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600,
})});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
    browser = await chromium.launch({headless: true,
        ...(process.env.PULSE_CHROMIUM_PATH ? {executablePath: process.env.PULSE_CHROMIUM_PATH} : {})});
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // The integration checks browser mechanics, not DRM or network availability.
    await page.addInitScript(() => {
        navigator.requestMediaKeySystemAccess = async () => ({});
    });
    await page.route('https://accounts.spotify.com/authorize?*', route => {
        const state = new URL(route.request().url()).searchParams.get('state');
        return route.fulfill({status: 303, headers: {
            location: `${origin}/callback?code=test-code&state=${state}`,
        }});
    });
    await page.route('https://sdk.scdn.co/spotify-player.js', route => route.fulfill({
        contentType: 'text/javascript', body: `
        window.testCalls = [];
        window.Spotify = {Player: class {
            constructor(options) {this.options = options; this.events = {};}
            addListener(name, fn) {this.events[name] = fn;}
            async connect() {
                await new Promise(resolve => this.options.getOAuthToken(() => resolve()));
                this.events.ready({device_id: 'test-device'});
                return true;
            }
            disconnect() {testCalls.push('disconnect');}
            async activateElement() {testCalls.push('activate');}
            async pause() {testCalls.push('pause');}
            async resume() {testCalls.push('resume');}
        }};
        window.onSpotifyWebPlaybackSDKReady();`,
    }));
    let played = false;
    await page.route('https://api.spotify.com/**', async route => {
        if (route.request().method() === 'PUT') {
            assert.equal(new URL(route.request().url()).searchParams.get('device_id'), 'test-device');
            assert.deepEqual(route.request().postDataJSON(), {uris: ['spotify:track:19Shlms2uTnOjIUg50TXzd']});
            played = true;
        }
        await route.fulfill({status: 204, headers: {
            'access-control-allow-origin': origin,
            'access-control-allow-headers': 'authorization,content-type',
            'access-control-allow-methods': 'PUT,OPTIONS',
        }});
    });
    await page.goto(origin);
    await page.locator('#client-id').fill('0123456789abcdef0123456789abcdef');
    await page.locator('#connect').click();
    await page.getByText('Ready. Choose a track and press Play here.', {exact: true}).waitFor();
    await page.locator('#track-link').fill('https://open.spotify.com/track/19Shlms2uTnOjIUg50TXzd');
    await page.getByRole('button', {name: 'Play here', exact: true}).click();
    await page.getByText('Playback requested. Confirm you hear audio from this browser.', {exact: true}).waitFor();
    assert(played);
    await page.getByRole('button', {name: 'Pause', exact: true}).click();
    await page.getByRole('button', {name: 'Resume', exact: true}).click();
    assert.deepEqual(await page.evaluate(() => window.testCalls), ['activate', 'pause', 'activate', 'resume']);
    await page.locator('#logout').click();
    await page.locator('#login').waitFor({state: 'visible'});
    assert.equal(await page.locator('[data-playback]').first().isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: Chromium login, callback, tokens, targeted playback, controls and logout with simulated Spotify.');
} finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
