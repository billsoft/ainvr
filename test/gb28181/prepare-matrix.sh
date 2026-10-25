#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUT="$ROOT/out/gb28181"
for video in h264 hevc; do
 if test "$video" = h264; then input="$OUT/video.ts"; else input="$OUT/hevc.ts"; fi
 "$OUT/ps_fixture" < "$input" > "$OUT/$video-silent.psrecords"
 "$OUT/ps_fixture" "$OUT/tone.alaw" 144 < "$input" > "$OUT/$video-alaw.psrecords"
 "$OUT/ps_fixture" "$OUT/tone.mulaw" 145 < "$input" > "$OUT/$video-mulaw.psrecords"
 "$OUT/ffmpeg-runtime/bin/ffmpeg" -hide_banner -loglevel error -i "$input" -stream_loop -1 -i "$OUT/tone.wav" -t 20 -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 32k -f mpegts -y "$OUT/$video-aac.ts"
 "$OUT/ps_fixture" < "$OUT/$video-aac.ts" > "$OUT/$video-aac.psrecords"
done
