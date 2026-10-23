# Counter occlusion alignment — 2026-10-23 21:39

The active boarding counter used a 1000 ms passage gap, shorter than the rear-camera tracker coast setting of 1500 ms. Updated only that counter through the normal console save flow to 1500 ms (definition version 2). The compiled binding keeps its original line edge and direction. Existing counts are retained.

Added specific continuity rejection reasons for timeout, invalid time, displacement, size change and label change. Both counting and passage alarms still use the same continuity implementation. No cross-ID merging or relaxed geometry/size checks were added. Real observations must still confirm a pending line crossing after occlusion.

Validation: alarm suite 172 passed / 40 environment-dependent skipped; the subsequently added engine diagnostic persistence case also passed. Frontend statistics 5 passed; TypeScript and production build passed. New regression covers 1200 ms occlusion (1000 ms rejects, 1500 ms preserves exactly one crossing), no prediction-only completion, and no different-ID completion.

Published alarm release: deploy/s100p/alarm-service/release-line-confirm-20261023-213910.
Rollback backup: deploy/s100p/rollback-line-confirm-20261023-213910, containing the prior systemd unit and frontend. Deployment script: deploy-package/deploy-line-confirmation.py. AI, recorder, ingest, backend and LLM process IDs remained unchanged. For configuration rollback use the console to restore counter short-loss allowance to 1 second; do not revert the parameter database wholesale.

This addresses a confirmed timeout mismatch, not proof of zero missed or extra counts. Long occlusion, loss of identity and ambiguous observations still reject counting. Real-video ground-truth accuracy has not been established by this short deployment check. No commit or push performed.
