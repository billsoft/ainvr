# Real 4K stream delivery and recording checks

Run these scripts on the S100P in `/home/sunrise/ainvr`. They use the real
`live/xm` H.264 3840x1920 source and existing SRS 7.0.162. They only inspect or
copy compressed packets; they do not run CPU image processing or inference.

## What failed and what changed

On 2026-10-12, production recordings contained exact 10.033-second video DTS
gaps. Both FFmpeg 4.4 and 8.1.2 readers reproduced them. Remuxing an identical
fixture with either writer preserved its video packet count and relative DTS.
Changing the FFmpeg version alone therefore did not fix this failure.

A simultaneous 60-second probe found an RTMP gap while HTTP-FLV delivered
continuous video from the same SRS publisher. The RTMP socket had a 50,000-byte
send buffer and about 40ms ACK latency even on loopback.

SRS derives its RTMP send buffer from `mw_latency` with a fixed 4000kbps
assumption. See the [official SRS 7 branch implementation](https://github.com/ossrs/srs/blob/7.0release/trunk/src/protocol/srs_protocol_conn.cpp).
The branch can advance; actual 7.0.162 socket logs independently confirmed
50,000 bytes at 100ms and 175,000 bytes at 350ms.

Two isolated instances of the **same installed image**, receiving identical
copy-only input from one demuxer, showed:

| Setting | Video packets | Largest DTS step | Gaps |
| --- | ---: | ---: | --- |
| `mw_latency 100` | 1295 | 10034ms | Two roughly ten-second gaps |
| `mw_latency 350` | 2049 | 34ms | None |

This supports the send-buffer hypothesis for this stream and host. The change
raises the configured batching interval too; browser latency remains a separate
acceptance check. It does not increase the ten-second consumer queue limit or
hide packet loss by changing timestamps.

The production configuration in `deploy/infra/config/srs.conf` now uses 350ms.
SRS accepted its configuration test and automatic reload. The publisher CID
remained `9ld03623`. The recorder reconnected once to obtain the new buffer.
The previous config is recoverable from
`/mnt/ainvr-ssd/migration-backups/srs-buffer-20261012-042426/srs.conf`.

## Reusable checks

```sh
cd /home/sunrise/ainvr
python3 test/non_ai/verify_srs_delivery_timing.py
python3 test/non_ai/verify_srs_send_buffer.py
python3 test/non_ai/verify_recording_continuity.py \
  --channel 2baec0a3-9941-47dc-b1bd-d3d284488097 \
  --after 20261012_043753 --segments 2 \
  --start-file 2baec0a3-9941-47dc-b1bd-d3d284488097_20261012_043753.722.mp4
```

- `verify_srs_delivery_timing.py` samples RTMP and HTTP-FLV simultaneously for
  60 seconds and saves raw packet DTS/receipt times. Its `gaps` field detects
  steps above 200ms. Inspect all raw steps for individual dropped frames.
  SRS ingress counters are periodic snapshots: the apparent 300-frame updates
  every ten seconds do **not** prove that the publisher sends ten-second bursts.
- `verify_srs_send_buffer.py` starts two temporary, locally bound containers
  on ports 12935/13935, forwards the real source with stream copy, compares
  100ms/350ms delivery for 65 seconds, then stops its processes and containers.
  It does not change the production configuration. Run one instance at a time.
- `verify_recording_continuity.py` excludes files still open by a process.
  It requires completed H.264 3840x1920 segments at least 50 seconds long,
  packet-derived FPS between 29.95 and 30.05, positive DTS steps, and a largest
  step at most 35ms. A missing segment, timeout, or packet gap fails the check.
  For a restart, use the exact first writer filename: a finalized short file
  from the old connection can share its whole-second timestamp with the new
  file. `--start-file` makes that deployment boundary explicit; it does not
  loosen frame, duration, or timestamp requirements.
- `verify_gop_mux_timestamps.py --input /mnt/ainvr-ssd/lab/<fixture>.ts`
  uses the original TS parser to cut completed GOPs and compares system/new
  writers and timestamp-related muxer options offline. Its report records
  relative DTS errors and packet counts; a completed experiment is not itself
  a production continuity pass.

## Evidence and scope

- Before: `test/results/srs-delivery-20261012-041631/summary.json`
- Isolated A/B: `test/results/srs-buffer-20261012-042235/summary.json`
- Install: `test/results/srs-buffer-production-install.json`
- After reload: `test/results/srs-delivery-20261012-042443/summary.json`
- Closed files: `test/results/recording-continuity-*.json`

The first strict two-file check,
`test/results/recording-continuity-20261012-042658.json`, **failed**: both files
had 2000 video packets and no ten-second gaps; the first had a largest DTS step
of 34ms, while the second had a 105.5ms step between its first two packets.
Offline GOP tests reproduced a 124.167ms first step with both FFmpeg versions.
Explicitly shifting negative timestamps fixed video DTS but did not preserve
the original A/V start offset in immediate `empty_moov` files. Adding
`delay_moov` preserved video and audio packet counts, their relative DTS and
the A/V start offset (within 1ms). See
`test/results/gop-mux-20261012-043705/summary.json`.

The final recorder change only adds `delay_moov` to the existing fragmented
MP4 flags, with a source comment. It keeps stream copy, GOP scheduling and
all original controller/storage behavior. FFmpeg documents this header option
in its [MOV/MP4 muxer section](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv).
The moov is written when the first fragment is flushed. As before, useful
recorded video needs a completed first fragment; this does not claim a new
low-latency live-recording playback behavior.

Command, pipeline and reconnect/drain tests passed: 31 tests in
`test/results/recorder-delay-moov-regression.log`. The original pre-change
writer is backed up in
`/mnt/ainvr-ssd/migration-backups/recorder-mux-20261012-043134/ffmpeg_recorder.py`.
Real closed files after final deployment must also pass the strict continuity
check; do not relax its threshold to hide a remaining gap.

Final production result: `test/results/recording-continuity-20261012-044008.json`
passed for the first two completed files produced by the final writer:
2000 packets each, 66.633/66.634 seconds, 30.00015/29.99970 FPS, maximum DTS
step 34ms, no nonpositive steps. This is roughly 133 seconds of completed
recordings, with an explicit reconnect boundary; it is not an all-day soak test.

These are finite delivery and recording checks, not proof of all playback,
NAS/quota/failure recovery, long-running continuity, or browser WebRTC/SEI
acceptance. Original recorder scheduling/storage logic remains in use;
TecheAI reference files stay unchanged.
