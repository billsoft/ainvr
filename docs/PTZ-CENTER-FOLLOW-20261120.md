# PTZ centering and following — 2026-11-20

## Current implementation

The authoritative click-center behavior is described in **Explicit NeuFlow calibration and open-loop clicks (r12)** below. Ordinary non-native clicks use saved calibration only; they do not inspect video, update calibration or perform corrective movements. Calibration requires an explicit user action. Native ONVIF centering and AI target-following are separate paths.

The earlier sections preserve implementation and hardware-test history. Their per-click feedback, recovery and online-learning descriptions are superseded by r12 and must not be used as the current operating instructions. Deployment paths and commit statements in those sections describe the individual historical runs.

## Scope

190 only. GB input and its AI output use the existing shared PTZ path. Native ONVIF point centering is preserved. No C++ tracker, counting, alarm facts or AU-buffer settings were changed in this optimization. Camera movement still invokes the existing view protection. Automatic follow zoom remains zero.

## Click centering

The visual fallback measures per-click command-to-image response including coast, uses bounded calibrated segments, and confirms arrival with three fresh frames after feedback delay. Failed matching brakes before a bounded stationary recovery. Cancellation and terminal fault causes survive asynchronous Stop races.

138 affected frontend tests passed; typecheck, lint, build and whitespace checks passed. The same delayed-camera simulation reduced segments and residuals, but it is not physical camera calibration.

Real GB AI-output tests on 190:
- About 120 px horizontal / 44 px vertical initial offset: 8.159 seconds, approximately 6 px final residual.
- About 154 px horizontal initial offset: 8.030 seconds, clicked feature reached the center.
- Both returned idle without the partial/error notice. The old 5.746-second sample ended partial with approximately 45 px residual, so it is not a successful speed baseline.

Precision improved in these two samples. Successful large-offset centering still takes about eight seconds and remains segmented; faster continuous operation is not certified. NeuFlow was evaluated previously but is not integrated in this control path.

## AI follow

A 125 ms start-to-start poll period replaces 200 ms after each reply. Only one ordinary request is in flight; slow calls skip slots. Repeated frame index/PTS cannot renew motion. Missing display/source evidence brakes, with the existing four-second same-identity retention only after Stop confirmation.

The ordinary low-speed controller remains. Three fresh observations showing persistent outward error can raise the threatened axis gradually, up to normalized 0.50. Converging error removes the boost. The stopping-envelope estimate constrains the added boost, not the entire baseline law, and is a simulation assumption rather than a universal calibrated camera bound.

Short lead is limited to 160 ms and 4% of an image axis. It requires fresh explicit device IDLE evidence and washout on both source PTS and result time. Late, stale, unknown or in-flight status invalidates that evidence. GB without MoveStatus does not use this lead. No physical one-to-two-meter prediction is claimed.

128 synthetic closed-loop cases per variant, varying actuator lag, finite coast, gain, target speed, stopping/reversal and direction:

| Variant | Fully outside | Clipped | P95 overshoot | Worst overshoot |
| --- | ---: | ---: | ---: | ---: |
| Prior controller/cadence | 18 | 40 | 0.2113 | 0.2514 |
| Cadence only | 16 | 30 | 0.1711 | 0.1948 |
| Adaptive 0.35 | 16 | 18 | 0.1122 | 0.1331 |
| Adaptive 0.50 | 10 | 18 | 0.1122 | 0.1326 |
| Adaptive 0.60 | 10 | 18 | 0.1122 | 0.1326 |

Overshoot is normalized image width. The simulation assumes 80 ms capture-to-result and 850 ms displayed-video delay; these are not measured end-to-end latency. Runtime held_s=0.7574 measures buffer arrival-time span only. Tests assert P95 and worst overshoot do not regress against either baseline. Actual fast-person/vehicle retention remains unverified.

## Verification and deployment

