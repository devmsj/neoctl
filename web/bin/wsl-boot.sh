#!/usr/bin/env bash
set -u

service ssh start
/bin/bash /mnt/d/maker/neoctl-web/bin/boot.sh >>/var/log/neoctl-web-boot.log 2>&1
