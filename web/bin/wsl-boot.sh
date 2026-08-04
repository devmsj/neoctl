#!/usr/bin/env bash
set -u

LOG_FILE="/var/log/neoctl-web-boot.log"
POWERSHELL="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
WSL_IP="$(hostname -I | awk '{print $1}')"

if [[ -z "${WSL_INTEROP:-}" ]]; then
  WSL_INTEROP="$(ls -t /run/WSL/*_interop 2>/dev/null | head -n1 || true)"
  export WSL_INTEROP
fi

if [[ -n "$WSL_IP" && -x "$POWERSHELL" && -S "${WSL_INTEROP:-}" ]]; then
  "$POWERSHELL" -NoProfile -NonInteractive -Command \
    "foreach (\$port in 22,5173) { netsh interface portproxy set v4tov4 listenaddress=0.0.0.0 listenport=\$port connectaddress=$WSL_IP connectport=\$port | Out-Null; if (\$LASTEXITCODE -ne 0) { netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=\$port connectaddress=$WSL_IP connectport=\$port | Out-Null } }" \
    >>"$LOG_FILE" 2>&1 || true
fi

service ssh start >>"$LOG_FILE" 2>&1
/bin/bash /mnt/d/maker/neoctl-web/bin/boot.sh >>"$LOG_FILE" 2>&1
