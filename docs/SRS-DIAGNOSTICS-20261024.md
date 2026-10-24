# SRS incident diagnostics — 2026-10-24

## Scope

This release improves investigation, not OBS's encoder, Wi-Fi connection or
stuck streaming state. It does not establish that AINVR cannot cause disconnects.
No media services or channel configurations are changed.

- Independent observer writes JSONL to `/var/log/ainvr-srs-observer/`.
  Rotation is 8 MiB per file, seven backups, approximately 64 MiB total.
  Retention is volume-based, not a guaranteed number of days.
- Publisher transitions and API availability changes are recorded immediately
  on the next sample (approximately one second); detailed snapshots remain
  throttled to one per 15 seconds. Transitions between samples can be missed.
- Independent Docker log reader retains only warning/error summaries: SRS UTC
  timestamp, session, numeric error codes and a small vocabulary of signals.
  It does not copy raw messages, URLs, credentials or stream keys from logs.
  Existing stream snapshots still contain configured stream names as before.
- Error queue is bounded at 256; duplicates within a sample are aggregated.
  This is best-effort diagnostic evidence, not an exhaustive error counter.
  Reader reconnects may replay the last five seconds. Docker's original logs
  remain available for full stacks until rotation. Their INFO level is unchanged
  to avoid changing live SRS behavior; polling noise is excluded from the archive.
- AI card no longer attributes every non-running processor to absent source
  video. Actual errors remain visible for input, decoding and inference failures.

## Verification and deployment

18 observer tests, 28 frontend tests, TypeScript build and Vite build passed.
Existing bundle-size/dynamic-import build warnings remain.

Run `python3 deploy-package/deploy-srs-diagnostics.py` for the observer. It backs
up executable/unit, restarts only the observer, checks archive creation and media
PIDs, and restores the previous observer on failed checks.

This board's observer backup:
`/home/sunrise/ainvr/deploy/s100p/rollback-srs-observer-20261024-100540`.
To roll back, restore its `srs-observer.py` to `/opt/ainvr/srs-observer.py` and
`ainvr-srs-observer.service` to `/etc/systemd/system/`, run daemon-reload and
restart only `ainvr-srs-observer`. Diagnostic files need not be deleted.

Frontend deployed using existing atomic frontend deployment helper. Backup:
`/home/sunrise/ainvr/deploy/s100p/rollback-rectangle-20261024-100600/frontend`.
Served JS: `index-BqVAlcxn.js`. The existing overlay changes were preserved.

No induced production disconnect or OBS restart was performed. A future real
failure still needs correlation with OBS/Windows logs; absence of a recorded
error is not proof of absence of a server fault. No commit or push performed.
