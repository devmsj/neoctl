#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
: "${NEO_ENV_FILE:?Set NEO_ENV_FILE to the host model configuration file}"
[[ -f "$NEO_ENV_FILE" ]] || { echo 'Model configuration file not found' >&2; exit 1; }
export NEO_EXECUTION_BACKEND=docker
export NEO_EXECUTION_CONTAINER=${NEO_EXECUTION_CONTAINER:-neo-workspace}
export NEO_CORE_SOURCE=local
export NEO_LOCAL_ENGINE_ROOT="$ROOT/engine"
export NEO_WEB_BASE_PATH=${NEO_WEB_BASE_PATH:-/neo/}
export NEO_WEB_DATA_DIR=${NEO_WEB_DATA_DIR:-/var/lib/neoctl-docker/web}
export HOME=${NEO_SERVICE_HOME:-/var/lib/neoctl-docker/home}
export AGENT_SESSION_DIR=${AGENT_SESSION_DIR:-/var/lib/neoctl-docker/sessions}
export APP_HOST=127.0.0.1
export APP_PORT=6666
export NEO_RUNTIME_TARGET=http://127.0.0.1:3109
mkdir -p "$NEO_WEB_DATA_DIR" "$HOME" "$AGENT_SESSION_DIR"
cd "$ROOT/web"
exec node server.mjs
