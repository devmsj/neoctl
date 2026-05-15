import paramiko

HOST='117.89.85.215'
USER='root'
PASSWORD='Hwj2018!'

cmd = r'''
printf '===== certbot_renew_dry_run =====\n'
certbot renew --dry-run 2>&1 || true

echo
printf '===== letsencrypt_logs =====\n'
ls -lt /var/log/letsencrypt/letsencrypt.log* 2>/dev/null || true
LATEST=$(ls -1t /var/log/letsencrypt/letsencrypt.log* 2>/dev/null | head -n 2)
for f in $LATEST; do
  echo "--- $f tail ---"
  tail -n 120 "$f" || true
  echo
 done

echo
printf '===== cron_certbot_entries =====\n'
grep -i 'certbot renew --quiet' /var/log/cron 2>/dev/null | tail -n 30 || true
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60, auth_timeout=30, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(cmd, timeout=360)
out = stdout.read().decode('utf-8', errors='replace')
err = stderr.read().decode('utf-8', errors='replace')
print(out)
if err.strip():
    print('[stderr]')
    print(err)
client.close()
