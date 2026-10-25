#!/bin/sh
set -eu
test "$(id -u)" = 0
BACKUP=$(realpath -- "${1:?Specify the backup directory}")
case "$BACKUP" in /var/backups/ainvr-gb28181/*) ;; *) echo 'Invalid rollback path' >&2; exit 1;; esac
test -f "$BACKUP/repository"
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
 if grep -qx active "$BACKUP/$unit.active"; then systemctl start "$unit"; else systemctl disable "$unit" 2>/dev/null || true; fi
done
echo 'GB components rolled back. Parameter migrations and historical data retained; SRS, AI and recorder untouched.'
