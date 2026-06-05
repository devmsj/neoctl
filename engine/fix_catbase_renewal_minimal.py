import paramiko

HOST='117.89.250.136'
USER='root'
PASSWORD='Hwj2018!'

cmd = r'''
set -e
TS=$(date +%F-%H%M%S)
BKDIR=/root/letsencrypt-backup-$TS
mkdir -p "$BKDIR"

echo '===== backup_and_move ====='
if [ -f /etc/letsencrypt/renewal/catbase.cn.conf ]; then
  cp -a /etc/letsencrypt/renewal/catbase.cn.conf "$BKDIR/"
  mv /etc/letsencrypt/renewal/catbase.cn.conf "$BKDIR/"
  echo "moved:/etc/letsencrypt/renewal/catbase.cn.conf -> $BKDIR/"
else
  echo 'catbase.cn.conf not found'
fi

echo
printf '===== backup_dir_list =====\n'
ls -la "$BKDIR"

echo
printf '===== renewal_dir_now =====\n'
ls -la /etc/letsencrypt/renewal

echo
printf '===== certbot_dry_run_after_cleanup =====\n'
certbot renew --dry-run 2>&1 || true
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60, auth_timeout=30, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(cmd, timeout=300)
out = stdout.read().decode('utf-8', errors='replace')
err = stderr.read().decode('utf-8', errors='replace')
print(out)
if err.strip():
    print('[stderr]')
    print(err)
client.close()
