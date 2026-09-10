// Private browser-to-helper transport. GNOME talks to the daemon, never this page.
export class PanelBridge {
    constructor({api, probe, intervalMs = 1000}) {
        Object.assign(this, {api, probe, intervalMs});
        this.session = null;
        this.stopped = true;
        this.timers = new Set();
        this.generation = 0;
    }

    async start() {
        this.stop();
        this.stopped = false;
        const generation = this.generation;
        try {
            const {session} = await this.api('player/register', {});
            if (this.stopped || generation !== this.generation) return;
            this.session = session;
            this.schedule(() => this.heartbeat(generation), 0);
            this.schedule(() => this.commands(generation), 0);
        } catch {
            if (!this.stopped && generation === this.generation)
                this.schedule(() => this.start(), 2000);
        }
    }

    stop() {
        this.generation++;
        this.stopped = true;
        this.session = null;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
    }

    current(generation) {
        return !this.stopped && generation === this.generation && this.session !== null;
    }

    schedule(action, delay = this.intervalMs) {
        if (this.stopped) return;
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            void action();
        }, delay);
        this.timers.add(timer);
    }

    async heartbeat(generation) {
        if (!this.current(generation)) return;
        try {
            await this.probe.sampleState();
            if (!this.current(generation)) return;
            await this.api('player/state', {session: this.session, state: this.probe.state,
                activated: this.probe.state.phase === 'ready'});
        } catch (error) {
            if (this.current(generation) && error.status === 409) {
                this.probe.disconnect();
                await this.start();
                return;
            }
        }
        if (this.current(generation)) this.schedule(() => this.heartbeat(generation));
    }

    async commands(generation) {
        if (!this.current(generation)) return;
        try {
            const {commands} = await this.api(`player/commands?session=${encodeURIComponent(this.session)}`);
            for (const command of commands) {
                if (!this.current(generation)) return;
                let ok = false;
                try {
                    if (!Number.isFinite(command.expires_at) || command.expires_at <= Date.now())
                        throw new Error('Command expired.');
                    await this.execute(command);
                    ok = true;
                } catch { /* Return a sanitized negative acknowledgement. */ }
                if (!this.current(generation)) return;
                await this.api('player/ack', {session: this.session, id: command.id, ok});
            }
        } catch { /* Heartbeat handles session replacement; transient errors retry. */ }
        if (this.current(generation)) this.schedule(() => this.commands(generation), 200);
    }

    execute(command) {
        switch (command.command) {
        case 'play_pause': return this.probe.command(this.probe.state.paused ? 'resume' : 'pause');
        case 'next': return this.probe.command('nextTrack');
        case 'previous': return this.probe.command('previousTrack');
        case 'seek': return this.probe.command('seek', command.position_us / 1000);
        case 'open_uri': return this.probe.play(command.uri);
        default: throw new Error('Unsupported command.');
        }
    }
}
