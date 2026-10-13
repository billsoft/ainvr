# AINVR S100P crop resource reuse (2026-10-13)

> Historical first-stage experiment (12:46–13:08), superseded by [NV12 shared crop](S100P-NV12-SHARED-CROP.md). Descriptions and deployment hashes below apply to this earlier stage.

## Design and quality boundary

Production previously constructed a SnapshotCropper for each target. EGL contexts and shaders were already thread-local, but per-backend textures, work buffers and ERP map LRU were discarded after every target. Archive pool workers now retain a thread-local cropper. No cropper is concurrently shared across threads or channels; every call uploads its current source ROI, so image pixels are never reused across frames.

The original quantized map key intentionally reuses the first view within a bin. Persisting that cache across moving detections could change the pixels compared to the previous fresh-per-target production path. The new opt-in exact view key includes source width/height, exact center/FOV and output width/height. Production uses this mode; legacy backend callers keep the quantized contract. Source resolution and output shape are part of the key. Exceptions discard device state through the existing retry scope.

Four archive workers retain at most 32 MiB of ERP maps each, with 64 entries per worker. Working texture/readback/host buffers are additional bounded storage, not included in the map quota. Model weights, thresholds, output sizes and archive retention are unchanged. The GPU path remains GLES; inference remains BPU and JPEG remains JPU.

## Shared upload experiment

The hardware quality suite now compares an eight-target shared ROI upload with separate uploads on the same synthetic 3840x1920 RGBA frame. Outputs must match fresh-target pixels exactly. This is a synchronous GPU microbenchmark, not the throughput of the four-thread live pipeline.

| Layout | Separate ms/frame | Shared ms/frame | Separate bytes/frame | Shared bytes/frame |
| --- | ---: | ---: | ---: | ---: |
| Clustered | 15.145 | 13.598 | 1,683,456 | 555,672 |
| Scattered | 15.369 | 14.838 | 1,683,456 | 3,432,672 |

Shared upload helps a clustered batch but doubles transferred bytes for scattered targets in this fixture. Therefore unconditional full-frame/bounding-union upload is not deployed. A later batching policy must compare union bytes with separate ROI bytes, preserve queue budgets and failure isolation, and demonstrate gain over the concurrent live pipeline. Cross-thread textures additionally require verified EGL sharing/fences and ownership, not raw texture IDs passed between workers.

## Validation

`test/results/hardware-archive-20261013-124605-2040274/summary.json`: 21 GPU crop quality tests, 11 real JPU/Mongo archive tests and 62 original archive regressions passed without skips. New tests verify exact output across sub-pixel view movement and repeat-view cache hits, plus shared-upload pixel equivalence. Synthetic archive throughput excludes VPU and user model inference; it must not be presented as live FPS.

Deployment decisions and live measurements are appended after comparison. Baseline binary is preserved at `/mnt/ainvr-ssd/migration-backups/ai-before-crop-reuse-20261013`. Test maintenance restores previously active AI and recorder services in finally; maintenance times are recorded in `test/results/crop-reuse-maintenance-20261013.json`.

## Capacity reuse and final production decision

Work SSBOs now grow only when requested bytes exceed retained capacity; initialized bounds are updated with glBufferSubData. Map SSBOs always allocate storage, because deleted LRU buffer names can be recycled: work-capacity bookkeeping must never be applied to map IDs. Uploads with unchanged texture dimensions use glTexSubImage2D, while a size change redefines storage. Pixel readback remains synchronous and no zero-copy claim is made.

Final hardware validation: `test/results/hardware-archive-20261013-125854-2376050/summary.json`, 22 GPU tests + 11 hardware archive + 62 business regressions passed without skips. The additional test alternates frame content, output sizes and ERP/ordinary modes and compares every result exactly with a fresh backend. Models and JPEG settings are unchanged.

| Production sample | Inference FPS | Targets saved/s | BPU mean | Peak RSS KiB | Mean admission-to-commit ms | Recent P95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline, 120.7 s | 17.7193 | 146.2937 | 53.68% | 1,664,064 | 122.00 | 162.08 |
| Persistent backend, 181.0 s | 18.3993 | 152.8451 | 51.70% | 1,767,232 | 113.18 | 190.13 |
| Plus capacity reuse, 181.1 s | 18.5610 | 151.5754 | 57.32% | 1,830,144 | 111.93 | 199.39 |

All three samples used configuration hash `f14610772e4bf1d937ad803666f7dc4ddbddfea0c66e417b7b500681445203ce` with ERP enabled. This is a changing live stream, not identical replayed frames or a statistically established universal gain. The final observation improved FPS by about 4.8% over baseline, with about 162 MiB higher peak process RSS. Recent P95 is a rolling 256-target value and was worse, so do not claim across-the-board latency improvement or infer a reliable gain from the small difference between the two candidates.

Final deployment SHA-256: `ec9df2d20ab90ac869edb5903e2511fe1a1d2bc9286ed83dcae7d09adff7951d`. Final sample: accepted 27,478 targets = committed 27,456 + in-flight 22; no quarantine, capture failure, archive drop or write failure. SEI late, AU shedding, buffer drops and reconnects were zero. Ten publisher queue-full events applied backpressure without shedding. This bounded observation does not erase historical cold-start misses or prove indefinite stability.

Post-deployment audit found six completed recording segments with correct files/sizes, no gaps above 500 ms and SQLite quick-check OK. No structured service warnings, container OOM or unexpected restarts were found in the checked window. Planned test interruptions are preserved in maintenance JSON files.

Evidence files: `test/results/crop-reuse-baseline-live-20261013.json`, `crop-reuse-candidate-live-20261013.json`, `crop-capacity-candidate-live-20261013.json`, `crop-capacity-health-20261013.json`, `crop-capacity-install-20261013.log`, and `crop-capacity-maintenance-20261013.json`.

This stage deployed the candidate listed above; it is no longer the current deployment. To roll back, use `deploy-package/install-ai-s100p.py --binary /mnt/ainvr-ssd/migration-backups/ai-before-crop-reuse-20261013 --start`; this baseline was preserved before edits. No automatic Git commit was made.

At that stage, remaining work was conditional spatial grouping should be tested against the parallel baseline before deployment. A clustered synchronous microbenchmark alone does not prove batching helps live throughput. BPU is still waiting on a pipeline with GPU readback, copies and JPU encoding; this work does not establish a hardware saturation limit.
