# S100P source adapter for the original channel flow

Run from `/home/sunrise/ainvr` as root; hardware executes as the configured AI
service account, currently `sunrise`:

```sh
python3 test/ai_port/run_stream_source_validation.py
python3 test/ai_port/run_stream_source_sei_validation.py
```

The first runner checks source contracts, the original publisher and compressed
tap. H.264/H.265 B-picture fixtures require exact compressed bytes, PTS/DTS and
display-picture associations. Real 3840 x 1920 RTMP is opened/stopped three times;
detached frame references must remain valid. Other checks cover latest-frame
replacement, full compressed queues, bounded cancellation, credential-safe
errors, invalid inputs, retry after failed initialization and three JPU decodes.
CPU encoders create isolated fixtures; they are test oracles only.

`StreamSource` owns demux, VPU and the compressed branch on its pump thread.
`FrameRef` holds immutable packed NV12, dimensions, source/mapped PTS and color
metadata. The SDK output is copied before returning its buffer. This is safe
cross-thread ownership, not zero-copy video. One source PTS clock feeds both
branches. Unique decode tokens and display POC associate B pictures with the
same PTS used by the original compressed publisher and SEI cache. The original
GOP shedding rule remains: once dropping starts, resume only at the next keyframe.

The SDK event fd can signal at startup before the render queue has output.
`VpuDecoder::Receive` therefore polls, checks `cur_output_buf_cnt`, then dequeues
with a bounded SDK wait. An empty queue means no frame yet; SDK errors still
fail visibly. The fd is released with `hb_mm_mc_close_fd`. JPEG uses this same
path and is included in regression.

The second runner directly connects this source to the original `StreamPublisher`
and delay/SEI buffer. It publishes only an isolated `ainvr-source-sei-test-<pid>`
stream, stamps empty test metadata using actual decoded display PTS, then reads
back through SRS. It checks compressed VCL hashes, output DTS, SEI PTS, another
VPU decoder and the production browser SEI parser. It never alters the user's
channel or generates pretend model detections. Actual browser playback remains
a separate acceptance gate.

Logs, XML and JSON are retained under `test/results/stream-source-*`. Generated
fixtures reside under SSD-backed `data/ai/test-runtime`. No skipped case counts
as a pass. The source-only suite passed 34 tests on 2026-10-12, including 24
H.264 and 24 H.265 B-picture decodes, 12 real 4K frames and three JPU images:
`test/results/stream-source-20261012-015519-1750227/summary.json`.

The source-to-publisher integration passed on the same board/code:
`test/results/stream-source-sei-20261012-020137-1760466/summary.json`.
It decoded 35 input 4K frames, verified 12 output SEI records against the original
compressed VCL hashes, decoded six output frames on VPU, and passed the production
browser parser. This run includes two actual VPU instances and the original
publisher/SRS connection; it measures correctness, not sustained inference FPS.

This source is not yet connected to the production worker factory. Next, port
the original `pipeline/channel_worker.cpp` lifecycle, watchdog, frame accounting,
hot configuration, result buffer and SEI coordination around the S100P interfaces.
Create/destroy BPU/GLES model resources on the inference thread that owns them;
the reference capture-thread initialization cannot be copied unchanged for that
hardware contract. Preserve original archive scheduling and use the tested
GPU/JPU snapshot backend. All user models still require HBM compilation and
precision validation; no CPU inference fallback is acceptable. These component
results do not prove user-model inference, recognition FPS or complete migration.
