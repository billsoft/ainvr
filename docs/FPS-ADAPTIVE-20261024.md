# Tracking cadence and display trajectory update ¡ª 2026-10-24

## Behavior
- Tracking eligibility uses at least two seconds of effective observation intervals and at least six intervals, with a 2.95 FPS threshold allowing minor jitter around 3 FPS. Each interval takes the larger of source-time and monotonic processing-time deltas.
- A rolling window below the threshold for one second revokes eligibility. A gap over one second or invalid/backwards timestamps immediately resets it. Recovery requires the rolling window to qualify again; it is no longer eight qualifying frame windows.
- Default three real detections for target confirmation remain unchanged: acquisition latency and tracking accuracy are not identical at all frame rates.
- Display trajectories retain five seconds at 3¨C30 FPS, with up to 120 displayed points. A bounded internal buffer preserves temporal coverage. Sampling keeps endpoints and conservatively marks segments containing predictions dashed. This does not alter observations or counter evidence.

## Verification
- Native cadence regression: 3/5/10/15/30 FPS startup, degradation/recovery, mixed frame rates, wall-clock backpressure, large gaps and invalid timestamps passed.
- Frame/API/SEI integration passed.
- Frontend: 36 trajectory/overlay tests passed; TypeScript and production build passed.
- Native production target built successfully; git diff --check passed.

## Deployment
Deployed to 192.168.100.189:8088 on 2026-10-24 19:02 CST.
- AI executable SHA256: 45bac37debfc25a2bc69610d8331f04de1e69bb6d7f2c34f74e32c1962cc00ce
- Frontend entry: index-D2yGIK-U.js
- AI rollback: deploy/s100p/rollback-tracking-policy-20261024-190222/ainvr_ai_service
- Frontend rollback: deploy/s100p/rollback-rectangle-20261024-190225/frontend
- Existing deployment scripts verified health, unchanged configuration hashes and unchanged unrelated service PIDs. Only the AI service was restarted.
- Logs: test/results/tracking-policy/fps-native-build.log, fps-frontend-build.log, fps-ui-test.log (board-local, ignored test artifacts).

These are functional timing/display regressions, not a crowd-occlusion accuracy certification or a long-duration capacity test. No automatic commits or pushes.
