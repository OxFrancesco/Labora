#!/bin/sh
set -eu
umask 077
mkdir -p "$LABORA_COMPUTER_DATA" "$HOME/.config"
rm -f "$LABORA_COMPUTER_DATA/chromium/SingletonLock" "$LABORA_COMPUTER_DATA/chromium/SingletonCookie" "$LABORA_COMPUTER_DATA/chromium/SingletonSocket"
# A restored snapshot must start fresh display processes.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 "${LABORA_SCREEN_SIZE:-1440x900x24}" -nolisten tcp -ac &
xvfb_pid=$!
attempt=0
until xdpyinfo -display :99 >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 100 ]; then echo "X11 display failed to start" >&2; exit 1; fi
  sleep 0.1
done
dbus-launch --exit-with-session openbox-session >/tmp/labora-openbox.log 2>&1 &
desktop_pid=$!
attempt=0
until xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | rg -q 'window id #'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 200 ]; then echo "Window manager failed to start" >&2; exit 1; fi
  sleep 0.1
done
pcmanfm --desktop >/tmp/labora-files.log 2>&1 &
files_pid=$!
chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --no-first-run \
  --user-data-dir="$LABORA_COMPUTER_DATA/chromium" about:blank >/tmp/labora-chromium.log 2>&1 &
browser_pid=$!
attempt=0
until xdotool search --onlyvisible --class chromium >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 300 ]; then echo "Chromium failed to open its desktop window" >&2; exit 1; fi
  sleep 0.1
done
bun /opt/labora/scripts/computer-serve.ts &
companion_pid=$!
cleanup() {
  kill "$companion_pid" "$browser_pid" "$files_pid" "$desktop_pid" "$xvfb_pid" 2>/dev/null || true
  wait "$companion_pid" 2>/dev/null || true
}
trap cleanup TERM INT EXIT
wait "$companion_pid"
