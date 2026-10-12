#!/usr/bin/env bash
# Limit host packaging I/O. Docker builds need an explicit maintenance window:
# dockerd/BuildKit run outside this scope and cannot inherit its I/O limits.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${AINVR_BUILD_IO_SCOPE:-0}" == 1 ]]; then
  echo 'Do not invoke the scope wrapper recursively' >&2
  exit 2
fi
LIVE=0
systemctl is-active --quiet ainvr-recorder.service && LIVE=1
if [[ "$LIVE" == 1 && "${SKIP_BUILD:-0}" != 1 && "${AINVR_MAINTENANCE_BUILD:-0}" != 1 ]]; then
  echo 'Recording is active. Full Docker builds require an explicit maintenance window.' >&2
  exit 1
fi
DEV="$(findmnt -no SOURCE -T "$DIR")"
[[ -b "$DEV" ]] || { echo 'Cannot determine build filesystem block device' >&2; exit 1; }
USER_NAME="${SUDO_USER:-$(id -un)}"
if [[ ! -e /sys/fs/cgroup/system.slice/io.max ]]; then
  # Jetson's stock kernel may expose the io controller without BLK_DEV_THROTTLING.
  # systemd accepts bandwidth properties in that case but enforces no limit.
  if [[ "$LIVE" == 1 && "${AINVR_MAINTENANCE_BUILD:-0}" != 1 ]]; then
    echo 'Kernel lacks block I/O throttling. Packaging while recording requires an explicit maintenance window.' >&2
    exit 1
  fi
  echo 'Kernel lacks block I/O throttling; maintenance/offline build uses CPU priority only.' >&2
  export AINVR_BUILD_IO_SCOPE=1
  exec nice -n 10 bash "$DIR/build-release.sh" "$@"
fi
exec sudo systemd-run --scope --quiet \
  --property="IOReadBandwidthMax=$DEV 40M" \
  --property="IOWriteBandwidthMax=$DEV 20M" \
  --property=CPUWeight=10 --property=IOWeight=10 \
  sudo -u "$USER_NAME" env \
    SKIP_BUILD="${SKIP_BUILD:-0}" \
    AINVR_MAINTENANCE_BUILD="${AINVR_MAINTENANCE_BUILD:-0}" \
    AINVR_BUILD_IO_SCOPE=1 \
    nice -n 10 bash "$DIR/build-release.sh" "$@"
