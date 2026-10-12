#!/usr/bin/env bash
# Copyright (c) 2026 AINVR. Signed third-party runtime for remux and ingestion.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORK="$ROOT/test/runtime/ffmpeg-s100p"
VERSION=8.1.2
mkdir -p "$WORK/gnupg"
chmod 700 "$WORK/gnupg"
cd "$WORK"
for name in "ffmpeg-$VERSION.tar.xz" "ffmpeg-$VERSION.tar.xz.asc"; do
  [[ -f "$name" ]] || curl -fL --connect-timeout 10 --max-time 120 "https://ffmpeg.org/releases/$name" -o "$name"
done
[[ -f ffmpeg-devel.asc ]] || curl -fL --connect-timeout 10 --max-time 30 https://ffmpeg.org/ffmpeg-devel.asc -o ffmpeg-devel.asc
gpg --homedir "$WORK/gnupg" --with-colons --import-options show-only --import ffmpeg-devel.asc | \
  grep -q 'FCF986EA15E6E293A5644F10B4322F04D67658D8'
gpg --homedir "$WORK/gnupg" --import ffmpeg-devel.asc
gpg --homedir "$WORK/gnupg" --verify "ffmpeg-$VERSION.tar.xz.asc" "ffmpeg-$VERSION.tar.xz"
[[ -d "ffmpeg-$VERSION" ]] || tar -xJf "ffmpeg-$VERSION.tar.xz"
cd "ffmpeg-$VERSION"
./configure --prefix="/opt/ainvr/ffmpeg-$VERSION" --disable-everything --disable-autodetect \
  --disable-debug --disable-doc --enable-network --enable-gpl --enable-version3 \
  --enable-libx264 --enable-libsrt --enable-openssl \
  --enable-protocol=file,pipe,tcp,udp,rtp,http,https,rtmp,rtmps,libsrt \
  --enable-demuxer=concat,mov,flv,matroska,mpegts,rtsp,sdp,rawvideo \
  --enable-muxer=mov,mp4,mpegts,flv,matroska,null,rtp --enable-parser=h264,hevc,aac \
  --enable-decoder=h264,hevc,aac,rawvideo,wrapped_avframe \
  --enable-encoder=libx264,aac,rawvideo,wrapped_avframe \
  --enable-filter=color,testsrc,testsrc2,scale,format,anull,null,fps --enable-indev=lavfi \
  --enable-bsf=aac_adtstoasc,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb,filter_units
make -j "${AINVR_BUILD_JOBS:-4}"
make install
# The runtime retains FFmpeg's own copyright and GPL notices.
install -d "/opt/ainvr/ffmpeg-$VERSION/share/licenses"
install -m 0644 COPYING.GPLv3 "/opt/ainvr/ffmpeg-$VERSION/share/licenses/"
