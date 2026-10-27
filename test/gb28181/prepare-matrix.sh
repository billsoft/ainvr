#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUT="$ROOT/out/gb28181"
REMUXER=${AINVR_GB_TEST_REMUXER:-"$OUT/ps_fixture"}
SUFFIX=${AINVR_GB_TEST_FIXTURE_SUFFIX:-}
case "$SUFFIX" in *[!A-Za-z0-9-]*) echo 'Invalid fixture suffix' >&2; exit 1;; esac
test -x "$REMUXER"
# Never replace fixture inputs that an existing long test may still be reading.
for video in h264 hevc; do
 for audio in silent alaw mulaw aac; do test ! -e "$OUT/$video-$audio$SUFFIX.psrecords"; done
 test ! -e "$OUT/$video-aac$SUFFIX.ts"
done
set -C
for video in h264 hevc; do
 if test "$video" = h264; then input="$OUT/video.ts"; else input="$OUT/hevc.ts"; fi
 "$REMUXER" < "$input" > "$OUT/$video-silent$SUFFIX.psrecords"
 "$REMUXER" "$OUT/tone.alaw" 144 < "$input" > "$OUT/$video-alaw$SUFFIX.psrecords"
 "$REMUXER" "$OUT/tone.mulaw" 145 < "$input" > "$OUT/$video-mulaw$SUFFIX.psrecords"
 "$OUT/ffmpeg-runtime/bin/ffmpeg" -hide_banner -loglevel error -i "$input" -stream_loop -1 -i "$OUT/tone.wav" -t 20 -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 32k -f mpegts -n "$OUT/$video-aac$SUFFIX.ts"
 "$REMUXER" < "$OUT/$video-aac$SUFFIX.ts" > "$OUT/$video-aac$SUFFIX.psrecords"
done
