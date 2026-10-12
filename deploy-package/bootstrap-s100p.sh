#!/usr/bin/env bash
# Copyright (c) 2026 AINVR. Platform dependencies, without changing board firmware.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ "${1:-}" == --check ]]; then
  for cmd in python3 node npm cmake g++ ffmpeg docker; do command -v "$cmd"; done
  python3 --version
  node --version
  /opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg -version | head -n 1
  exit 0
fi
[[ "${1:-}" == --install ]] || { echo 'Usage: bootstrap-s100p.sh --check|--install'; exit 2; }
[[ "$(uname -m)" == aarch64 && $EUID == 0 ]] || { echo 'Run as root on the S100P'; exit 1; }
apt-get install -y python3-venv python3-dev build-essential cmake pkg-config \
  libssl-dev libyaml-cpp-dev nlohmann-json3-dev libcpp-httplib-dev libgtest-dev \
  libmongoc-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
  libavformat-dev libavcodec-dev libavutil-dev libwayland-dev libgbm-dev libegl-dev libgles-dev \
  libsrt-openssl-dev libx264-dev cifs-utils nginx
python3 -m venv "$ROOT/.venv"
echo 'Node.js 24.x and the signed FFmpeg 8.1.2 runtime are required separately.'
