# 历史实现记录（已归档，不代表当前版本）

原 alarm-service/README.md 的阶段性记录。当前入口见 [Alarm Service](../../alarm-service/README.md)。

# AINVR Alarm Service

Independent alarm business service. Does not execute detectors, trackers, or create SRS streams.

## Current deployment and acceptance — 2026-10-19

The independent service and both console components are deployed on S100P. Native AI observation output, exact-frame image evidence and SSD retention are enabled. Final alarm integration suite: **87 passed, 0 failed, 0 skipped**, including real Mongo, generated C++ journals and forced process recovery. Frontend full suite: **976 passed**; backend **335 passed**, with the region/monitor PostgreSQL integration cases separately enabled and passed against a disposable instance.

Current fixes include stable source-generation geometry, focused original/AI saved-zone overlays, region archive and frozen-rule warnings, observation-based contact/approach rearm, timezone/DST-aware statistics, explicit label/region/rule filters and directional grouping, HTTP-compatible acknowledgement IDs, and activity closure when monitors are disabled. Human acknowledgement does not affect immutable behavior facts. VLM and notifications are disabled interfaces only.

See [delivery handoff](../docs/ALARM-DELIVERY-HANDOFF-20261019.md) for the authoritative deployed artifacts, scripts, tests, operator workflow and limits. Earlier implementation notes below are retained as historical records, not current deployment assertions.

## Historical implementation notes — superseded

### Latest status (supersedes the early prototype record below)

Development source is not deployed or end-to-end accepted. The latest full alarm suite has **74 passed / 0 failed / 0 skipped**, including native C++ observation journal files consumed into isolated real Mongo without truncating integer PTS/frame identities. AI worker syntax check, backend source/snapshot subset (7 tests), PG monitor binding integration, dashboard component tests (2), and frontend/backend type checks passed.

Implemented since the prototype: region traversal/directions, short-loss retention, activity alarm merging with independent facts and preserved handling, independent rearm time, PG source-bound monitor snapshots, HTTP/BFF statistics/history, wizard parameters, compact alarm list and modal/batch confirmation, and dashboard delivery card. Native SSD journal and service-side ordered pump use `AINVR_OBSERVATION_SPOOL_ROOT` on both processes; file transport is disabled when unset. See `../docs/ALARM-OBSERVATION-TRANSPORT.md`.

**Resolved shared-source incident (2026-10-19):** the worker overwrite described earlier was real. Its missing SEI-coasting hunk was recovered from the other local development transcript. Applying that exact hunk to the recorded original base reproduces SHA256 `308bfd34d1303e8ff5623fe90dfa41d2b187a8ed198433c8b4028567baf5da36` byte for byte. It has now been restored to the current worker while retaining the observation journal and subsequent hidden-observation handling. Evidence: `../test/results/alarm-worker-recovery-20261019.json`. This resolves source reconciliation only; full native build, original tracking regression and actual deployment remain separate gates.

Additional source progress: saved-zone overlays in focused live preview account for letterboxing and reject mismatched source geometry; panorama projection is explicitly unavailable. Related overlay/workspace/monitor/player tests: 41 passed. Offline pause/archive now preserves source/geometry snapshots and version history without reading the live label catalog; frontend 8 tests and backend 3 tests (including real PG) plus type checks passed. No production deployment or real browser acceptance yet.

Exact-frame evidence lookup/retrieval is now implemented in the AI archive interface and authenticated BFF; behavior detail and per-stage activity screenshots are connected in source. Native real-Mongo identity probe, affected C++ syntax checks, BFF 4 tests, frontend 10 tests and type checks passed. Independent evidence retention is now implemented as an opt-in alarm-service queue/SSD vault; default/unqueued historical crops remain subject to AI-history retention. See ../docs/ALARM-EVIDENCE-INTERFACE.md and ../docs/ALARM-EVIDENCE-RETENTION.md.

Still required: full build and real camera deployment with rollback/recording checks; actual evidence-policy application and hardware integration; historical direction/version query filters; process/log integration and stopped-input lifecycle/coverage; real browser keyboard/mouse/iPad acceptance. The original Git-fsck attempt found no recoverable blob; subsequent transcript reconstruction recovered and verified the exact missing worker hunk. **VLM/notifications remain interfaces only; the early prototype execution roadmap below does not expand this phase.**

Per-behavior dwell overrides and image-direction sectors now persist through PG snapshots; selected reference fields are ANDed, unknown directions do not match, and candidate filtering precedes fact materialization. Wizard summaries and activity detail show configured/observed directions. See ../docs/ALARM-DIRECTION-POLICY.md. Related frontend 11 tests and backend including PG 6 tests/type checks passed.

