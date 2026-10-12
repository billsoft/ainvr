# AINVR production archive integration on RDK S100P

Run on the authorized board:

```sh
cd /home/sunrise/ainvr
python3 test/ai_port/run_hardware_archive_validation.py
```

The runner builds the original production `SnapshotStore`, runs it as the AI
service user, and connects to real MongoDB in `ainvr_gpu_snapshot_tests`. Fixture
channels are unique to the test process. It does not inject detection history
into the user's channel, alter its configuration, or stop MongoDB. The reference
suite uses its own separate database. Pixel fixtures and CPU JPEG decoding are
test oracles; production crop, ERP, brightness and JPEG execute on Mali/JPU.

Results, GTest XML and build logs are retained under
`test/results/hardware-archive-<timestamp>-<pid>/`. Hardware tests must all pass;
skips are not acceptance. The runner also runs the GPU crop quality suite against
the original CPU oracle and the original archive business regression suite.

Coverage includes 4K ERP crops with original/processed JPEGs, sparse 8K odd-sized
ROI crops, asynchronous capture ownership, per-job processing configuration,
pagination, precise time-range deletion, hot capture disable, rolling retention,
database outage, durable recovery after restart, suppression of deleted pending
jobs, corrupt recovery data and explicit unavailable BPU enhancement. A loopback
TCP proxy disconnects only the test clients to exercise the real offline spool.

New pending files use bounded raw RGBA rows in CBOR (version 3), not CPU PNG
compression. This preserves pixels and alpha exactly. The original durable rename,
fsync, per-channel 1 GiB allowance and 5 GiB disk reserve remain in force. Raw rows
use more disk than PNG; reaching the existing allowance causes visible backpressure.
Legacy PNG pending files require explicit offline conversion; production retains
them as `.bad` rather than silently decoding on CPU. The CPU reference suite alone
can decode old fixtures. No legacy pending jobs existed on this board before the
change. Do not remove quarantine files to conceal a failure.

Ordinary crop planning uses global coordinates and original rounding before
subtracting the downloaded ROI origin. Thus fractional box rounding, replicated
border padding, area interpolation and output sizes remain consistent with the
original algorithm while sparse 8K targets avoid full-frame transfers.

Short-lived crop backends reuse one EGL context, compiled shader and immutable
interpolation coefficient table per calling thread and selected render node.
Changing to an unavailable render node fails visibly; a cached valid context
must not mask it. Contexts with failed GL operations are replaced on subsequent
backend creation. Thread exit releases its cache. Caller EGL bindings are saved
and restored on every activation. Textures, buffers and quantized ERP map LRUs
remain backend-local; an owner token rejects maps borrowed from another backend,
even when both share the context. First-view cache behavior is unchanged.

`Continuous4KErpQueueMeasuresHardwareAndDurability` measures the real original
production queue with a synthetic resident 3840 x 1920 RGBA source, two targets
per frame and two JPU JPEGs per target. Each exposure-off/on phase warms four
frames, then times 30 frames through capture, worker processing, Mongo commit and
query visibility. All 136 warm-up/timed targets must become durable. GPU/JPU
counters and pixel checks are required; VPU decoding and model inference are
explicitly excluded. Output FPS is queue throughput, not live recognition FPS.

Before/after results on this board (2026-10-12):

| Phase | Before frames/s | After frames/s | Crop mean before/after |
| --- | ---: | ---: | ---: |
| Exposure off | 14.45 | 69.48 | 119.35 / 15.94 ms |
| Exposure on | 10.83 | 25.92 | 119.96 / 16.06 ms |

The timed optimized phases created no new crop contexts or shaders after warm-up.
The uninstrumented baseline does not have reliable resource counters. Its report
marks them unavailable. `--performance-baseline` is restricted to the recorded
pre-optimization crop source hash; it runs only the queue measurement and cannot
be presented as overall acceptance. Evidence:
`test/results/hardware-archive-20261012-011800-1687743/baseline-performance.json`
and `test/results/hardware-archive-20261012-012047-1693782/summary.json`.
The optimized run passed 8 hardware integration, 19 GPU crop quality and 62
original archive business tests without skips. Results vary with target sizes,
exposure settings, source transfers and other concurrent hardware work.

These are component integration tests with synthetic detections, not proof of
working user-model inference, live detection FPS or browser acceptance. User HBM
compilation, the production AI worker, SEI/browser overlay and complete installer
acceptance remain separate gates. Cold-start latency remains measurable even
though repeated crop context creation has been removed. Exposure and transfers
can still limit throughput; do not infer live FPS from warm queue measurements.
