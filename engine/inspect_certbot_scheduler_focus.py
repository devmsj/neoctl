import paramiko

HOST='117.89.250.136'
USER='root'
PASSWORD='Hwj2018!'

cmd = r'''
printf '===== cron_certbot_entries =====\n'
grep -i 'certbot renew' /var/log/cron 2>/dev/null | tail -n 50 || true

echo
printf '===== cron_midnight_noon_window =====\n'
grep -iE 'May 15 00:0[0-9]:|May 15 12:0[0-9]:' /var/log/cron 2>/dev/null | egrep 'certbot|CROND' | tail -n 120 || true

echo
printf '===== letsencrypt_log_mtime =====\n'
for f in /var/log/letsencrypt/letsencrypt.log /var/log/letsencrypt/letsencrypt.log.1 /var/log/letsencrypt/letsencrypt.log.2 /var/log/letsencrypt/letsencrypt.log.3; do
  [ -f "$f" ] || continue
  stat -c '%y %n' "$f"
done

echo
printf '===== letsencrypt_recent_errors =====\n'
grep -HiE 'Failed to renew|Processing /etc/letsencrypt/renewal|Cert is due for renewal|unauthorized|parsefail|broken|NoInstallationError|Could not find a usable' /var/log/letsencrypt/letsencrypt.log* 2>/dev/null | tail -n 120 || true
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
