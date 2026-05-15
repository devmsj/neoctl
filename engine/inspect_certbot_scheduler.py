import paramiko

HOST='117.89.250.136'
USER='root'
PASSWORD='Hwj2018!'

cmd = r'''
printf '===== root_crontab =====\n'
crontab -l 2>&1 || true

echo
printf '===== systemd_timer =====\n'
systemctl status certbot-renew.timer --no-pager 2>&1 || true
echo '---'
systemctl status certbot-renew.service --no-pager 2>&1 || true
echo '---'
systemctl list-timers --all 2>&1 | egrep 'certbot|acme|renew' || true

echo
printf '===== cron_logs =====\n'
grep -iE 'CRON|certbot' /var/log/cron 2>/dev/null | tail -n 200 || true

echo
printf '===== letsencrypt_logs_recent =====\n'
ls -lt /var/log/letsencrypt/letsencrypt.log* 2>/dev/null || true
for f in /var/log/letsencrypt/letsencrypt.log /var/log/letsencrypt/letsencrypt.log.1 /var/log/letsencrypt/letsencrypt.log.2 /var/log/letsencrypt/letsencrypt.log.3; do
  [ -f "$f" ] || continue
  echo "--- $f tail ---"
  tail -n 80 "$f"
  echo
 done

echo
printf '===== certbot_process_now =====\n'
ps -ef | grep certbot | grep -v grep || true
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60, auth_timeout=30, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(cmd, timeout=180)
out = stdout.read().decode('utf-8', errors='replace')
err = stderr.read().decode('utf-8', errors='replace')
print(out)
if err.strip():
    print('[stderr]')
    print(err)
client.close()
