# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS node
FROM ubuntu:24.04

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HOME=/root \
    SHELL=/bin/bash \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    BASH_ENV=/etc/neo-proxy.bash

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash ca-certificates curl wget git openssh-client ripgrep jq \
    python3 python3-venv python3-pip python3-dev \
    build-essential cmake pkg-config \
    zip unzip xz-utils procps iproute2 less file tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install -g pnpm@10 \
    && npm cache clean --force \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir --upgrade pip setuptools wheel

COPY <<'PROXY' /etc/neo-proxy.bash
# Bash only; sourced by interactive, login and non-interactive Bash.
if [ -n "${BASH_VERSION:-}" ]; then
    proxy-on() {
        if [[ $# -ne 1 || ! $1 =~ ^[0-9]{1,5}$ ]]; then
            printf 'Usage: proxy-on <port:1-65535>\n' >&2
            return 2
        fi
        local port=$((10#$1))
        if (( port < 1 || port > 65535 )); then
            printf 'Port must be 1-65535\n' >&2
            return 2
        fi
        unset ALL_PROXY all_proxy
        export http_proxy="http://proxy.internal:${port}"
        export https_proxy="$http_proxy"
        export HTTP_PROXY="$http_proxy"
        export HTTPS_PROXY="$http_proxy"
        export no_proxy='localhost,127.0.0.1,::1'
        export NO_PROXY="$no_proxy"
        printf 'Proxy enabled: %s\n' "$http_proxy"
    }
    proxy-off() {
        unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
        unset all_proxy ALL_PROXY no_proxy NO_PROXY
        printf 'Proxy disabled\n'
    }
fi
PROXY

RUN chmod 644 /etc/neo-proxy.bash \
    && printf '\n. /etc/neo-proxy.bash\n' >> /etc/bash.bashrc \
    && bash -n /etc/neo-proxy.bash \
    && bash -c 'proxy-on 7890 && test "$https_proxy" = "http://proxy.internal:7890" && proxy-off && test -z "${https_proxy+x}"' \
    && node --version && npm --version && pnpm --version \
    && /opt/venv/bin/python --version && /opt/venv/bin/pip --version

USER root
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
