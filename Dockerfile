FROM oven/bun:1.4.2-debian
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth x11-utils xdotool scrot openbox xterm pcmanfm chromium \
    dbus-x11 fonts-dejavu fonts-liberation ca-certificates curl git ripgrep tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /opt/labora
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src
COPY scripts/computer-serve.ts ./scripts/computer-serve.ts
COPY cloud/container-entrypoint.sh /usr/local/bin/labora-desktop
RUN chmod 755 /usr/local/bin/labora-desktop && mkdir -p /home/bun/.labora/computer /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix && chown -R bun:bun /home/bun /opt/labora \
    && sed -i 's@<keyboard>@<keyboard><keybind key="C-A-t"><action name="Execute"><command>xterm</command></action></keybind>@' /etc/xdg/openbox/rc.xml
ENV HOME=/home/bun DISPLAY=:99 LABORA_DISPLAY=:99 LABORA_COMPUTER_HOST=0.0.0.0 LABORA_COMPUTER_PORT=7778 LABORA_ALLOW_NETWORK=true LABORA_COMPUTER_DATA=/home/bun/.labora/computer
USER bun
EXPOSE 7778
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/labora-desktop"]
