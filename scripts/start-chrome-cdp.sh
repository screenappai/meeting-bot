#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-/tmp/chrome-profile}"
export CHROME_REMOTE_DEBUGGING_ADDRESS="${CHROME_REMOTE_DEBUGGING_ADDRESS:-127.0.0.1}"
export CHROME_REMOTE_DEBUGGING_PORT="${CHROME_REMOTE_DEBUGGING_PORT:-9222}"
export CHROME_CDP_PROXY_ADDRESS="${CHROME_CDP_PROXY_ADDRESS:-0.0.0.0}"
export CHROME_CDP_PROXY_PORT="${CHROME_CDP_PROXY_PORT:-9223}"
export CHROME_WINDOW_SIZE="${CHROME_WINDOW_SIZE:-1280,720}"
export CHROME_URL="${CHROME_URL:-about:blank}"
CHROME_WINDOW_SIZE_FOR_CHROME="${CHROME_WINDOW_SIZE/x/,}"
XVFB_SCREEN_SIZE="${CHROME_WINDOW_SIZE/,/x}"

mkdir -p "$CHROME_USER_DATA_DIR" /tmp/.X11-unix

if command -v pulseaudio >/dev/null 2>&1; then
  pulseaudio --start --exit-idle-time=-1 || true
fi

Xvfb "$DISPLAY" -screen 0 "${XVFB_SCREEN_SIZE}x24" -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
xvfb_pid="$!"

cat >/tmp/chrome-cdp-nginx.conf <<EOF
pid /tmp/nginx.pid;
error_log /dev/stderr warn;

events {}

http {
  access_log off;
  client_body_temp_path /tmp/nginx-client-body;
  proxy_temp_path /tmp/nginx-proxy;
  fastcgi_temp_path /tmp/nginx-fastcgi;
  uwsgi_temp_path /tmp/nginx-uwsgi;
  scgi_temp_path /tmp/nginx-scgi;

  server {
    listen ${CHROME_CDP_PROXY_ADDRESS}:${CHROME_CDP_PROXY_PORT};

    location / {
      proxy_http_version 1.1;
      proxy_set_header Host 127.0.0.1:${CHROME_REMOTE_DEBUGGING_PORT};
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_pass http://127.0.0.1:${CHROME_REMOTE_DEBUGGING_PORT};
    }
  }
}
EOF

nginx -c /tmp/chrome-cdp-nginx.conf -g 'daemon off;' &
nginx_pid="$!"

cleanup() {
  kill "$nginx_pid" >/dev/null 2>&1 || true
  if [ -n "${chrome_pid:-}" ]; then
    kill "$chrome_pid" >/dev/null 2>&1 || true
  fi
  kill "$xvfb_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

google-chrome-stable \
  --remote-debugging-address="$CHROME_REMOTE_DEBUGGING_ADDRESS" \
  --remote-debugging-port="$CHROME_REMOTE_DEBUGGING_PORT" \
  --remote-allow-origins='*' \
  --user-data-dir="$CHROME_USER_DATA_DIR" \
  --window-size="$CHROME_WINDOW_SIZE_FOR_CHROME" \
  --window-position=0,0 \
  --force-device-scale-factor=1 \
  --auto-accept-this-tab-capture \
  --autoplay-policy=no-user-gesture-required \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --no-sandbox \
  "$CHROME_URL" &
chrome_pid="$!"

wait -n "$nginx_pid" "$chrome_pid"
