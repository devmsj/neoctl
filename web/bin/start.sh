#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME:-/root}"
export PM2_HOME="${PM2_HOME:-$HOME/.pm2}"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="neoctl-web"

cd "$APP_DIR"

if [[ ! -f dist/index.html ]]; then
  npm run build
fi

export APP_HOST="${APP_HOST:-0.0.0.0}"
export APP_PORT="${APP_PORT:-5173}"

pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start "$APP_DIR/server.mjs" \
  --name "$APP_NAME" \
  --cwd "$APP_DIR" \
  --interpreter /usr/local/bin/node

pm2 save --force

for _ in {1..20}; do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/" >/dev/null; then
    printf '%s is running at http://0.0.0.0:%s\n' "$APP_NAME" "$APP_PORT"
    exit 0
  fi
  sleep 1
done

pm2 logs "$APP_NAME" --lines 60 --nostream
exit 1
