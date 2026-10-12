#!/usr/bin/env bash
# AINVR official OE download helper. Run compilation on an x86_64 host,
# not on the ARM64 deployment board. On the board, only store files on SSD.
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo 'Usage: fetch_oe_3_7_0.sh /absolute/download/directory' >&2
  exit 2
fi
case "$1" in /*) ;; *) echo 'An absolute output path is required' >&2; exit 2;; esac
mkdir -p -- "$1"
destination=$(realpath -- "$1")
if [ "$(uname -m)" = aarch64 ]; then
  mountpoint -q /mnt/ainvr-ssd
  case "$destination" in /mnt/ainvr-ssd/*) ;; *) echo 'Use mounted SSD on the board' >&2; exit 2;; esac
fi
base='https://d-robotics-aitoolchain.oss-cn-beijing.aliyuncs.com/oe/3.7.0'
# Fixed lengths verified from the official OSS HTTPS response, 2026-10-12.
# ETag is multipart and is NOT a SHA256 checksum.
fetch() {
  local name="$1" expected="$2" partial="$destination/$1.partial"
  if [ -f "$destination/$name" ]; then
    test "$(stat -c %s "$destination/$name")" -eq "$expected"
    return
  fi
  curl --fail --location --continue-at - --connect-timeout 20 \
    --max-time 1800 --retry 1 --retry-delay 3 \
    --output "$partial" "$base/$name"
  test "$(stat -c %s "$partial")" -eq "$expected"
  mv -n -- "$partial" "$destination/$name"
}
fetch ai_toolchain_ubuntu_22_s100_s600_cpu_v3.7.0.tar 11212483072
fetch oe-package-3.7.0-s100-s600.tgz 2846971999
cd -- "$destination"
sha256sum ai_toolchain_ubuntu_22_s100_s600_cpu_v3.7.0.tar \
  oe-package-3.7.0-s100-s600.tgz
# These hashes record locally downloaded identities, not publisher signatures.
echo 'Next on x86_64: docker load -i ai_toolchain_ubuntu_22_s100_s600_cpu_v3.7.0.tar'
echo 'S100P compiler target: nash-m. A successful download is not a model accuracy test.'
