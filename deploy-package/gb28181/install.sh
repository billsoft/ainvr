#!/bin/sh
# Installs only new GB components. Build/migrate the compatible console first.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUT="$ROOT/out/gb28181"
CHECK=0
GATEWAY=
GATEWAY_SHA=
while test "$#" -gt 0; do
 case "$1" in
  --check) CHECK=1; shift ;;
  --gateway) test "$#" -ge 2; GATEWAY=$2; shift 2 ;;
  --gateway-sha256) test "$#" -ge 2; GATEWAY_SHA=$2; shift 2 ;;
  *) echo 'Usage: install.sh [--check] [--gateway PATH --gateway-sha256 SHA256]' >&2; exit 2 ;;
 esac
done
set -- --root "$ROOT"
if test -n "$GATEWAY"; then set -- "$@" --gateway "$GATEWAY"; fi
if test -n "$GATEWAY_SHA"; then set -- "$@" --gateway-sha256 "$GATEWAY_SHA"; fi
VERIFIED=$(python3 "$ROOT/deploy-package/gb28181/verify_install.py" "$@")
printf '%s\n' "$VERIFIED"
GATEWAY_SHA=$(printf '%s\n' "$VERIFIED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["gatewaySHA256"])')
test "$CHECK" = 0 || exit 0
test "$(id -u)" = 0
test -n "$GATEWAY" || GATEWAY="$OUT/gateway"
exec 9>/run/lock/ainvr-ptz-deploy.lock
flock -n 9 || { echo 'Another GB deployment or rollback is active' >&2; exit 1; }
for unit in ainvr-gb28181 ainvr-gb-media; do
 state=$(systemctl is-enabled "$unit" 2>/dev/null || true)
 case "$state" in
  enabled|enabled-runtime|disabled|static|not-found|'') ;;
  *) echo 'GB service enablement requires manual reconciliation before update' >&2; exit 1 ;;
 esac
done
STAMP=$(date -u +%Y%m%dT%H%M%SZ)-$$
python3 "$ROOT/deploy-package/gb28181/backup_policy.py" --prepare
BACKUP="/mnt/ainvr-ssd/ainvr-rollback/gb28181/$STAMP"
umask 077
mkdir -p "$BACKUP"
for path in /opt/ainvr/gb28181 /etc/ainvr/gb28181-bootstrap.json /etc/ainvr/gb28181-media.ini /etc/systemd/system/ainvr-gb28181.service /etc/systemd/system/ainvr-gb-media.service; do
 if test -e "$path"; then cp -a --parents "$path" "$BACKUP/"; fi
done
for unit in ainvr-gb28181 ainvr-gb-media; do
 systemctl is-active "$unit" > "$BACKUP/$unit.active" || true
 systemctl is-enabled "$unit" > "$BACKUP/$unit.enabled" 2>/dev/null || true
 if test -e "/etc/systemd/system/$unit.service"; then printf 'yes\n' > "$BACKUP/$unit.existed"; fi
done
printf '%s\n' "$ROOT" > "$BACKUP/repository"
restore_on_error() {
 echo "Installation failed. Restoring new GB components from $BACKUP" >&2
 AINVR_GB_DEPLOY_LOCK_HELD=1 "$ROOT/deploy-package/gb28181/rollback.sh" "$BACKUP" || true
}
trap restore_on_error EXIT
id ainvr-gb >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ainvr-gb
node "$ROOT/deploy-package/gb28181/provision.mjs"
systemctl stop ainvr-gb28181 ainvr-gb-media 2>/dev/null || true
mkdir -p /opt/ainvr/gb28181/ffmpeg
install -m755 "$GATEWAY" /opt/ainvr/gb28181/gateway
install -m755 "$OUT/ZLMediaKit/release/linux/Release/MediaServer" /opt/ainvr/gb28181/MediaServer
cp -a "$OUT/ffmpeg-runtime/." /opt/ainvr/gb28181/ffmpeg/
cp -a "$OUT/licenses" /opt/ainvr/gb28181/
python3 "$ROOT/deploy-package/gb28181/verify_install.py" --root "$ROOT" --gateway "$GATEWAY" --gateway-sha256 "$GATEWAY_SHA" --installed-root /opt/ainvr/gb28181
sha256sum /opt/ainvr/gb28181/gateway /opt/ainvr/gb28181/MediaServer /opt/ainvr/gb28181/ffmpeg/bin/ffmpeg /opt/ainvr/gb28181/ffmpeg/bin/ffprobe > /opt/ainvr/gb28181/installed.sha256
chown ainvr-gb:ainvr-gb /etc/ainvr/gb28181-bootstrap.json /etc/ainvr/gb28181-media.ini
chmod 600 /etc/ainvr/gb28181-bootstrap.json /etc/ainvr/gb28181-media.ini
install -m644 "$ROOT/deploy-package/gb28181/ainvr-gb28181.service" /etc/systemd/system/
install -m644 "$ROOT/deploy-package/gb28181/ainvr-gb-media.service" /etc/systemd/system/
systemctl daemon-reload
for unit in ainvr-gb-media ainvr-gb28181; do
 if test -f "$BACKUP/$unit.existed"; then
  state=$(cat "$BACKUP/$unit.enabled")
  case "$state" in
   enabled) systemctl enable "$unit" ;;
   enabled-runtime) systemctl enable --runtime "$unit" ;;
   *) systemctl disable "$unit" 2>/dev/null || true ;;
  esac
  if grep -qx active "$BACKUP/$unit.active"; then systemctl start "$unit"; systemctl is-active --quiet "$unit"; fi
 else
  systemctl enable --now "$unit"
  systemctl is-active --quiet "$unit"
 fi
done
trap - EXIT
python3 "$ROOT/deploy-package/gb28181/backup_policy.py" --prune
echo "GB components installed; platform enablement unchanged. Rollback: $BACKUP"
