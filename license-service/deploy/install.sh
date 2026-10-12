#!/usr/bin/env bash
# One installer for source and release layouts. Never manufactures credentials.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
REPO="$(cd "$ROOT/.." && pwd)"
BIN="$ROOT/build/license_service"
SHARED="$REPO/shared"
PROVISION="${LICENSE_PROVISION_DIR:-}"
START=1
VALIDATE_ONLY=0
SECURITY_ARGS=()
CONSOLE="$REPO/srs-web-console"
while (($#)); do
  case "$1" in
    --validate-only) VALIDATE_ONLY=1; shift;;
    --development-host) SECURITY_ARGS+=(--development-host); shift;;
    --console) CONSOLE="$2"; shift 2;;
    --no-start) START=0; shift;;
    --binary) BIN="$2"; shift 2;;
    --shared) SHARED="$2"; shift 2;;
    --provision) PROVISION="$2"; shift 2;;
    *) echo "Unknown argument: $1" >&2; exit 2;;
  esac
done
[[ $EUID == 0 ]] || { echo "Run with sudo after reviewing the provisioning package." >&2; exit 1; }
[[ -n "$PROVISION" ]] || { echo "LICENSE_PROVISION_DIR or --provision is required." >&2; exit 1; }
[[ -x "$BIN" ]] || { echo "Build the license binary before installation" >&2; exit 1; }
[[ "$("$BIN" --license-policy)" == mandatory-v3-ed25519 ]] || { echo "Refusing a stale license authority binary" >&2; exit 1; }
python3 "$HERE/security_preflight.py" "${SECURITY_ARGS[@]}" --path "$BIN" --path "$SHARED" --path "$PROVISION" --docker
MACHINE="$("$BIN" --machine-code)"
python3 "$HERE/validate_provision.py" "$PROVISION" "$MACHINE"
ENFORCER="$SHARED/license-enforcer/main.py"
[[ -f "$ENFORCER" ]] || ENFORCER="$SHARED/license-enforcer/main.pyc"
[[ -f "$ENFORCER" ]] || { echo "Missing independent enforcer" >&2; exit 1; }
[[ -f "$SHARED/python/license_client.py" || -f "$SHARED/python/license_client.pyc" ]] || exit 1
((VALIDATE_ONLY)) && { echo "License provisioning preflight passed"; exit 0; }
install -d -o root -g sunrise -m 0750 /etc/ainvr-license
install -d -o sunrise -g sunrise -m 0700 /var/lib/ainvr-license
install -d -o sunrise -g sunrise -m 0700 /var/lib/ainvr-license-identity
install -d -o sunrise -g sunrise -m 0750 /run/ainvr-license
install -o root -g sunrise -m 0640 "$PROVISION/license-service.yaml" /etc/ainvr-license/license-service.yaml
for client in ai-service recorder console-backend enforcer; do
  install -o root -g sunrise -m 0640 "$PROVISION/$client.env" "/etc/ainvr-license/$client.env"
done
python3 - "$HERE" "$BIN" "$ENFORCER" <<'PY'
from pathlib import Path
import sys
here,binary,enforcer=sys.argv[1:]
for name in ('ainvr-license','ainvr-license-enforcer'):
    value=(Path(here)/(name+'.service.example')).read_text().replace('@BIN@',binary).replace('@ENFORCER@',enforcer)
    (Path('/etc/systemd/system')/(name+'.service')).write_text(value)
for unit,client in (('ai-service','ai-service'),('ainvr-recorder','recorder')):
    d=Path('/etc/systemd/system')/(unit+'.service.d');d.mkdir(exist_ok=True)
    (d/'license.conf').write_text('[Service]\nEnvironmentFile=/etc/ainvr-license/'+client+'.env\n')
PY
systemctl daemon-reload
systemctl enable ainvr-license ainvr-license-enforcer
if ((START)); then
  systemctl restart ainvr-license
  systemctl restart ainvr-license-enforcer
  systemctl try-restart ai-service ainvr-recorder
  # env_file contents are only loaded when the container is recreated.
  if [[ -f "$CONSOLE/docker-compose.yml" ]]; then
    (cd "$CONSOLE" && AINVR_GID="$(id -g sunrise)" docker compose up -d --no-deps --force-recreate backend)
  fi
fi
echo "Installed. Console Compose must use /etc/ainvr-license/console-backend.env."
