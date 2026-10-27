# PTZ software delivery — 2026-10-27

## Current release

The PTZ software is deployed on S100P. Latest candidate: `out/ptz-release-20261027-r8`.
Deployment completed at 21:23 Asia/Shanghai. PostgreSQL migration 016 was already
applied with r4. The formal behavior and remaining interoperability limits are in
[PTZ-CONTROL-CONTRACT.md](PTZ-CONTROL-CONTRACT.md).

Supported scope: ONVIF and GB 2016/2022 direction, stop, zoom, speed and native
preset operations; source-bound control ownership; durable view protection and
analytics reset; desktop/touch/keyboard controls; persistent protection notices.

## Latest corrections and verification

- ONVIF fixed duration parsing supports day/hour/minute/fractional seconds and
  zero minimum; invalid ranges cannot silently enable unsafe continuous motion.
- Preset operation releases control after repeated explicit idle feedback;
  unsupported/failed feedback retains the bounded stop policy.
- Known duplicate ONVIF device identifiers refuse movement before guard changes;
  automatic alias consolidation is not implemented. Reuse one device record.
- Legacy console/ONVIF mutation entrypoints retired; coordinated SSD publisher is
  the production update entry. Standalone GB backup/rollback uses the same SSD
  root and three-backup retention. Its read-only rollback preflight passed.
- ONVIF Go race tests passed. Backend PTZ regression: 37 passed. Frontend PTZ,
  monitoring and protection regression: 20 passed. Deployment/rollback Python:
  29 passed (15 current publisher/policy, 10 GB, 4 artifact/retired entrypoints).
- Frontend and backend type checks/build passed; ARM64 ONVIF/GB and S100P BPU AI
  built; C++ analytics-reset test passed during candidate preparation.

The prior r4 full baseline recorded frontend 1271 passed, backend 481 passed and
64 environment-dependent skips, and independent ONVIF/BFF/PG integration 26 passed.
Those are baseline results, not claimed as a new full-suite run.

## Production checks and rollback

The release tool verified unchanged configuration fingerprints and unchanged SRS,
recorder, ingest and other watched media service identities. Updated services are
active. Browser service overview returned to 12/12 healthy after a transient backend
probe timeout; direct backend health and branding checks were 200 in 2–11 ms,
A later r6 observation captured a backend crash in Node's bundled Undici 7.29
HTTP parser (`assert(!this.paused)`). An isolated child process reproduced the
same failure. r7 locks Undici 8.12.3 and installs matching fetch/Response globals
before application startup; length, chunked and EOF-delimited slow-consumer cases
all pass. The backend full suite under this runtime passed 483 tests, with 68
explicit environment skips. This does not prove absence of all network failures.

Rollback transaction:
`/mnt/ainvr-ssd/ainvr-rollback/backend/20261027T132334Z-1793107414193432174/deployment.json`.
Deployment evidence is board-local under `test/results/ptz-20261027/`; it is not an
installation dependency and is intentionally not committed. Rollback uses the
verified SSD transaction and never removes historical/parameter data.

## Acceptance boundaries

Physical camera direction, stop distance, optical behavior and preset accuracy
remain user acceptance work. No 24-hour test is required for this delivery.
No full GB2022 certification is claimed: signaling-authentication, extended
storage/diagnostic scope and official-page audit limits remain documented in the
GB contract/audit. Unknown ONVIF address aliases are not automatically merged.
Fresh-board provisioning is not supplied by the coordinated update command.
No automatic Git commit or push was performed.

## Runtime prerequisite

Backend now requires Node >=22.19.0 (production remains pinned Node24). Install
locked backend dependencies using npm ci before building; undici 8.12.3 is a
production dependency, not a global package or an edit to the installed Node binary.
Upstream fix reference: https://github.com/nodejs/undici/pull/5474 .
Reproduction: `node test/ptz/http_backpressure.mjs`; `--builtin` intentionally
reproduces the old runtime failure in an isolated process, never the live service.

## r8 review corrections

Go formatting is clean. Protocol capability reasons are displayed in the panel.
Duplicate ONVIF identities normalize whitespace and optional hardware IDs. The
SQL passed isolated PostgreSQL verification. Selected backend PTZ cases: 32 passed
including persistence integration; frontend panel/control: 15 passed; Python
deployment/rollback: 33 passed. ONVIF Go and both console builds passed.

Backup names now use UTC; legacy local-Z names are ordered by their Unix
nanosecond suffix. Both publishers share one lock. Alarm rollback restores source
from SSD without depending on old eMMC directories. Retention marks incomplete
joint transactions explicitly. Shared validation moved to release_common.py;
legacy entrypoints retain only a fail-closed compatibility notice.

Removed four duplicate legacy console snapshots, 26 unreferenced alarm runtimes
and r1–r5 candidate packages. Each of six canonical service buckets has three
backups. Four alarm directories remain: active code and directories referenced by
existing service configuration or requiring separate ownership review. New managed
inactive PTZ runtimes are automatically pruned.

Production services are active without restart loops; configuration fingerprints
and watched media service identities were preserved. These are software checks,
not physical-camera acceptance or full GB2022 certification.
