import paramiko

HOST='117.89.250.136'
USER='root'
PASSWORD='Hwj2018!'

cmd = r'''
printf '===== user_path =====\n'
echo "$PATH"

echo
printf '===== nginx_binary_candidates =====\n'
which nginx 2>&1 || true
command -v nginx 2>&1 || true
for p in /usr/sbin/nginx /usr/bin/nginx /usr/local/nginx/sbin/nginx /usr/local/openresty/nginx/sbin/nginx /opt/nginx/sbin/nginx; do
  if [ -e "$p" ] || [ -L "$p" ]; then
    ls -l "$p"
  else
    echo "MISSING $p"
  fi
done

echo
printf '===== nginx_runtime_info =====\n'
nginx -v 2>&1 || true
ps -ef | grep nginx | grep -v grep || true

echo
printf '===== certbot_plugins =====\n'
certbot plugins 2>&1 || true

echo
printf '===== rpm_packages =====\n'
rpm -qa | egrep 'certbot|nginx' | sort || true

echo
printf '===== python_imports =====\n'
python2 - <<'PY'
mods = ['certbot', 'certbot_nginx', 'OpenSSL', 'cryptography']
for m in mods:
    try:
        mod = __import__(m)
        print('%s => %s' % (m, getattr(mod, '__file__', 'built-in')))
    except Exception as e:
        print('%s => ERROR: %s' % (m, e))
PY

echo
printf '===== certbot_nginx_package_files =====\n'
rpm -ql python2-certbot-nginx 2>&1 || rpm -ql certbot-nginx 2>&1 || true

echo
printf '===== certbot_help_nginx =====\n'
certbot --help nginx 2>&1 || true
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
