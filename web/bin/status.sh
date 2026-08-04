#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME:-/root}"
export PM2_HOME="${PM2_HOME:-$HOME/.pm2}"
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

pm2 show neoctl-web
curl -fsS -o /dev/null -w 'UI=%{http_code}\n' http://127.0.0.1:5173/
curl -fsS -o /dev/null -w 'RUNTIME=%{http_code}\n' http://127.0.0.1:5173/api/state
