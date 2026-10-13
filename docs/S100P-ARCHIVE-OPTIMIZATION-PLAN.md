# AINVR S100P archive optimization plan — 2026-10-13

## Non-negotiable acceptance

Keep two owned source frames per channel. Do not improve throughput by dropping admitted target screenshots, sampling targets, reducing image size/quality, changing thresholds or silently skipping enhancement. Preserve original/processed pairs, immutable source ownership, ObjectId/PTS, stop recovery and rolling retention. Inference stays BPU; image arithmetic stays dedicated hardware or GLES. CPU byte copies exist today and must not be described as CPU image algorithms or zero-copy.

## Verified findings and corrections

- Worker waits for archive capacity before dispatch; two retained source frames can stall new inference. Disabling screenshots also removes GPU, JPU and memory traffic, not only the admission wait. Mongo batches of about 5–9 ms with no slow/error batches do not currently indicate a database bottleneck; this is workload-dependent.
- Multiplying 8.2 targets by 22.4 ms then dividing by four workers is a rough service-demand estimate, not a hardware ceiling: timers include queue waits and shared-resource contention. BPU inference time divided by frame interval likewise illustrates idle supply, not an exact hardware-utilization formula.
- `ArchiveAdmissionSkips` compares the picked sequence with the newest sequence before waiting, while `PickNextFrame` selects the oldest surviving queued frame and drops entries older than 250 ms. This cannot accurately attribute all archive-related skips. Add actual admission-wait timing and queue-eviction reasons; do not relabel every overload skip as archive loss.
- Legacy SnapshotCropper cache limits are now preserved at 256 entries/64 MiB; only exact production workers use 64/32 MiB. This compatibility fix is retained independently of experiments.
- Before this optimization, the snapshot pipeline performed source NV12 upload/ROI RGBA readback, RGBA upload/ERP remap/readback, then RGBA upload/NV12 conversion/readback plus JPU input copy. Counting 'four round trips' is ambiguous; measure each direction in bytes instead. Per-thread source caches mean one frame can upload multiple times, but four uploads is not a guaranteed bound if frame tags alternate and evict the last cached source.
- ERP currently uses 1.5x supersampling followed by cubic resize, not area resize. Preserve quantization, rounding, edge handling, interpolation, color matrix/range and chroma behavior in fusion tests.
- JPU reuse already matches aligned dimensions and quality. Odd visible sizes can reuse an aligned single instance; the single-context restriction preserves prior SDK odd-size bitstream behavior. Do not add contexts or resize screenshots into buckets without independent pixel/bitstream validation. JPEG mean currently includes waiting/conversion/setup, not just hardware encoding.
- `yoloe_bpu` uses BpuChannelAdapter with IsPrompted=false and runtime prompt embeddings, so the old InferPromptedFrame throwing branch is not its execution path. The old branch must not be cited as evidence that deployed dynamic YOLOE is broken.
- Decoder currently copies each dequeued NV12 frame into an owned host vector. 3840x1920x1.5x30 is 331.8 MB/s of payload; standard 3840x2160 is 373.2 MB/s. 7680x3840x1.5x25 is 1.106 GB/s. Memory reads+writes are additional traffic. 'CPU copy is the number-one bottleneck' has not been established by profiling.
- 640x640 FP32 NCHW is 4,915,200 bytes; NV12 is 614,400 (8x smaller). Embedded NV12 conversion/normalization needs a newly compiled and validated HBM. Current YOLOE dynamic auxiliary inputs are not supported by the existing two-input NV12 contract. GPEN is a separate float-input contract.
- PYM/GDC Supports limits are validated wrapper boundaries, not proof of universal silicon maximums. In particular 3840x2160 is the conservative GDC wrapper scope. Do not claim GDC can first shrink an unsupported 8K input, or promise PYM tiling without seam/stride/chroma/scale validation.
- RunAsync currently creates a std::async task per inference, serialized by the model mutex. A dedicated inference executor is possible, but not the first suspected screenshot bottleneck. The optional legacy native_service CPU executable should be explicitly reference-only and distinctly named; production installer must continue selecting/verifying the BPU service.

## Experiment completed: crop-first waves rejected

Same binary, six alternating A/B runs, identical 4K RGBA/eight-target inputs, two source frames/four workers, real GLES/JPU/Mongo. Median targets/s without exposure: 216.962 original vs 205.083 crop-first (-5.48%). With exposure: 61.530 vs 59.900 (-2.65%). Budget unit test and all selected archive checks passed; services restored. This fixture excludes decoding and detector inference and cannot prove a live BPU FPS improvement. Crop-first scheduling was not deployed and was removed from product source. Reproducible patch/script/evidence remain under `test/experiments/crop-first-20261013/` and `test/results/crop-stage-ab-20261013-134002/`.

