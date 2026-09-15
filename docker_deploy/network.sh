#!/usr/bin/env bash
set -euo pipefail
: "${NETWORK:=neo-egress}"
: "${BRIDGE:=neo-egress}"
: "${CHAIN:=NEO-EGRESS}"
[[ "$BRIDGE" =~ ^[a-zA-Z0-9_-]{1,15}$ && "$CHAIN" =~ ^[a-zA-Z0-9_-]{1,25}$ ]] || exit 1
command -v iptables >/dev/null
command -v ip6tables >/dev/null
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  docker network create --driver bridge --opt "com.docker.network.bridge.name=$BRIDGE" --opt com.docker.network.bridge.enable_icc=false "$NETWORK" >/dev/null
fi
[[ $(docker network inspect -f '{{.Driver}} {{index .Options "com.docker.network.bridge.name"}} {{.EnableIPv6}}' "$NETWORK") == "bridge $BRIDGE false" ]] || { echo 'Network does not match isolated bridge configuration' >&2; exit 1; }
# Rules apply only to this bridge; never flush existing host or Docker chains.
iptables -w -N "$CHAIN" 2>/dev/null || true
iptables -w -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null || iptables -w -I INPUT 1 -i "$BRIDGE" -j DROP
ip6tables -w -C INPUT -i "$BRIDGE" -j DROP 2>/dev/null || ip6tables -w -I INPUT 1 -i "$BRIDGE" -j DROP
ip6tables -w -C FORWARD -i "$BRIDGE" -j DROP 2>/dev/null || ip6tables -w -I FORWARD 1 -i "$BRIDGE" -j DROP
# Block private, metadata, multicast and administrator-specified public management addresses.
for target in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4 ${BLOCK_CIDRS:-}; do
  iptables -w -C "$CHAIN" -d "$target" -j DROP 2>/dev/null || iptables -w -I "$CHAIN" 1 -d "$target" -j DROP
done
iptables -w -C "$CHAIN" -j ACCEPT 2>/dev/null || iptables -w -A "$CHAIN" -j ACCEPT
iptables -w -C FORWARD -i "$BRIDGE" -j "$CHAIN" 2>/dev/null || iptables -w -I FORWARD 1 -i "$BRIDGE" -j "$CHAIN"
echo "Network ready: $NETWORK"
