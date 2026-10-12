# AINVR SSD quota and retention validation

Run from `/home/sunrise/ainvr` on the S100P:

```sh
.venv/bin/python test/non_ai/verify_ssd_quota.py
```

The verifier uses the original `ConfigStore`, `SegmentIndex`, `QuotaEnforcer`,
`StorageManager`, writer leases and playback leases. Each case has its own
configuration, index and root under `/mnt/ainvr-ssd/migration-tests/quota-*`.
It never changes production configuration or opens production recordings for
writing. At least 5 GiB free is required. Each case reserves at most 1.8 GiB of
real SSD blocks, then releases its exact fixture files. Small indexes and configs
remain for inspection; results are saved under `test/results/ssd-quota-*.json`.

These are allocated byte fixtures, not playable video. Fixture timestamps are
synthetic. This verifies deletion, indexing and quota policy; it does not prove
codec throughput, NAS behavior, physical disk-full recovery or long-term aging.

Eight cases cover LRU eviction to 95% of the cap, minimum retention, stop policy
and cap-raise recovery, active writers, playback leases, incomplete segments,
segments younger than one minute, and exclusion of another storage partition.
The last case uses an `smb` index label on an isolated local fixture; it is not an
actual SMB mount test.

## Observed defect and repair

Before the repair, two 600 MiB retained files exceeded the configured 1 GiB cap,
but overwrite policy left `quota_stopped=False`. Recent protected files had the
same behavior. The existing retention unit test used two 500 MiB files, which
did not exceed 1 GiB and therefore never reached the retention branch.

The original enforcer now pauses recording if usage remains above the cap after
safe eviction. Retention, writer/read leases, incomplete/recent files, bounded
candidate batches and deletion failures continue to protect files and indexes.
The volume remains healthy. Subsequent quota cycles still attempt cleanup and
resume recording when usage falls within the cap or the cap is raised. Quota
diagnostics are cleared on recovery without clearing storage error messages.

This is a periodic quota check, not a byte-by-byte reservation system. Existing
writers may finish their current segment after the cap is crossed; the repair
prevents continued unbounded recording when safe deletion cannot reclaim space.

Before evidence: `test/results/ssd-quota-20261012-045517-741828.json`.
After evidence: `test/results/ssd-quota-20261012-045836-802388.json`.
Both retention and recent-file cases now verify pause and later resumption.
The 26 focused tests passed in `test/results/quota-guard-regression.log`.

After loading the repair into the production recorder, a newly completed real
H.264 segment at 3840x1920 contained 2,000 video packets over 66.633 seconds,
approximately 30 FPS, with a maximum DTS step of 34 ms and no nonpositive steps.
Evidence: `test/results/recording-continuity-20261012-050140.json`.
This is one finite segment, not a soak or a production disk-full experiment.
The initial wall-clock selection timed out without finding a file:
`test/results/recording-continuity-20261012-050124.json`. Its cutoff excluded
the first new file because the filename's media time preceded service restart
by about four seconds. The final check used the exact new segment basename;
frame count, duration and DTS thresholds were not relaxed.

The source change is limited to `recording-service/src/recorder/quota.py` and its
quota tests. TecheAI is unchanged. Original source and tests are backed up at
`/mnt/ainvr-ssd/migration-backups/quota-guard-20261012-045813`.

## Rollback

Restore `recording-service/src/recorder/quota.py` from that backup and restart
`ainvr-recorder.service` after confirming no concurrent source edits. Restoring
the test file is optional for runtime rollback. Do not restore or remove any
production recordings or configuration. A service restart ends the current
recording segment; check a newly completed segment afterward.
