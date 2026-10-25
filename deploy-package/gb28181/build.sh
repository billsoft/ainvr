#!/bin/sh
# Reproducible source builds; does not stop or replace any running service.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUT="$ROOT/out/gb28181"
mkdir -p "$OUT/downloads" "$OUT/licenses"
cd "$OUT/downloads"
fetch() { test -f "$1" || curl --fail --location --retry 2 --output "$1.part" "$2"; if test -f "$1.part"; then mv "$1.part" "$1"; fi; printf '%s  %s\n' "$3" "$1" | sha256sum -c -; }
fetch go1.27.3.linux-arm64.tar.gz https://go.dev/dl/go1.27.3.linux-arm64.tar.gz a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49
test -x "$OUT/go/bin/go" || tar -xzf go1.27.3.linux-arm64.tar.gz -C "$OUT"
fetch ffmpeg-8.1.2.tar.xz https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz 464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c
if ! test -d "$OUT/ZLMediaKit/.git"; then git clone --no-checkout https://github.com/ZLMediaKit/ZLMediaKit.git "$OUT/ZLMediaKit"; fi
cd "$OUT/ZLMediaKit"
if ! git diff --quiet || ! git diff --cached --quiet; then echo 'Media source has local changes; refusing to replace' >&2; exit 1; fi
git checkout --detach bb83e697a60ad9dde679afcd7b85feeafdf7514b
git submodule update --init --recursive
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DENABLE_TESTS=OFF -DENABLE_WEBRTC=OFF -DENABLE_HLS=OFF -DENABLE_MP4=ON -DENABLE_FFMPEG=OFF
cmake --build build -j2
cd "$ROOT/gb28181-service"
GOMAXPROCS=2 GOTELEMETRY=off "$OUT/go/bin/go" mod verify
GOMAXPROCS=2 GOTELEMETRY=off "$OUT/go/bin/go" test -race -p 2 -timeout 45s ./...
GOMAXPROCS=2 GOTELEMETRY=off "$OUT/go/bin/go" build -trimpath -o "$OUT/gateway" ./cmd/gateway
mkdir -p "$OUT/ffmpeg-build"
test -f "$OUT/ffmpeg-build/ffmpeg-8.1.2/configure" || tar -xJf "$OUT/downloads/ffmpeg-8.1.2.tar.xz" -C "$OUT/ffmpeg-build"
cd "$OUT/ffmpeg-build/ffmpeg-8.1.2"
./configure --prefix="$OUT/ffmpeg-runtime" --disable-everything --disable-autodetect --disable-debug --disable-doc \
 --enable-network --enable-protocol=file,pipe,tcp,udp,rtp,http,rtmp \
 --enable-demuxer=mov,flv,mpegts,rtsp,sdp,wav --enable-muxer=mov,mp4,mpegts,flv,null,rtp \
 --enable-parser=h264,hevc,aac --enable-decoder=aac,pcm_alaw,pcm_mulaw,pcm_s16le \
 --enable-encoder=aac --enable-filter=aresample,anull \
 --enable-bsf=extract_extradata,h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc
make -j2
make install
python3 "$ROOT/deploy-package/gb28181/licenses.py"
sha256sum "$OUT/gateway" "$OUT/ZLMediaKit/release/linux/Release/MediaServer" "$OUT/ffmpeg-runtime/bin/ffmpeg" "$OUT/ffmpeg-runtime/bin/ffprobe" > "$OUT/artifacts.sha256"
echo 'Built isolated GB components. No services changed. Preserve sources and dependency licenses with distribution.'
