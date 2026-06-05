import json, pathlib, re
src = pathlib.Path(r'C:\Users\MyPC\.neoctl\sessions\2026-05-15T06-24-18-508Z-CY-20250521AXZM-cb6ces\tool-results\call_UZkf0lJ8nubegjMRQjQIZiZd.json')
outp = pathlib.Path(r'D:\Backup\桌面\scaffold\han5j_sections.txt')
data = json.loads(src.read_text(encoding='utf-8'))
s = data['stdout']
parts = []
for pat in [
    r'===== han5j_nginx_hits =====[\s\S]*?===== letsencrypt_renewals =====',
    r'===== letsencrypt_renewals =====[\s\S]*?===== certbot_certs =====',
    r'===== certbot_certs =====[\s\S]*?===== acme_sh =====',
    r'===== cron =====[\s\S]*?===== systemd =====']:
    m = re.search(pat, s)
    parts.append('---SECTION---\n' + (m.group(0) if m else 'NOT FOUND') + '\n')
outp.write_text('\n'.join(parts), encoding='utf-8')
print(str(outp))
