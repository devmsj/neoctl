#!/usr/bin/env bash
set -euo pipefail

export HOME="/root"
export PM2_HOME="/root/.pm2"
export PATH="/usr/local/bin:/usr/bin:/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pm2 resurrect >/dev/null 2>&1 || true
sleep 2

if ! pm2 describe neoctl-web >/dev/null 2>&1; then
  exec "$SCRIPT_DIR/start.sh"
fi
