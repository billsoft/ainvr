#!/usr/bin/env bash
# Copyright AINVR. Builds in an isolated directory; does not enable a service.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "$(uname -m)" == aarch64 ]] || { echo 'Build on the S100P board'; exit 1; }
FFMPEG_ROOT="${AINVR_FFMPEG_ROOT:-/opt/ainvr/ffmpeg-8.1.2}"
[[ -f "$FFMPEG_ROOT/lib/pkgconfig/libavformat.pc" ]] || {
  echo 'Build the pinned FFmpeg runtime with build-ffmpeg-s100p.sh first'; exit 1;
}
pkg-config --exists libmongoc-1.0 yaml-cpp gstreamer-1.0 gstreamer-app-1.0 libavformat wayland-client
for library in libdnn.so libhbucp.so libhbmem.so libvpf.so libmultimedia.so libEGL.so libGLESv2.so libgbm.so; do
  [[ -f "/usr/hobot/lib/$library" ]] || { echo "Missing board SDK library: $library"; exit 1; }
done
cmake -S "$ROOT/ai-service" -B "$ROOT/out/build/ai-s100p" -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON -DAINVR_S100P=ON -DAINVR_LICENSE_SERVICE_USER=sunrise -DAINVR_FFMPEG_ROOT="$FFMPEG_ROOT"
cmake --build "$ROOT/out/build/ai-s100p" -j "${AINVR_BUILD_JOBS:-4}"
ctest --test-dir "$ROOT/out/build/ai-s100p" --output-on-failure
echo 'AINVR AI libraries and offline tools verified. Full service installation remains a separate step.'
