#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CHECK=0
if test "${1:-}" = --check; then CHECK=1; shift; fi
test "$(id -u)" = 0
if test "${AINVR_GB_DEPLOY_LOCK_HELD:-0}" = 1; then
 test "$(readlink /proc/$$/fd/9)" = /run/lock/ainvr-ptz-deploy.lock
else
 exec 9>/run/lock/ainvr-ptz-deploy.lock
 flock -n 9 || { echo 'Another GB deployment or rollback is active' >&2; exit 1; }
fi
BACKUP=$(realpath -- "${1:?Specify the backup directory}")
python3 "$ROOT/deploy-package/gb28181/backup_policy.py" --check "$BACKUP"
if test "$CHECK" = 1; then echo 'GB rollback preflight passed; services unchanged'; exit 0; fi
systemctl stop ainvr-gb28181 ainvr-gb-media 2>/dev/null || true
if test -d "$BACKUP/opt/ainvr/gb28181"; then
 # Retain the failed install for diagnosis; never delete customer data.
 test ! -e /opt/ainvr/gb28181 || mv /opt/ainvr/gb28181 "$BACKUP/failed-install-$(date +%s)"
 cp -a "$BACKUP/opt/ainvr/gb28181" /opt/ainvr/
fi
for path in etc/ainvr/gb28181-bootstrap.json etc/ainvr/gb28181-media.ini etc/systemd/system/ainvr-gb28181.service etc/systemd/system/ainvr-gb-media.service; do
 if test -f "$BACKUP/$path"; then cp -a "$BACKUP/$path" "/$path"; fi
done
systemctl daemon-reload
for unit in ainvr-gb-media ainvr-gb28181; do
 if test -f "$BACKUP/$unit.enabled"; then
  state=$(cat "$BACKUP/$unit.enabled")
  case "$state" in
   enabled) systemctl enable "$unit" ;;
   enabled-runtime) systemctl enable --runtime "$unit" ;;
   *) systemctl disable "$unit" 2>/dev/null || true ;;
  esac
 elif ! grep -qx active "$BACKUP/$unit.active"; then
  # Compatibility for older backups which did not record boot enablement.
  systemctl disable "$unit" 2>/dev/null || true
 fi
 if grep -qx active "$BACKUP/$unit.active"; then systemctl start "$unit"; fi
done
echo 'GB components rolled back. Parameter migrations and historical data retained; SRS, AI and recorder untouched.'
