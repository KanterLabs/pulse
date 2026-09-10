FROM rust:1.88-bookworm AS daemon-build
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --locked --package pulse-daemon

FROM mcr.microsoft.com/playwright:v1.61.1-noble
RUN apt-get update && apt-get install -y --no-install-recommends dbus libglib2.0-bin \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/pulse-browser --ignore-scripts --no-audit --no-fund playwright@1.61.1
COPY --from=daemon-build /source/target/debug/pulse-daemon /opt/pulse-daemon
ENV PULSE_PLAYWRIGHT_MODULE=/opt/pulse-browser/node_modules/playwright/index.mjs
ENV PULSE_TEST_DAEMON=/opt/pulse-daemon
WORKDIR /workspace
ENTRYPOINT ["node", "/workspace/tests/gnome-player-integration.mjs"]
