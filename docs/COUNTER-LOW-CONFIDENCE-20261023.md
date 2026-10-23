# Bounded low-confidence counter continuation

Release: 2026-10-23 22:07; alarm-service/release-low-confidence-20261023-220724.
Backup: deploy/s100p/rollback-low-confidence-20261023-220724 (previous unit retained). Deploy script: deploy-package/deploy-counter-low-confidence.py. No frontend, AI, recorder, ingest, backend or LLM restart; process IDs checked by deployment.

Only non-ERP statistics traversal rules may use a confirmed same-ID real observation marked low_confidence. Requires an existing observed passage state and a visible observation within min(configured gap, 1500 ms); weak frames cannot renew that deadline. Size ratio <=1.5, bounded displacement, and no >30% smaller-box overlap with another confirmed observed same-class target. Existing shared passage geometry, line confirmation and continuity checks still apply. Predictions, isolated weak identities, identity changes and alarm review are not newly enabled. New-track ByteTrack thresholds are unchanged pending dedicated tracking validation.

No user confidence, geometry, direction or historical count changes. Rear counter gap remains 1500 ms. User may change 20% to 25% for comparison.

Tests: 176 pass, 40 environment-dependent skips in complete alarm suite. Includes weak line completion, no low-only identity, no different-ID rescue, no prediction-only completion, area/two-gate compatibility, crowding/displacement/size/timeout rejection. git diff --check passed. Live service ready, first 200 observations persisted, zero input failures, zero pending journal records. These checks do not establish real-scene counting accuracy.
