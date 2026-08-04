#!/usr/bin/env bash
set -u

LOG_FILE="/var/log/neoctl-web-boot.log"
POWERSHELL="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
WSL_IP="$(hostname -I | awk '{print $1}')"

if [[ -n "$WSL_IP" && -x "$POWERSHELL" ]]; then
  "$POWERSHELL" -NoProfile -NonInteractive -Command \
    "netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=22 | Out-Null; netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=22 connectaddress=$WSL_IP connectport=22 | Out-Null; netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=5173 | Out-Null; netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5173 connectaddress=$WSL_IP connectport=5173 | Out-Null" \
    >>"$LOG_FILE" 2>&1 || true
fi

service ssh start >>"$LOG_FILE" 2>&1
/bin/bash /mnt/d/maker/neoctl-web/bin/boot.sh >>"$LOG_FILE" 2>&1
