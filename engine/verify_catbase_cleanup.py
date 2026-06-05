import paramiko

HOST='117.89.250.136'
USER='root'
PASSWORD='Hwj2018!'

cmd = r'''
printf '===== renewal_dir_check =====\n'
ls -la /etc/letsencrypt/renewal

echo
printf '===== backup_dirs =====\n'
ls -lad /root/letsencrypt-backup-* 2>/dev/null || true

echo
printf '===== catbase_conf_locations =====\n'
find /etc/letsencrypt /root -maxdepth 3 -name 'catbase.cn.conf' 2>/dev/null || true

echo
printf '===== certbot_process_now =====\n'
ps -ef | grep certbot | grep -v grep || true

echo
printf '===== dry_run_short =====\n'
certbot renew --dry-run 2>&1 || true
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60, auth_timeout=30, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(cmd, timeout=420)
out = stdout.read().decode('utf-8', errors='replace')
err = stderr.read().decode('utf-8', errors='replace')
print(out)
if err.strip():
    print('[stderr]')
    print(err)
client.close()