Weekly schedules now persist through PG and execution snapshots, with explicit IANA timezone, overnight/week-wrap windows, overlap rejection, capture-time gating and activity/evidence resets across inactive periods. The wizard edits and summarizes the policy. Shared contract fixtures, real Mongo recovery and PG persistence checks pass; related frontend 10 and backend 7 tests plus type checks passed. See ../docs/ALARM-SCHEDULE-POLICY.md. Production application/browser acceptance remains pending.

Evidence-vault progress: central retention/capacity settings, exact-frame background acquisition, private SSD files with hashes/fsync and token-fenced publication, quota/expiry cleanup, SIGKILL recovery and scoped BFF source authentication are implemented. Per-stage screenshots and the dashboard distinguish independently stored, pending, expired and unavailable evidence. Full alarm suite 74 passed / 0 skipped; backend 15 related tests, frontend 18 related tests and both type checks passed. No production configuration or services were changed.

### Early prototype record (historical, not the current implementation inventory)

Development only; not deployed and not end-to-end accepted. Production AI/recording services have not been changed by this implementation.

Implemented modules:
- `src/domain.mjs`: validation, event identity, independent review/handling states.
- `src/geometry.mjs`, `src/engine.mjs`: pure checkpointable appearance/approach/contact/entry/finite-line evaluation from observed tracks.
- `src/repository.mjs`: Mongo event deduplication, handling CAS, atomic embedded confirmation audit, cursor pagination and rule version history.
- `src/http.mjs`: separately authenticated Fastify application, list/detail/rules/ack/batch/dry-run routes; producer input has its own credential and cannot access operator APIs.
- `src/ingestion.mjs`: durable prepare/materialize/checkpoint processing with fenced leases, immutable crash recovery and replay deduplication.
- `src/runtime.mjs`, `src/main.mjs`: independent listening process, private file configuration, database write health probes, graceful shutdown and authenticated instance/config/status reporting. No production deployment yet.

Verification on S100P: 23 tests passed, 0 failed/0 skipped, including isolated Mongo 7 on localhost port 27028. Tests include injected failures around durable processing and a separate Node service process forcibly terminated with SIGKILL, restarted, and checked for persisted rules and replay deduplication. Production input/evidence and browser acceptance are still pending.

Start with `node src/main.mjs /absolute/path/to/private-config.json`. The JSON is schema `1.0` and requires `version` (positive integer), `operation_id`, explicit loopback `host` and available `port`, `mongo_uri`, dedicated `database`, distinct `api_token` and `producer_token` (at least 32 characters). Configuration mode must be 0600 on Linux. Real credentials must be provisioned through the deployment/config integration, never committed. No default production port is assumed. `/livez` is public; `/readyz` and `/v1/status` require operator authentication. Input uses `/v1/observations` with the producer credential. Unknown input lag is null until the producer watermark is connected; counters reset under a new `counter_epoch` after restart.

Run `npm test`. The real Mongo test is explicitly skipped unless `AINVR_ALARM_TEST_MONGO=1`; it only connects to fixed isolated test port 27028 and a generated `ainvr_alarm_test_*` database. Never replace that address with production credentials. The dependency lockfile is authoritative.

## Required remaining work (keep full objective)

1. Harden domain schemas; complete weekly schedules, debounce/rearm semantics and all acceptance fixtures. Current schedule only supports explicit `always`; unsupported schedules reject rather than silently run.
2. Durable ordered input from AI result/evidence interface: session/seq/gap, bounded SSD producer outbox, consumer lease/checkpoint, crash/replay tests. No latest-poll substitution.
3. Evidence pinning and exact source-frame association; missing/expired states and authorized retrieval.
4. API authorization scope through BFF, unknown-field checks, mutation idempotency (including rules/batches), false-positive dispositions, bounded audit projection/retention. Embedded audit currently stops new writes at capacity rather than silently discarding history.
5. Optional review scheduler/executor, attempts/leases/timeouts/manual fallback, model compatibility/quality gate. Review and notifications currently explicitly unavailable. No CPU model fallback.
6. Connect independent runtime to published central configuration and service acknowledgment, safe deployment/rollback. Runtime file/version/status support exists; central apply is not yet wired.
7. BFF named proxy implemented at `srs-web-console/backend/src/routes/alarmProxy.ts` with three passing proxy tests and backend typecheck; it is not registered in the production application until applied configuration and principal callbacks are connected. Remaining: independent alarm center frontend, single-row list, modal individual/bulk confirmation, rules/drawing, review UI, evidence/log detail and error recovery.
8. Central config page, database config group, service registry/adapter/restart whitelist and secret policy integration.
9. Dashboard process/business metrics/log source, freshness and missing-value semantics.
10. End-to-end real source tests, restart/fault tests, built-in browser iPad/keyboard/mouse acceptance; preserve original stream bindings and recording.

Design references: `../docs/ALARM-SERVICE-BACKEND-DESIGN-20261019.md` and `../docs/ALARM-CENTER-UX-DESIGN-20261019.md`. Passing current tests proves only implemented layers, not service completion.
