#!/usr/bin/env bash
set -euo pipefail

NAME=${NAME:-neo-workspace}
IMAGE=${IMAGE:-neo-workspace:1}
VOLUME=${VOLUME:-neo-workspace-data}
NETWORK=${NETWORK:-none}
CPUS=${CPUS:-2}
MEMORY=${MEMORY:-4g}
PIDS=${PIDS:-512}
PROXY_GATEWAY=${PROXY_GATEWAY:-}

command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 1; }
docker info >/dev/null
docker image inspect "$IMAGE" >/dev/null
if docker container inspect "$NAME" >/dev/null 2>&1; then
    echo "Container already exists: $NAME. Use: docker start $NAME" >&2
    exit 1
fi
if [[ "$NETWORK" == host || "$NETWORK" == container:* ]]; then
    echo 'Use none or a dedicated Docker network.' >&2
    exit 1
fi
if [[ "$NETWORK" != none ]]; then
    [[ "$(docker network inspect "$NETWORK" --format '{{.Driver}}')" == bridge ]] || {
        echo 'A bridge network is required.' >&2; exit 1;
    }
fi
if [[ -n "$PROXY_GATEWAY" && "$NETWORK" == none ]]; then
    echo 'PROXY_GATEWAY requires a configured NETWORK.' >&2
    exit 1
fi

docker volume create "$VOLUME" >/dev/null
args=(
    --detach --name "$NAME"
    --label neoctl.role=workspace
    --user 0:0 --workdir /workspace
    --network "$NETWORK"
    --cpus "$CPUS" --memory "$MEMORY" --memory-swap "$MEMORY"
    --pids-limit "$PIDS"
    --security-opt no-new-privileges=true
    --cap-drop NET_RAW
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3
    --restart unless-stopped
    --mount "type=volume,source=$VOLUME,target=/workspace"
)
if [[ -n "$PROXY_GATEWAY" ]]; then
    args+=(--add-host "proxy.internal:$PROXY_GATEWAY")
fi
docker run "${args[@]}" "$IMAGE"
printf 'Container: %s\nImage: %s\nVolume: %s\nNetwork: %s\n' "$NAME" "$IMAGE" "$VOLUME" "$NETWORK"
