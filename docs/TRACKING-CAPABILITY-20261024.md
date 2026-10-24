# Tracking capability and detector-only alarms — 2026-10-24

## Released behavior

- Planned FPS below 3 cannot enable tracking; 0 means follow source, subject to runtime eligibility. LocateAnything low-frequency preset cannot enable tracking.
- Frontend confirmation changes the draft only. Native write validation also rejects unsupported tracking settings. Historical configuration remains readable.
- Runtime eligibility observes both source timestamp and monotonic processing intervals. The slower interval governs readiness. Recent sample window is bounded to 12, needs at least 8 observations; 2.95 FPS tolerates scheduling jitter around nominal 3. Eight adequate windows recover, three inadequate windows suspend; gaps over one second reset eligibility immediately.
- Eligibility transitions reset tracker session identity. Predicted or hidden low-confidence boxes cannot prove detector-only alarms or crossing facts.
- Detection-only output has its own explicit observation mode and frame-local detection identities. The engine cannot mistake these for persistent target identities.
- Without tracking, zero-dwell appearance supports whole-frame detection or zone detection, and zero-dwell approach supports outside-band detection. Existing cross-boundary intrusion, traversal, counters, dwell, directional restrictions and ERP rules do not run on this mode.
- Zone detection reuses appearance bound to a zone; existing intrusion rules are never converted. No new geometry implementation is introduced.
- Detector-only alarms describe scene presence, not per-person continuity. Same rule/version/schedule/label stays latched while matching detections persist. Observed absence lasting rearm_ms re-arms it. Multiple detections at initial trigger produce separate alarm/review identities; later occupants while the scene remains occupied are suppressed, not merged into another person's review.
- Single-frame evidence is explicitly tagged 当帧检出. Original frame identity is preserved. No entry/exit frames or dwell are fabricated.
- Existing bindings and historical data remain. Actual counting coverage stops during detection-only intervals.

## Verification

- Alarm suite: 230 passed, 0 failed, 0 skipped. Includes isolated real Mongo, native journal fixtures, detection-only transport, independent decisions and replay idempotence.
- Console frontend related suite: 109 passed; typecheck and production build passed.
- Backend source/assignment suite: 12 passed; typecheck and production build passed.
- Native cadence checks and frame/API/SEI regression passed; S100P control service compiled.
- Browser: 10 -> 2 FPS prompts; confirmation changes only draft; tracking becomes unchecked and disabled; discard keeps stored 10 FPS.
- Initial database rerun failed because the reused test container exhausted file descriptors. Final run used a separate loopback-only Mongo with raised nofile limit and serial tests. Temporary test container was stopped after verification.
- No live inference was available at acceptance: 大门 remained manually stopped; 后门 waited for original video. Runtime recovery on the actual camera remains to be observed. 3 FPS is an operational floor, not an accuracy guarantee.

## Release and rollback

Only main working tree changed; no commit or push. Service programs/config backups:

- Alarm: deploy/s100p/rollback-low-confidence-20261024-172554 (old unit and release reference in report.json).
- Backend: deploy/s100p/rollback-coverage-20261024-172559/backend.
- AI: deploy/s100p/rollback-tracking-policy-20261024-172600/ainvr_ai_service.
- Frontend pre-feature: deploy/s100p/rollback-rectangle-20261024-172603/frontend; pre-focus-fix: rollback-rectangle-20261024-172928/frontend.
- Current frontend asset: index-ftp39wGl.js.
- AI binary SHA256: 49c7a759a99dded7393b89dc81682adad2ce66312cd0a54ac4d5fdb5dc0bf5a0.

Restore AI producer first if rolling back protocol, then consumers. Deployment scripts retain automatic rollback on failed health checks. Runtime JSON and AI overlay hashes were unchanged; recorder and ingest PIDs unchanged. All nine services reported healthy.
Test logs are machine-local under test/results/tracking-policy (Git ignored); source probes and deployment scripts are tracked candidates.
Automatic AI review qualification is unchanged; this release does not certify model accuracy.
