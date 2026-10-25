#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SOURCE="$ROOT/test/runtime/non-ai-port-20261011/ffmpeg-8.1.2.tar.xz"
BUILD="$ROOT/out/gb28181/ffmpeg-build"
PREFIX="$ROOT/out/gb28181/ffmpeg-runtime"
test -f "$SOURCE"
mkdir -p "$BUILD"
test -f "$BUILD/ffmpeg-8.1.2/configure" || tar -xJf "$SOURCE" -C "$BUILD"
cd "$BUILD/ffmpeg-8.1.2"
./configure --prefix="$PREFIX" --disable-everything --disable-autodetect --disable-debug --disable-doc \
 --enable-network --enable-protocol=file,pipe,tcp,udp,rtp,http,rtmp \
 --enable-demuxer=mov,flv,mpegts,rtsp,sdp,wav \
 --enable-muxer=mov,mp4,mpegts,flv,null,rtp \
 --enable-parser=h264,hevc,aac \
 --enable-decoder=aac,pcm_alaw,pcm_mulaw,pcm_s16le \
 --enable-encoder=aac --enable-filter=aresample,anull \
 --enable-bsf=extract_extradata,h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc
make -j2
make install
sha256sum "$SOURCE" "$PREFIX/bin/ffmpeg" "$PREFIX/bin/ffprobe"
