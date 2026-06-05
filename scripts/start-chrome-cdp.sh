#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-/tmp/chrome-profile}"
export CHROME_REMOTE_DEBUGGING_ADDRESS="${CHROME_REMOTE_DEBUGGING_ADDRESS:-127.0.0.1}"
export CHROME_REMOTE_DEBUGGING_PORT="${CHROME_REMOTE_DEBUGGING_PORT:-9222}"
export CHROME_CDP_PROXY_ADDRESS="${CHROME_CDP_PROXY_ADDRESS:-0.0.0.0}"
export CHROME_CDP_PROXY_PORT="${CHROME_CDP_PROXY_PORT:-9223}"
export CHROME_WINDOW_SIZE="${CHROME_WINDOW_SIZE:-1920,1080}"
export CHROME_URL="${CHROME_URL:-about:blank}"

mkdir -p "$CHROME_USER_DATA_DIR" /tmp/.X11-unix

if command -v pulseaudio >/dev/null 2>&1; then
  pulseaudio --start --exit-idle-time=-1 || true
fi

Xvfb "$DISPLAY" -screen 0 "${CHROME_WINDOW_SIZE}x24" -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
xvfb_pid="$!"

socat "TCP-LISTEN:${CHROME_CDP_PROXY_PORT},fork,reuseaddr,bind=${CHROME_CDP_PROXY_ADDRESS}" "TCP:127.0.0.1:${CHROME_REMOTE_DEBUGGING_PORT}" &
socat_pid="$!"

cleanup() {
  kill "$socat_pid" >/dev/null 2>&1 || true
  kill "$xvfb_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

exec google-chrome-stable \
  --remote-debugging-address="$CHROME_REMOTE_DEBUGGING_ADDRESS" \
  --remote-debugging-port="$CHROME_REMOTE_DEBUGGING_PORT" \
  --remote-allow-origins='*' \
  --user-data-dir="$CHROME_USER_DATA_DIR" \
  --window-size="$CHROME_WINDOW_SIZE" \
  --auto-accept-this-tab-capture \
  --autoplay-policy=no-user-gesture-required \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --no-sandbox \
  "$CHROME_URL"