- Follow change: backend 52 tests and frontend 110 tests passed, including delayed-step/brake races, duplicate timestamps, IDLE expiry and automatic zoom=0. Counts overlap with the centering suite; do not sum them as unique tests.
- Independent review completed before deployment.
- Candidate: test/results/ptz-follow-adaptive-1795159929715. Logs, source checksums and 491 artifact checksums retained there.
- Active web release: /mnt/ainvr-ssd/ainvr-release/ptz-follow-adaptive-1120-r1, index-qhDQDuMl.js.
- Only backend restarted. AI, recorder, ONVIF and GB service process/start identities were unchanged. Backend ready and NRestarts=0.
- Backups: /mnt/ainvr-ssd/ainvr-rollback/{backend,web}/20261120T074007Z-1795160407643967717; retention remains at most three per service.
- Browser: selected a stationary detected plant (#2), observed blue selection and vertical centering; switched to a monitor (#3), observed lateral movement toward center; Stop followed by manual mode completed. These stationary tests validate the interface and control loop, not fast-target performance. The camera was left stopped in manual mode, with view protection still awaiting user verification.

No commit, push or 189 deployment was performed for this task.

## GB centering investigation, afternoon follow-up

The real iDS-2DE7223MW-A camera UI offers GB/T 28181-2016 only. Added an internal authenticated, bounded PTZPosition query over the registered transport. It correlates device/channel, SN, source, transport and registration generation; missing numbers are not zeros. The existing prepare.position=false contract remains unchanged. A position response alone would not establish precise-control support.

On the real registered TCP connection, PTZPosition received SIP 200 OK but no correlated position Response within three seconds, twice. This is evidence of unavailable position feedback in the tested configuration, not proof that every firmware or GB camera lacks it. No ISAPI/ONVIF command was substituted for GB centering. DragZoom rectangle scaling was not misused as a constant-zoom point operation.

The gateway-only update preserved other service process/start identities. Camera registration required reconnection; the existing GB platform configuration was disabled and re-enabled, with all original settings retained. Registration, directory and streaming subsequently recovered. Gateway package tests: 71 passed, plus targeted race tests. Query build/probe/wire evidence is under test/results/gb-center-20261120.

A calibrated segment could brake between the first moving frame and the next valid velocity estimate. The handoff now only extends inside the already approved calibrated duration and must also shorten or immediately brake when new evidence reduces headroom. Motion bounds, Stop acknowledgement, cancellation and zoom=0 remain.

Initial r4 hardware checks exposed an additional incomplete result; these were NOT accepted as successful centering:

| Path | Offset | Elapsed | Screenshot-derived residual | Result |
| --- | --- | ---: | ---: | --- |
| Previous r3 AI | right 129 px | 7.483 s | 6.2 px | centered |
| r4 AI | left 129 px | 5.252 s | 1.1 px | centered |
| r4 AI | right 129 px | 5.362 s | 30.7 px | partial |
| r4 raw GB | right 129 px | 6.098 s | 32.6 px | observation timeout |

Residuals use independent SIFT/RANSAC homography on before/after video crops, excluding UI and timestamp; 344–485 inliers. This is a rendered-image measurement, not a physical angular accuracy certification.

Opt-in browser diagnostics (?ptzDebug=1) revealed raw feedback near 0.51 s and AI feedback near 1.73–1.90 s. A failed AI diagonal click exhausted its fixed settle window with only 54 ms left for the next approximately 67 ms video frame, incorrectly reporting a fresh-frame timeout. These are measured command-to-visible-motion delays, not just AU buffer spans. A later raw diagnostic run centered in 2.725 s; AI took 7.633 s with an extra probe after a post-Stop match recovery discarded calibration. Follow-up acceptance below supersedes those intermediate checks.

### Final click-center hardware acceptance (r6)

The production frontend is `gb-center-recoil-1120-r6` (`index-C_jEVp5G.js`). Stop-observation timing adapts to measured presented-video lag, with the existing hard movement/Stop budgets unchanged. A brief stop-stage recoil is rechecked without new movement; substantial or active-motion reversal still stops. Verified small overshoot permits at most one slower correction (speed <=0.20, <=150 ms), never a default 310 ms reverse probe. Stable no-motion and insufficient feedback have separate notices. Focused click/control/follow tests: 110 passed; typecheck and lint passed.

| r6 actual GB control path | Click displacement on 630x473 rendered video | Click to settled UI | Independent screenshot residual | Inliers |
| --- | --- | ---: | ---: | ---: |
| Original GB stream | left 129 px | 4.322 s | 3.98 px | 398 |
| Original GB stream | right 129 px | 3.222 s | 4.88 px | 414 |
| Original GB stream | up 70 px | 2.938 s | 5.64 px | 548 |
| GB AI output | left 100 / down 70 px | 6.486 s | 7.21 px | 319 |

These four checks completed without reversal/match errors. This is bounded real-camera acceptance, not a guarantee for arbitrary scene texture, network stalls or every camera firmware. Source images and SIFT/RANSAC measurements are retained; JSON summaries and bounded debug traces are in `test/results/gb-center-20261120/`.

A separate upper-limit check stopped after one 310 ms GB probe with no meaningful image motion and showed the explicit possible-limit notice. Independent read-only ONVIF status (diagnostic only, never used for GB actuation) measured tilt 0.902 before upward travel, 0.999556 after successful upward centering, then 1.0 at the no-motion limit, range [-1,1]. Zoom remained 0. This establishes the tested upper boundary; the earlier partial diagonal outcome must not be described as successful centering.

No additional optical-flow model, automatic zoom, tracker identity or alarm/counting changes were required for this fix. Opt-in diagnostics are bounded and disabled without `ptzDebug=1`.

### Preset acceptance follow-up

A temporary GB preset named `验收临时点1120` was created through the browser. A bounded left command displaced the rendered image center by 49.4 px (566 independent SIFT/RANSAC inliers); calling that preset returned it to within 0.06 px of the saved center (929 inliers). The image proves this particular recall returned, but the protocol did not provide a motion-finished acknowledgement. Wire logs show approximately 29.973 seconds of lease/Stop supervision; this must not be represented as confirmed arrival.

The temporary preset was deleted through the browser after explicit user confirmation; the refreshed list contains original preset 32 only. Original preset 32 was not overwritten or removed. A UI issue was observed: successful save/delete remained in the edit form. A metadata-only PUT endpoint and corresponding UI now separate name/shortcut edits from physical position overwrite, pending combined deployment/browser acceptance.

The combined preset release added `PUT /channels/:id/ptz/presets/:presetId` for local name/shortcut metadata only. Existing native ID is verified against the camera; device-group locking and shortcut conflicts are checked. The DB update preserves saved position and device state; sorted/deduplicated alias sets share one PostgreSQL advisory lock. Route/manager 32 tests and two selected real PostgreSQL 16 tests passed (three unrelated tests in the PG file were not selected). Frontend preset tests initially 25 passed; browser follow-up found the manual-mode control-notice display omission and prompted a final regression.

Browser r7: created `联调临时点1120` (native ID 1, shortcut 1), renamed to `联调改名1120` and shortcut 2 through PUT, then explicitly overwrote that temporary preset's position. Metadata-only edits left Pan=-0.459444, Tilt=0.905333 and Zoom=0 exactly unchanged. After overwrite, recall returned Pan=-0.460111, Tilt=0.905333 and Zoom=0, matching the new saved position. Device motion status was read independently through ONVIF for verification only; every camera write in this test used GB. Original preset 32 remained untouched.

Backend source/build hashes and position evidence are under `test/results/gb-center-20261120/`. Backend-only deployment backup is `/mnt/ainvr-ssd/ainvr-rollback/backend/20261120T084613Z-1795164373541207700`; AI, recording, ONVIF, GB, alarm and ingest process/start identities were unchanged. Retention was reconciled to three backend backups after identifying an older legacy backup directory.

Final production web release: `/mnt/ainvr-ssd/ainvr-release/gb-center-presets-1120-r8`. It includes the reviewed reverse-correction preflight guard, a positioning deadline independent of in-flight requests, and control notices visible in manual/preset mode as well as click-center. Final selected tests: 85 visual-center + 8 positioning-control passed; 26 preset panel/contract passed; backend 32 route/manager + 2 selected real-PG tests passed. Types and builds passed, and `git diff --check` is clean. Build-to-source checksums were verified before deployment and after final changes. Existing unrelated uncommitted work was preserved; no commit/push/189 deployment was performed.

Final browser r8 acceptance confirmed the no-arrival acknowledgement notice after the supervised Stop. Debug query parameters were removed, the camera was left stopped in persistent click-center mode, and view guards were not automatically rearmed. The second temporary preset `联调改名1120` (native 1, shortcut 2) remains pending the user's separate browser-deletion confirmation; original 32 remains untouched. Screenshot: local `D:/rdk/ptz-modes-1120/gb-center-final-release.jpg`.

Cleanup completed after the user's explicit confirmation: deleted `联调改名1120` (native 1, shortcut 2) through the final production browser UI. Success notice appeared and the refreshed list contains preset 32 only. No temporary preset remains. Proof screenshot: `D:/rdk/ptz-modes-1120/preset-cleanup-complete.jpg`.

## User-requested one-direction policy (supersedes reverse correction)

After further real use still produced apparent-reversal notices, the user requested removal of image-reversal checks and no opposite-direction command within one click operation, accepting overshoot. The follow-up removes automatic reverse correction rather than merely hiding its error. Horizontal and vertical command signs are locked independently on first dispatch; crossing a commanded axis ends the operation instead of pulling back. Stop acknowledgement, bounded command duration, cancellation, fresh-frame/matching checks and no automatic zoom remain. Near-zero initial axes stay off so subpixel cross-axis jitter does not prematurely stop a horizontal/vertical click. Deployment and final targeted acceptance are recorded below once completed.

One-direction policy deployed as `/mnt/ainvr-ssd/ainvr-release/gb-center-oneway-1120-r9`, source SHA prefix `443ec220`. 86 focused tests, TypeScript and lint passed; independent review found no blocker. Active JS bundle was checked to contain no former reversal-error message; `git diff --check` passed. After another window released control, browser AI-output click from (850,483) on the 630x473 video completed in 4.898 seconds with no reversal/error notice; persistent click mode remained selected. This single check is a smoke test, while the per-axis no-reverse invariant is tested with mocked command capture. No service restart, automatic zoom, tracking/counting change or preset change was made. Final screenshot `D:/rdk/ptz-modes-1120/gb-oneway-after.jpg`.

## Persistent adaptive calibration (r10, 2026-11-20)

The user reported that r9 still stopped after a small move when video feedback was insufficient. The previous controller discarded endpoint calibration after each click and initially limited even a calibrated movement to 310 ms unless subsequent video extended its deadline.

The new controller stores reliable per-axis, per-direction endpoint samples (speed, actual dispatch-to-Stop duration and normalized image displacement) in PostgreSQL migration 031. History is bounded to 24 records per scope, six per signed axis, with a 24-hour sample validity window and at most 32 scopes per physical motor. Scope separates transport, source binding, displayed feed, original video geometry and reported zoom. Shared-motor zoom and native positioning invalidate the common epoch before their commands. Calibration reads and writes use optimistic revision checks; acquisition verifies the expected epoch while holding the motor lock, closing the read/zoom/acquire race.

Two consistent independent endpoints near the requested speed can authorize the first movement directly. The plan has a fixed Stop deadline, a maximum historical segment of 620 ms and no more than 20% duration extrapolation beyond the shorter validated sample. Fresh feedback may brake earlier. Feedback loss cannot extend this deadline or issue a duplicate blind movement; estimated completion is distinguished from verified visual centering. Per-axis one-direction locking and zero automatic zoom remain in force.

When actual zoom is unknown, persisted history remains a candidate after opening/refreshing the page. A new reliable observation validates it before reuse; incompatible or non-comparable evidence clears inherited records on all axes. Only a successfully persisted scope/epoch/revision unlocks reuse. External camera-webpage zoom cannot be detected reliably through this camera's GB interface; no universal accuracy guarantee is implied. This implementation learns bounded local image response, not physical angles or metres.

Validation: 101 visual-controller tests; 14 hook/control tests; 57 backend route/manager/follow tests; six tests against isolated PostgreSQL 16, including migration, restart persistence and concurrent versioning. Type checks, production builds and `git diff --check` passed. Independent review checked the fixed deadline, unknown-zoom inheritance, write-failure handling and epoch-acquisition race. Missing-feedback behavior was fault-injected in tests rather than by disrupting the live camera stream.

Deployed to 190 only: web `/mnt/ainvr-ssd/ainvr-release/gb-center-calibration-1120-r10`. Backend backup `/mnt/ainvr-ssd/ainvr-rollback/backend/20261120T093359Z-1795167239612659501`; web backup `/mnt/ainvr-ssd/ainvr-rollback/web/20261120T093402Z-1795167242574338034`. Both retain three backups. AI, recorder, ONVIF, GB, alarm and ingest process identities remained unchanged; migration 031 applied successfully. No commit/push or 189 deployment.

Browser checks on the real GB AI output: first two horizontal clicks produced persisted independent samples of 333.6 ms / 0.16288 normalized displacement and 312.5 ms / 0.15039. The third click logged `model: history`, planned 375 ms and actually executed 383.7 ms, instead of reverting to the 310 ms probe. All three finished with visually verified centering and no reversal or insufficient-feedback notice. Independent SIFT/RANSAC comparison of the rendered 630x473 video measured clicked-point residuals of 3.67, 6.96 and 11.92 display pixels (299, 260 and 338 inliers). These are bounded horizontal smoke checks, not all-view/zoom acceptance. The observed AI-video command-to-visible-motion lag was approximately 1.9–2.0 seconds, so end-to-end operation still includes feedback latency.

Source checksum manifest and build/test logs: `test/results/gb-center-20261120/calibration-*`. Backend tests: `test/results/ptz-center-calibration-v1/`. Browser screenshots and traces: local `D:/rdk/ptz-modes-1120/gb-calibration-trial*-*.jpg` and `calibration-browser-traces.json`.

Refreshing the production browser retained the database's two endpoint records. As intended for unknown zoom, the first post-refresh click used a visual probe, validated the inherited response and saved revision 3 with three records. It completed without an error. No physical preset was changed, and no automatic rearming was performed.

The next post-refresh click reused `model: history`, planned 375 ms and reached the centering tolerance with a single pulse; settled residual was 4.86 working pixels. Thus this five-click horizontal sequence verified database learning, direct history reuse, refresh validation and subsequent reuse. Actual command duration in the last browser run was 428.9 ms, so timer jitter and end-to-end latency still require broader load testing. The opt-in debug query was removed after acceptance.

## Explicit four-direction calibration (r11, 2026-11-20)

The follow-up user's insufficient-feedback report exposed sparse history: the existing database covered positive pan only, not all signed axes. An explicit calibration action is now integrated into the shared click-center panel for non-native positioning. It reports 0–4 available directions and permits cancellation; it does not start moving merely on entering the mode. A run measures up to twelve bounded pulses, stopping as soon as two compatible independent samples exist for each signed axis. Each accepted sample is persisted before continuing. Poor imagery or a limit leaves the corresponding direction incomplete, rather than claiming success. No automatic zoom is introduced.

Each explicit probe uses the common .36 axis command with a 420 ms deadline. Feedback may shorten but never extend that deadline. Only a complete pulse, confirmed Stop and stable original-anchor endpoint can train the model. A command acknowledgement or Stop failure ends the sequence; an observation-only failure may skip that sample. A run identity prevents a cancelled, late save from resetting a newer calibration UI. Zoom, screen clicks and presets cannot interrupt a running calibration without stopping it.

Normal first clicks select a calibrated speed when both active axes have compatible samples, including horizontal far clicks and 45-degree clicks; oblique axes outside the measured speed range are not blindly extrapolated. Unknown-zoom refresh validation permits a 1.45 duration ratio (310 ms observation versus 420 ms training) while retaining the 1.25 normalized-response agreement. Readiness means measured directions at the common speed, not guaranteed positioning at arbitrary focal length or angle. The panel explicitly distinguishes stored history awaiting first-view scale verification; manual zoom invalidates the stored scope and updates readiness.

Real 190 GB AI-output browser acceptance: eight pulses produced two valid samples for each signed axis, 419.9–421.9 ms dispatch-to-Stop, with no zoom. The panel reached 4/4 and PostgreSQL revision 12 contained eight measurements. A left click used a 503.7 ms historical first pulse and 208.4 ms visual correction, ending at 8.11 working pixels residual; a downward click used 503.9 ms plus 239.2 ms, ending at 3.09 working pixels. Both returned to idle without insufficient-feedback/reversal errors. These residuals are controller estimates, not independent ground truth. The AI feed's observed motion latency remained about 1.8 seconds. A post-refresh right click also centered; its slight final overshoot withheld new training, preserving existing history rather than falsely validating it.

Targeted checks include the prior 106 visual-controller cases, three new calibrated-speed/refresh regressions, three probe-deadline/late-ack regressions, hook cancellation/storage/late-run checks and shared-panel interaction tests. TypeScript, frontend production build and diff whitespace checks passed. Test/build/source manifests are under test/results/ptz-training-20261120. Missing-video fallback is exercised by fault-injection tests; no production stream outage was deliberately induced. Frontend-only rollout on 190; no backend or AI service restart, Git commit/push or 189 deployment. Preset 32 remains untouched and view guards were not automatically rearmed.

Final UI release: /mnt/ainvr-ssd/ainvr-release/gb-center-training-1120-r11c. Duplicate calibration notices were removed. A second, shorter post-refresh left click executed 310.8 ms, centered at 3.50 working pixels, preserved four-direction history and updated the panel from “首次定位会核验当前倍率” to “四方向已有标定；变焦后需重新标定”. Successful ordinary measurement writes now refresh panel readiness without issuing extra per-pulse reads. The camera was left stopped, with click-center mode selected. Final screenshot: D:/rdk/ptz-modes-1120/calibration-r11-final.jpg; trace archive: test/results/ptz-training-20261120/browser-traces.json. Backend and GB services remained active with NRestarts=0.

Final deployed-source visual-controller rerun: 112/112 passed (final-core.log); final hook/control 11/11 passed; calibration-panel suite 4/4 passed in the 15-case combined run. TypeScript log is empty, production build passed, and git diff --check plus deployed-source checksums are clean.

## Explicit NeuFlow calibration and open-loop clicks (r12, 2026-11-20)

This section supersedes the r10/r11 click-time visual recovery and online learning behavior. The user explicitly requires that ordinary non-native click-center use saved calibration only. It must not capture images, call optical flow, wait for video feedback, perform corrective pulses, or write calibration. Missing or invalid calibration asks the user to press the calibration button. ONVIF native point-center and AI target-following remain separate paths.

Explicit calibration samples each signed axis at command speed .36, using 1000, 600 and 250 ms durations, repeated twice (24 samples). It fits directional displacement versus duration including command latency. The same-direction repeat agreement and fitted-curve checks gate readiness. Retries can resume an incomplete scope; explicitly recalibrating a complete scope starts a new set. Samples persist in PostgreSQL under the new `neuflow-v1` estimator scope. Old block-matcher measurements are not mixed in. Refresh does not trigger automatic measurement; records have no arbitrary daily expiry. Existing source, dimensions, zoom and shared motor epoch invalidation still apply. An external device-side zoom is not detectable when the protocol supplies no zoom position, so the user must explicitly recalibrate after such changes.

Normal clicks invert these curves once. Both axes start at the calibrated speed; the shorter axis is set to zero at its own deadline while the other continues, followed by one shared Stop. This avoids assuming proportional response at uncalibrated slower speeds. A single-axis click sends one Move then Stop. Late acknowledgements cannot launch corrections or affect a later gesture. Travel is bounded by measured range and the existing control lease; a clipped move is reported as partial, not verified centering. Open-loop positioning is approximate, and does not claim an absolute-position guarantee.

Calibration processing is decoded video resize to 512x384 JPEG, JPU decode, hardware image preprocessing, GLES 3x3 median filtering, the existing INT16 O2 NeuFlow BPU model, identical signed Gaussian filtering of dx/dy, whole-vector outlier trimming and mean motion. There is no foreground masking, RANSAC or CPU inference/image-filter fallback. The decoded network-video path does not claim an ISP 2D-denoise facility. The authenticated loopback native endpoint admits one pair; the model is lazy and released after idle. Native timeout is 15 seconds, BFF 17 seconds, browser request 18 seconds, and explicit pre-motion warmup 20 seconds; hot observations retain a shorter bound. None of those observations run during ordinary clicks.

Validation: native software tests 9/9, frontend targeted tests 162/162 and backend 48/48 passed, with TypeScript and production builds. Real GLES signed-filter error was below 2.4e-7. Hardware synthetic translation +8/-8 pixels measured +7.982/-7.964; cold requests took 3.92-4.45 seconds and warm requests 127-177 ms. These are integration checks, not a new general model-accuracy certification.

190 browser acceptance on the real Hikvision GB AI output completed all 24 samples and reached 4/4. A left click completed in approximately 0.7 seconds and a diagonal click in approximately 1 second, with no video-feedback errors or correction phase; screenshots showed the selected scene points near center. PostgreSQL revision 24 and all samples remained identical before and after clicks. Measurements are at the current camera view and zoom, not an all-camera/all-focal-length accuracy guarantee. Acceptance artifacts are in `test/results/ptz-flow-openloop-20261120`; native hardware records are in `test/results/neuflow-native-20261120-implementation`.

190 AI, backend and frontend were deployed with per-service SSD rollback backups. Final frontend release is `/mnt/ainvr-ssd/ainvr-release/gb-center-openloop-1120-r12b`. No 189 deployment or Git commit/push was performed in this task. Preset 32 was not changed and view guards were not automatically rearmed.

After a full browser reload on r12b, the panel immediately reused 4/4 saved calibration without invoking first-view verification. A pure upward click logged one `{pan:0,tilt:0.36,zoom:0}` Move and one Stop, with 744 ms dispatch-to-Stop-request duration. The selected shelf region moved near the screen center. Final screenshot: `D:/rdk/ptz-modes-1120/openloop-r12-final.jpg`. Source diff whitespace checks passed; AI, backend and GB services were active with NRestarts=0 after deployment. The existing two unrelated channel warnings were not reclassified as a PTZ failure or silently cleared.
