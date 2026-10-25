#!/bin/sh
# Installs only new GB components. Build/migrate the compatible console first.
set -eu
test "$(id -u)" = 0
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUT="$ROOT/out/gb28181"
for file in "$OUT/gateway" "$OUT/ZLMediaKit/release/linux/Release/MediaServer" "$OUT/ffmpeg-runtime/bin/ffmpeg" "$ROOT/srs-web-console/backend/dist/store/migrations/012_gb28181.sql"; do test -f "$file"; done
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="/var/backups/ainvr-gb28181/$STAMP"
umask 077
mkdir -p "$BACKUP"
for path in /opt/ainvr/gb28181 /etc/ainvr/gb28181-bootstrap.json /etc/ainvr/gb28181-media.ini /etc/systemd/system/ainvr-gb28181.service /etc/systemd/system/ainvr-gb-media.service; do
 if test -e "$path"; then cp -a --parents "$path" "$BACKUP/"; fi
done
for unit in ainvr-gb28181 ainvr-gb-media; do systemctl is-active "$unit" > "$BACKUP/$unit.active" || true; done
printf '%s\n' "$ROOT" > "$BACKUP/repository"
restore_on_error() {
 echo "Installation failed. Restoring new GB components from $BACKUP" >&2
 "$ROOT/deploy-package/gb28181/rollback.sh" "$BACKUP" || true
}
trap restore_on_error EXIT
id ainvr-gb >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin ainvr-gb
node "$ROOT/deploy-package/gb28181/provision.mjs"
systemctl stop ainvr-gb28181 ainvr-gb-media 2>/dev/null || true
mkdir -p /opt/ainvr/gb28181/ffmpeg
install -m755 "$OUT/gateway" /opt/ainvr/gb28181/gateway
install -m755 "$OUT/ZLMediaKit/release/linux/Release/MediaServer" /opt/ainvr/gb28181/MediaServer
cp -a "$OUT/ffmpeg-runtime/." /opt/ainvr/gb28181/ffmpeg/
chown ainvr-gb:ainvr-gb /etc/ainvr/gb28181-bootstrap.json /etc/ainvr/gb28181-media.ini
chmod 600 /etc/ainvr/gb28181-bootstrap.json /etc/ainvr/gb28181-media.ini
install -m644 "$ROOT/deploy-package/gb28181/ainvr-gb28181.service" /etc/systemd/system/
install -m644 "$ROOT/deploy-package/gb28181/ainvr-gb-media.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ainvr-gb-media ainvr-gb28181
systemctl is-active --quiet ainvr-gb-media
systemctl is-active --quiet ainvr-gb28181
trap - EXIT
echo "GB components installed; platform enablement unchanged. Rollback: $BACKUP"
