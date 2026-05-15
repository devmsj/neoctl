import paramiko

HOST='117.89.250.136'
USER='root'
PASSWORD='Hwj2018!'

cmd = r'''
printf '===== recent_cambrianer_catbase_from_logs =====\n'
grep -HiE 'cambrianer\.cn|catbase\.cn-0001|catbase\.cn/fullchain|new certificate deployed|Congratulations|No renewals were attempted|not yet due|Cert is due for renewal|Failed to renew|Processing /etc/letsencrypt/renewal/' /var/log/letsencrypt/letsencrypt.log* 2>/dev/null | tail -n 200 || true

echo
printf '===== live_symlink_targets =====\n'
for d in /etc/letsencrypt/live/cambrianer.cn /etc/letsencrypt/live/catbase.cn-0001; do
  echo "--- $d ---"
  for f in cert.pem chain.pem fullchain.pem privkey.pem; do
    if [ -L "$d/$f" ] || [ -e "$d/$f" ]; then
      ls -l "$d/$f" 2>&1 || true
    else
      echo "MISSING $d/$f"
    fi
  done
  echo
 done

echo
printf '===== archive_versions_mtime =====\n'
for d in /etc/letsencrypt/archive/cambrianer.cn /etc/letsencrypt/archive/catbase.cn-0001; do
  echo "--- $d ---"
  ls -lt "$d" 2>/dev/null || true
  echo
 done
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
