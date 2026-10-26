#!/bin/sh
# Bounded audio-capable stream-copy runtime. No video decoder/encoder is enabled.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT="$ROOT/out/media-bridge"
ARCHIVE="$ROOT/out/downloads/ffmpeg-8.1.2.tar.xz"
mkdir -p "$OUT/src" "$OUT/runtime/licenses" "$ROOT/out/downloads"
if ! test -f "$ARCHIVE"; then
 if test -f "$ROOT/out/gb28181/downloads/ffmpeg-8.1.2.tar.xz"; then cp "$ROOT/out/gb28181/downloads/ffmpeg-8.1.2.tar.xz" "$ARCHIVE";
 else curl --fail --location --max-time 180 --output "$ARCHIVE.part" https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz; mv "$ARCHIVE.part" "$ARCHIVE"; fi
fi
printf '%s  %s\n' 464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c "$ARCHIVE" | sha256sum -c -
test -f "$OUT/src/ffmpeg-8.1.2/configure" || tar -xJf "$ARCHIVE" -C "$OUT/src"
cd "$OUT/src/ffmpeg-8.1.2"
PATCH="$ROOT/deploy-package/patches/ffmpeg-8.1.2-no-rtsp-redirect.patch"
if ! grep -q 'AINVR RTSP redirect denied' libavformat/rtsp.c; then
 patch --batch --fuzz=0 -p1 < "$PATCH"
fi
cp "$PATCH" "$OUT/runtime/licenses/ffmpeg-8.1.2-no-rtsp-redirect.patch"
./configure --prefix="$OUT/runtime" --disable-everything --disable-autodetect --disable-debug --disable-doc \
 --enable-network --enable-protocol=file,pipe,tcp,udp,rtp,http,rtmp \
 --enable-demuxer=concat,mov,flv,mpegts,rtsp,sdp,wav \
 --enable-muxer=mov,mp4,mpegts,flv,null,rtp \
 --enable-parser=h264,hevc,aac \
 --enable-decoder=aac,pcm_alaw,pcm_mulaw,pcm_s16le,adpcm_g726,adpcm_g726le \
 --enable-encoder=aac --enable-filter=aresample,anull \
 --enable-bsf=extract_extradata,h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc
nice -n 10 make -j2
make install
cp COPYING.LGPLv2.1 "$OUT/runtime/licenses/FFmpeg-LGPL-2.1.txt"
"$OUT/runtime/bin/ffmpeg" -version > "$OUT/runtime/build-info.txt"
(cd "$OUT/runtime" && sha256sum bin/ffmpeg bin/ffprobe licenses/ffmpeg-8.1.2-no-rtsp-redirect.patch > checksums.sha256)
printf '%s  ffmpeg-8.1.2.tar.xz\n' 464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c > "$OUT/runtime/source-archive.sha256"
