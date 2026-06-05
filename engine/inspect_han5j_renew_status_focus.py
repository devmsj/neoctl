import paramiko

HOST='117.89.85.215'
USER='root'
PASSWORD='Hwj2018!'

cmd = r'''
printf '===== certbot_process_now =====\n'
ps -ef | grep certbot | grep -v grep || true

echo
printf '===== latest_letsencrypt_log_tail =====\n'
tail -n 160 /var/log/letsencrypt/letsencrypt.log 2>/dev/null || true

echo
printf '===== cron_certbot_entries =====\n'
grep -i 'certbot renew --quiet' /var/log/cron 2>/dev/null | tail -n 30 || true
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
