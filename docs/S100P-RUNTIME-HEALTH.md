# S100P runtime health and commit acceptance

AINVR — 2026-10-13. Worktree changes are not committed automatically.

## Operational fixes

- Recorder state (`data/recorder`, including SQLite index, WAL and configuration) is on mounted SSD at `/mnt/ainvr-ssd/databases/recorder`. The stable project path is a symlink. The previous directory is retained under `data/recorder.before-ssd-storage-health-*`. Migration stops the recorder, checks copied file hashes and SQLite integrity, then restores the service. Its systemd drop-in requires the SSD mount and checks `mountpoint` before startup. It must never silently write to the underlying eMMC mount directory.
- `deploy-package/harden-storage-s100p.py` is included by `install-s100p.sh`. It requires the SSD and sufficient free space, rejects unrelated managed-file collisions, and does not format disks or delete business records.
- Journal storage is bounded to 256 MiB (32 MiB files, 2 GiB free-space reserve). Rsyslog excludes only low-severity JPU instance lifecycle chatter; warning/error messages remain enabled. The vendor kernel still emits these messages, so this is a persistence safeguard, not a claim that the driver was patched.
- `--archive-existing-logs` first preserves the named text logs and journal files on SSD, then releases their eMMC space. Existing evidence is at `/mnt/ainvr-ssd/migration-backups/storage-health-20261013-114119-988935`. System disk usage fell from 87% to 71%.
- JPU contexts can now reuse identical aligned dimensions and quality while updating the JPEG visible-size header per image, preserving the MCU grid. Odd visible dimensions still retain the validated single-context restriction. Cache size remains bounded; no CPU image fallback was introduced.
- Completed asynchronous inference can publish before waiting to admit another archived frame. The native standard-detector output buffer begins with a 3 s cold-start reserve, waits for initial buffering, then adapts to measured P99 lag with a 750 ms floor and the same 3 s ceiling. Defaults for other controller users are unchanged. This deliberately trades some viewing latency for fewer missed SEI deadlines; it cannot guarantee every inference meets a deadline under arbitrary overload.

## Observability and UI semantics

`archive_stats.delivery.admission_to_commit` measures **first archive admission to Mongo acknowledgement**, on a monotonic clock. It excludes capture/preprocessing before admission. Mean/max cover the store lifetime; P95 covers the most recent 256 committed targets. On pending-file replay after restart, timing starts when the new store admits the replay, not the original process timestamp. It is not a power-loss durability guarantee.

The recognition-history page shows these metrics and explicitly explains that one inferred frame can produce multiple target records. The configured 10,000-record limit is maintained by batch trimming, so a small transient overshoot is expected. At roughly 160 targets/s, this policy retains only about one minute. This repair preserves the user's retention setting. GPEN badges appear only on face-model channels; a stored enhancement setting on a COCO channel does not imply GPEN ran.

## Validation and operational use

```sh
# Read-only health check; use a fresh evidence filename and a post-maintenance time.
python3 test/ai_port/audit_runtime_health.py \
  --since 2026-10-13T12:00:00 \
  --output test/results/runtime-health-unique.json

# Read-only bounded throughput/ledger observation.
python3 test/ai_port/measure_archive_pipeline.py \
  --channel-id 2baec0a3-9941-47dc-b1bd-d3d284488097 \
  --seconds 300 --output test/results/archive-health-unique.json
```

Do not interpret intentional maintenance gaps as unexplained recording loss. Hardware acceptance uses dedicated test collections and restores the previously active services in `finally`; production Mongo is not stopped for outage injection. Preserve failed trial logs as well as successful reruns.

Initial validation: 299 recorder tests; 810 frontend tests; 28 recognition-history tests after UI changes; 19 GPU crop-quality, 11 hardware-archive and 62 original archive tests; 20 worker tests. A publisher test was corrected to wait for **both** SEI injection and actual video publication: injection into a held buffer no longer implies that publication has already happened. The first run of that assertion failed and was retained. A bare reference-test invocation without its Mongo environment contains skips and is not counted as full archive acceptance.

## ERP route and remaining performance work

The active channel uses `projection_mode=erp_equirect`. This applies ERP-to-perspective target crops during snapshot archiving, not a full-stream fisheye-to-ERP conversion before detection. The production call chain is `SnapshotStore::MaterializeCrop` → `SnapshotCropper::Crop` → `BboxToErpView` → `GlesCropBackend::GetMap/Remap`. Original crop/projection planning semantics are retained, with S100P GLES pixel execution. GDC is not selected by this path. Detection remains BPU; JPEG uses JPU.

A 51% one-hour BPU mean is not a saturation proof: it includes maintenance and changes in workload, and BPU can wait for upstream/downstream stages. With ERP enabled, candidate2 measured 17.27 inference FPS, 142.59 target commits/s and 51.23% BPU over five minutes. Crop preparation averaged 14.43 ms/target; Mongo's last batch took 6.93 ms with zero slow batches/errors. These are different stages and cannot be summed as serial per-frame costs in this parallel pipeline. The earlier roughly 20 FPS result used ordinary crops, so it is not an apples-to-apples regression comparison.

Potential next experiments are reuse of crop-backend/map resources across targets and batching uploads from one frame, with bounded ownership/queues and unchanged pixel-quality gates. EGL contexts already have a thread-local cache; do not diagnose per-target EGL initialization without profiling. Increasing archive threads from four to six previously reduced throughput, so additional concurrency is not automatically a speedup.

## Final observed result (2026-10-13 12:22)

Installed binary SHA-256: `493cfdce4848c87ee24c3ffaa68918966df4f030382ea11374d41172f2777557`. The final cold-start controller passed 34 buffer and 20 worker tests; recognition-history acceptance passed 28 tests. The production configuration and model weights were preserved.

Five-minute ERP-enabled observation: 17.5518 inference FPS, 144.2325 committed targets/s, BPU mean 51.6721%, peak RSS 1,606,016 KiB. Archive delivery remained healthy, without dropped/quarantined targets or Mongo write errors. The post-maintenance audit found four completed recording segments with matching files/sizes, SQLite quick-check OK, no gaps exceeding 500 ms, and no recorder drop events. Native long-running services and Mongo/PG/SRS were active without unexpected restarts or OOM. The internal-network unit is a timer-driven oneshot and is normally inactive between runs.

One SEI deadline miss occurred within the first five seconds; the counter stayed at one for the remainder. Video-buffer drops and reconnects were zero. Ten publisher queue-full events were handled by backpressure with zero AU shedding. This is **not** a zero-cold-start-loss acceptance, nor proof of all historical recordings being intact. A future strict guarantee needs a readiness-aware startup/latency policy; indefinitely increasing buffering is not an acceptable substitute.

Readiness: the scoped health/storage/UI fixes have passing regression gates and are deployed; no automatic commit was made. Do not describe the entire system as fully optimized or all edge cases solved. Preserve the remaining cold-start SEI limitation and measured performance in any commit description.

Evidence: `test/results/health-fix-cold-live-20261013.json`, `health-fix-cold-audit-20261013.json`, `health-fix-cold-install-20261013.log`, `health-fix-worker-cold-20261013.log`, `health-fix-buffer-tests-20261013.log`, and `health-fix-history-acceptance-20261013.log`. Browser checks showed rendered ERP target thumbnails, accurate archive latency/retention text, no GPEN badge for the COCO channel, and both original/AI streams playing with detection boxes.
