#!/usr/bin/env bash
# S100P: install the hardware-only frame helper. Does not change recording settings.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
[ "$(id -u)" = 0 ] || { echo 'Run as root on S100P' >&2; exit 1; }
cmake -S "$ROOT/recording-service/native" -B "$ROOT/out/build/recording-frame"
cmake --build "$ROOT/out/build/recording-frame" -j2
mkdir -p "$ROOT/deploy/s100p/bin" /etc/systemd/system/ainvr-recorder.service.d
install -m 755 "$ROOT/out/build/recording-frame/ainvr_recording_frame" "$ROOT/deploy/s100p/bin/ainvr_recording_frame.new"
mv "$ROOT/deploy/s100p/bin/ainvr_recording_frame.new" "$ROOT/deploy/s100p/bin/ainvr_recording_frame"
printf '[Service]\nEnvironment=AINVR_RECORDING_FRAME_TOOL=%s/deploy/s100p/bin/ainvr_recording_frame\n' "$ROOT" > /etc/systemd/system/ainvr-recorder.service.d/90-evidence-recovery.conf
systemctl daemon-reload
echo 'Hardware helper installed. Restart ainvr-recorder during the application release.'
