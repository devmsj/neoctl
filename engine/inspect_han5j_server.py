import paramiko

HOST='117.89.85.215'
USER='root'
PASSWORD='Hwj2018!'

cmd = r'''
printf '===== os =====\n'
uname -a; echo '---'; cat /etc/os-release 2>/dev/null || true

echo
printf '===== web =====\n'
nginx -v 2>&1 || true
echo '---'
apachectl -v 2>&1 || httpd -v 2>&1 || true

echo
printf '===== processes =====\n'
ps -ef | egrep 'nginx|httpd|apache2|caddy|openresty' | grep -v grep || true

echo
printf '===== han5j_nginx_hits =====\n'
grep -RHiEn 'han5j|server_name|ssl_certificate|ssl_certificate_key' /etc/nginx /www/server/panel/vhost/nginx /usr/local/nginx/conf 2>/dev/null | head -n 400 || true

echo
printf '===== letsencrypt_renewals =====\n'
find /etc/letsencrypt/renewal -maxdepth 1 -type f -name '*.conf' 2>/dev/null | sort | while read f; do
  echo "--- $f ---"
  grep -E '^(version|archive_dir|cert|privkey|chain|fullchain|authenticator|installer|pref_challs|server)' "$f" || true
  echo
 done

echo
printf '===== certbot_certs =====\n'
certbot certificates 2>/dev/null || true

echo
printf '===== acme_sh =====\n'
/root/.acme.sh/acme.sh --list 2>/dev/null || ~/.acme.sh/acme.sh --list 2>/dev/null || true

echo
printf '===== cron =====\n'
crontab -l 2>/dev/null || true
echo '--- /etc/crontab ---'
cat /etc/crontab 2>/dev/null || true
echo '--- cron grep renew ---'
grep -RHiE 'certbot|acme.sh|renew' /etc/cron* 2>/dev/null || true

echo
printf '===== systemd =====\n'
systemctl list-timers --all 2>/dev/null | egrep 'certbot|acme|renew' || true
echo '---'
systemctl list-unit-files 2>/dev/null | egrep 'certbot|acme' || true
'''

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASSWORD, timeout=30, banner_timeout=60, auth_timeout=30, look_for_keys=False, allow_agent=False)
stdin, stdout, stderr = client.exec_command(cmd, timeout=240)
out = stdout.read().decode('utf-8', errors='replace')
err = stderr.read().decode('utf-8', errors='replace')
print(out)
if err.strip():
    print('[stderr]')
    print(err)
client.close()
