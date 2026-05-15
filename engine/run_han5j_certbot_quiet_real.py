import paramiko

HOST='117.89.85.215'
USER='root'
PASSWORD='Hwj2018!'

cmd = r'''
printf '===== precheck_certbot_process =====\n'
ps -ef | grep certbot | grep -v grep || true

echo
printf '===== certbot_renew_quiet =====\n'
certbot renew --quiet
RET=$?
echo
printf '===== exit_code =====\n'
echo "$RET"

echo
printf '===== letsencrypt_log_tail =====\n'
tail -n 160 /var/log/letsencrypt/letsencrypt.log 2>/dev/null || true
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
