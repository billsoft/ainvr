#!/usr/bin/env bash
# Copyright (c) 2026 AINVR. Native host deployment, reusing deploy/infra.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
START=0
case "${1:-}" in
  --start) START=1;;
  --prepare|'') ;;
  *) echo 'Usage: install-s100p.sh [--prepare|--start]'; exit 2;;
esac
[[ $EUID == 0 && "$(uname -m)" == aarch64 ]] || { echo 'Run as root on S100P'; exit 1; }
[[ -f "$ROOT/srs-web-console/backend/dist/server.js" && -f "$ROOT/srs-web-console/frontend/dist/index.html" ]] || { echo 'Build first'; exit 1; }
command -v nginx >/dev/null || { echo 'Install nginx first'; exit 1; }
# The backend performs atomic hot updates in the SRS configuration directory.
chgrp sunrise "$ROOT/deploy/infra/config"
chmod g+rwx "$ROOT/deploy/infra/config"
python3 "$ROOT/deploy-package/prepare-s100p.py"
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1]); runtime=root/'deploy/s100p/runtime'; units=Path('/etc/systemd/system')
for name in ('license','license-enforcer','backend','recorder','ingest','os-helper','restart-helper','web'):
 p=units/('ainvr-'+name+'.service')
 if p.exists() and not p.read_text().startswith('# Managed by AINVR install-s100p.sh'):
  raise SystemExit('Existing unrelated service: '+str(p))
services={
 'backend':('sunrise',root/'srs-web-console/backend','/usr/local/bin/node '+str(root/'srs-web-console/backend/dist/server.js')),
 'recorder':('root',root/'recording-service',str(root/'.venv/bin/python')+' -m recorder.main'),
 'ingest':('sunrise',root/'ingest-service',str(root/'.venv/bin/python')+' '+str(root/'ingest-service/main.py')),
 'os-helper':('root',root/'shared/os-helper',str(root/'.venv/bin/python')+' '+str(root/'shared/os-helper/main.py')),
 'restart-helper':('root',root/'shared/host-restart-helper',str(root/'.venv/bin/python')+' '+str(root/'shared/host-restart-helper/restart_helper.py')),
}
for name,(user,cwd,command) in services.items():
 p=units/('ainvr-'+name+'.service')
 timeout=30 if name=='recorder' else 45
 value=f'''# Managed by AINVR install-s100p.sh
[Unit]
Description=AINVR {name} on RDK S100P
After=network-online.target docker.service ainvr-license.service
Wants=network-online.target
[Service]
Type=simple
User={user}
WorkingDirectory={cwd}
EnvironmentFile={runtime}/{name}.env
Environment=AINVR_DEPLOYMENT_MODE=native
ExecStart={command}
Restart=on-failure
RestartSec=5
TimeoutStopSec={timeout}
KillMode=mixed
NoNewPrivileges=true
UMask=0077
[Install]
WantedBy=multi-user.target
'''
 if p.exists() and not p.read_text().startswith('# Managed by AINVR install-s100p.sh'):
  raise SystemExit('Existing unrelated service: '+str(p))
 p.write_text(value)
license_unit=units/'ainvr-license.service'
if license_unit.exists() and not license_unit.read_text().startswith('# Managed by AINVR install-s100p.sh'):
 raise SystemExit('Existing unrelated license service')
license_unit.write_text(f'''# Managed by AINVR install-s100p.sh
[Unit]
Description=AINVR License Authority on RDK S100P
After=network.target
[Service]
User=sunrise
Group=sunrise
ExecStart={root}/out/build/s100p-license/license_service --config {runtime}/license-service.yaml
RuntimeDirectory=ainvr-license
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
UMask=0077
[Install]
WantedBy=multi-user.target
''')
enforcer = (root/'license-service/deploy/ainvr-license-enforcer.service.example').read_text()
enforcer = enforcer.replace('@ENFORCER@', str(root/'shared/license-enforcer/main.py'))
enforcer = enforcer.replace('/etc/ainvr-license/enforcer.env', str(runtime/'license-enforcer.env'))
(units/'ainvr-license-enforcer.service').write_text('# Managed by AINVR install-s100p.sh\n'+enforcer)
web=units/'ainvr-web.service'
if web.exists() and not web.read_text().startswith('# Managed by AINVR install-s100p.sh'):
 raise SystemExit('Existing unrelated web service')
web.write_text(f'''# Managed by AINVR install-s100p.sh
[Unit]
Description=AINVR Web UI on RDK S100P
After=ainvr-backend.service
[Service]
ExecStart=/usr/sbin/nginx -p {runtime}/nginx/ -c {runtime}/nginx.conf -g "daemon off;"
ExecReload=/usr/sbin/nginx -p {runtime}/nginx/ -c {runtime}/nginx.conf -s reload
LimitNOFILE=65536
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
''')
PY
nginx -t -p "$ROOT/deploy/s100p/runtime/nginx/" -c "$ROOT/deploy/s100p/runtime/nginx.conf"
# Reuse the bounded, read-only SRS incident observer from the mature deployment.
install -d -m 755 /opt/ainvr
install -m 755 "$ROOT/srs-web-console/deploy/srs-observer.py" /opt/ainvr/srs-observer.py
install -m 644 "$ROOT/srs-web-console/deploy/ainvr-srs-observer.service" /etc/systemd/system/ainvr-srs-observer.service
install -m 644 "$ROOT/deploy-package/60-ainvr-writeback.conf" /etc/sysctl.d/60-ainvr-writeback.conf
sysctl -p /etc/sysctl.d/60-ainvr-writeback.conf
# Native backend/helpers communicate over loopback; no console Docker subnets.
python3 "$ROOT/deploy-package/configure-internal-network.py" --static-only
systemctl daemon-reload
if ((START)); then
  python3 "$ROOT/deploy-package/configure-internal-network.py" --static-only --install-monitor
  systemctl enable --now ainvr-license ainvr-license-enforcer ainvr-backend ainvr-recorder ainvr-ingest ainvr-os-helper ainvr-restart-helper ainvr-web ainvr-srs-observer
fi
echo 'AINVR management UI: http://<board-ip>:8088. Production business requires AINVR licensing.'
