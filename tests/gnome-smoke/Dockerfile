FROM fedora:43

# GNOME Shell 49 is exercised entirely inside this image.  The runtime uses
# headless Wayland and dbus-run-session; the host display, session bus, and home directory
# are never mounted into the container.
RUN dnf -y install \
        dconf \
        dbus-daemon \
        glib2 \
        gjs \
        gnome-shell \
        gsettings-desktop-schemas \
        mesa-dri-drivers \
        mesa-libGL \
        ripgrep \
        xdpyinfo \
        xorg-x11-server-Xvfb \
    && dnf clean all \
    && rm -rf /var/cache/dnf

COPY tests/gnome-smoke/run.sh /usr/local/bin/pulse-gnome-smoke
RUN chmod 0755 /usr/local/bin/pulse-gnome-smoke

RUN useradd --create-home --uid 1000 pulse
ENV HOME=/home/pulse
USER pulse

ENTRYPOINT ["/usr/local/bin/pulse-gnome-smoke"]
