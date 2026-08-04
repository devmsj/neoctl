#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME:-/root}"
export PM2_HOME="${PM2_HOME:-$HOME/.pm2}"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

pm2 delete neoctl-web >/dev/null 2>&1 || true
pm2 save --force
printf 'neoctl-web stopped\n'