## Final implementation order

### P0 — Measure the shared bottlenecks before changing them

Expose process-wide JPEG counters as process-wide (not per-channel): successful encodes, creates/reuses/failures, conversion admission wait, conversion execution, wait between conversion and encoder, encoder creation and JPU Encode execution. Time input byte copy separately. Use interval deltas and distributions; do not divide lifetime sums by unrelated counters. Add actual source-frame lease duration, archive admission-wait time, each upload/readback byte counter and source-upload cache hit/miss. Correct misleading no-copy comments and annotate heuristic skip classification. Instrumentation itself has overhead and needs bounded summaries and timing tests; it is not literally zero risk.

### P1 — Reduce duplicated traffic without reducing useful parallelism

Compare current per-target scheduling against small same-frame groups and frame affinity. Strictly pinning each frame to one worker with only two frames can leave half the four-worker pool idle; therefore it is a candidate, not a foregone improvement. Group nearby targets only when measured union bytes justify it. Test actual NV12-backed owned_download providers, not only resident RGBA fixtures. Preserve bounded small-image ownership and report tail latency, not only averages. If encoder creation dominates, first reduce safe dimension churn through scheduling/reuse of exact aligned keys. Output-size buckets and multiple odd-size encoders require a separate quality gate and are not part of the initial optimization.

### P2 — Fuse GPU stages with unchanged pixel semantics

Within a verified context/resource ownership model, sample source NV12, reconstruct RGBA exactly as the current path, perform ERP supersampling/cubic resize and produce JPU NV12 without intermediate CPU readback/re-upload. Fusion means keeping intermediates on GPU; it need not be one shader dispatch. Retain intermediate 8-bit rounding and color/chroma behavior. Handle brightness/GPEN and original/processed variants explicitly; do not silently bypass them. First validate ordinary+ERP, seams/poles, odd/tiny sizes, resolution/config changes, failures and simultaneous channels. Quantify final readback and JPU input copy; do not call it end-to-end zero-copy.

### P3 — Decoder ownership and optional NV12 detector models

Avoid copying decoded display frames that are guaranteed not to be admitted, while still consuming decoder output, updating POC/token mapping and returning buffers safely. Follow source/SEI epochs and preserve selected frames through archive completion. DMA-BUF/shared-buffer integration requires actual VPU/PYM/GLES/BPU import support, format/stride/cache sync/fences and bounded leases; do not assume all engines import the same allocation. Separately compile COCO/face NV12-input candidates and compare full image-to-detection outputs with approved HBM; preserve accepted models until quality and performance pass. YOLOE requires an extended image+prompt contract and separate validation. Fixed inference thread and reference-target cleanup are lower-risk maintenance work but must not be advertised as a solution to archive saturation.

## Gates and current status

For each candidate: fixed-input isolated A/B (alternating repeats), unchanged pixel/quality gates, archive ledger completion, no deadlock on stop/disable/error, bounded RSS/GPU memory, then live same-config observation including source FPS, admitted targets/frame, throughput, P50/P95/P99, frame lease duration, encoder create/reuse and BPU utilization. Report maintenance recording gaps separately. Keep a tested rollback. No promise of 30 FPS or full BPU occupancy is made before measurement.

Implementation update: process-wide JPEG stage/caching counters and channel admission-wait timing are implemented. Shared NV12 crop execution and the first GPU fusion boundary (NV12 -> crop/ERP without host RGBA intermediate) are implemented and tested; exact ownership and two source frames are preserved. The shared executor keeps four archive workers for downstream overlap; it does not pin each full frame to one archive worker. See S100P-NV12-SHARED-CROP.md and the actual deployment/evidence hashes for final status. Full GPU-to-JPU fusion, cross-engine DMA-BUF, new NV12 HBM models, and full lease/upload byte tracing remain separate work, not implied complete.

Historical crop-first rollback verification (superseded by the later NV12/shared-crop deployment): restored source builds successfully; 22 GPU crop-quality tests passed (`test/results/crop-stage-restored-quality-20261013.log`), `git diff --check` passed, and AI/recorder services are active. At that rollback checkpoint, the deployed binary was `ec9df2d20ab90ac869edb5903e2511fe1a1d2bc9286ed83dcae7d09adff7951d`; no rejected scheduler was deployed.
