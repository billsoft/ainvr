# PTZ scene-bound arming

> Historical experimental design and measurements. The current customer-facing contract is [preset-bound arming](PTZ-PRESET-ARMING.md). Arbitrary-view projection is disabled by default; the experiments below remain evidence, not a release claim.

## Contract

Scene binding is opt-in for each saved polygon on an AI output with a controllable PTZ source. Fixed cameras, whole-frame rules, ordinary unbound polygons and existing channel configuration keep their existing semantics. Binding is configured in the existing arming editor; the PTZ sidebar only summarizes scene state.

`alarm_arming_sources` keeps the manually saved canonical polygon. PostgreSQL `arming_scene_zones` stores an immutable reference frame association and canonical points, plus a versioned current projection. Current coordinates are persisted independently of the manual configuration revision. The application never repeatedly transforms an already-transformed polygon. Projection updates and reference changes are journaled. Current reference images are pinned on the configured storage volume in a separate namespace. Inactive historical JPEGs expire after seven days or when the historical image budget is exceeded; geometry, digest and audit metadata remain. Unused drafts are reclaimed after their grace period.

After motion, a bound region is usable only when the current stationary frame reliably matches its saved reference. Rules and the live overlay consume the same persisted projection. Unmatched, off-screen, stale, changed-source or changed-geometry bindings pause only their own rules; ordinary view protection remains in force for other regions. Returning to the reference scene permits recovery. Restart invalidates previously matched status before rules synchronization and verifies the real current view again.

The native matcher uses existing hardware decode/resize and median filtering, NeuFlow on BPU, dx/dy Gaussian smoothing, bidirectional consistency, appearance checks and a robust projective fit. It requires distributed inliers, local support in every grid cell touched by the polygon, and bounded, non-reflected geometry. No new model or CPU inference is introduced.

## ONVIF position feedback

Measured stationary ONVIF pose helps reject motion, but the present adapter has no trustworthy pose observation timestamp. Repeated IDLE responses cannot renew visual authorization. Both protocols require two consistent visual projections after movement. Normalized pan/tilt/zoom values alone are not a calibrated camera projection, so they cannot replace image geometry after arbitrary movement.

Receiver wall-clock duration and packet PTS establish receipt of a stream, not its exposure time at the camera. A controlled replay of an old H.264 fixture, paced in real time, passed the transport gate twice; all 92 picture slices in each capture were verified as coming from that old fixture. Neither pixel equality nor pixel inequality solves this. The current implementation does not claim to detect arbitrary frozen/re-encoded or replayed source imagery. The test evidence is under `test/results/scene-time-20261121/`.

## Editing and persistence

The server freezes a current hardware-decoded frame and binds it to actor, source identity, processor, geometry, motion epoch and manual revision. Save proves that the frozen view is still current before entering a short database transaction. Versions are rechecked inside the transaction. Conflict preserves the UI draft. Unbinding requires a valid current projection. Editing a lost region explicitly creates a new reference rather than silently relocating the old one.

A source/scene revision changes the analysis view epoch, preventing the camera movement itself from becoming a crossing or carrying old dwell evidence into a new view. An unchanged stationary projection does not reset counting. Historical alarm facts retain their occurrence-time geometry.

## Deliberate limits

- This is a projective scene match, not a reconstructed 3D world. Large viewpoint changes, parallax, repetitive/blank scenery, occlusion, darkness, unsupported distortion or insufficient overlap can remain unmatched.
- Entire-frame and ERP/wrapped regions are not scene-bound.
- Image-angle based flow counting cannot retain its meaning under perspective changes; use named edges or gates for a bound polygon.
- A saved region must fit inside reliable supported image bounds. Partial off-screen regions are paused rather than clipped into a different counting region.
- Current capture supports source dimensions up to 4096 per side and 8 Mi pixels. Unsupported/no-PTZ sources retain the ordinary editor.
- Hardware work is single-flight and bounded. Loading/busy/error states never mean successful matching. A single interactive request can wait for an existing background operation; concurrent interactive requests are rejected rather than queued without limit. Multiple saved reference images can exceed one editor freeze budget; those regions stay unavailable in that freeze.

## Acceptance evidence

Automated: native matcher geometry/outliers/reflection/blank tests; auth, single worker admission and native route tests; real isolated PostgreSQL binding/CAS/reference/history/startup tests; alarm crossing/dwell/paused-view regressions; frontend freeze, draft/conflict, binding and overlay tests.

Hardware evidence: `test/results/scene-matching-20261121/`, including real-camera capture and controlled perspective/translation/zoom fixtures. Synthetic geometric fixtures prove projection consistency, not universal field accuracy.

190 trial deployment: `out/scene-binding-20261121-trial3` (2026-11-21), native service, backend and web artifact/source digests verified. The production path `/home/sunrise/ainvr` on this board is a bind mount of the SSD working tree. Only AI and backend services were restarted; recording, ingest and protocol gateways were preserved. Dedicated scene storage is provisioned as the actual backend user, mode 0700, without granting write access to the SSD root. Provisioning and its dependencies are included in release manifests.

| User operation / invariant | Evidence |
| --- | --- |
| Create and bind a saved zone | Real browser save, scene row matched, immutable reference and separate current points |
| Pan a camera | Old overlay hidden pending verification; small right pan recovered with current X shifted about 0.03 |
| Edit after pan | Frozen editor showed the projected cabinet polygon at the new position |
| Zoom partly outside frame | Region became unmatched and its overlay disappeared; canonical geometry retained |
| Return to saved preset | First return recovered, maximum reference displacement 0.84 original-image pixels |
| Concurrent movement during editing | Second browser moved camera; save rejected with conflict, full draft preserved; database unchanged |
| Lost reference recovery | Explicit redraw/rebind succeeded with new zone version and reference; history retained |
| Backend restart | Matched row invalidated to pending before rule synchronization; reference survived, verified recovery in about 13 seconds |
| Fixed camera regression | Original three zones, rule associations and boarding counter remained available; no scene option appeared |
| Tablet | 768x1024 editor, selection, binding setting and save/cancel controls inspected; editing panel moved below video |
| Automatic rule semantics | Crossing/dwell/pause regression tests; startup invalidation, version/source/geometry conflict and history tested with isolated PostgreSQL |
| Storage and release safety | Real sunrise-user SSD read/write, namespace isolation, retention and downgrade tests |

Real-camera test zones have no rules or counters, so this acceptance does not create operational alarms. Functional alarm semantics are covered separately by regression tests. Full ONVIF scene-binding acceptance on an independent ONVIF AI output, arbitrary camera models and long-term outdoor accuracy are not claimed; ONVIF pose heartbeats and movement rejection are covered by automated tests. No automatic GitHub publication is part of this trial.

A later return remained paused although its global fit was excellent (0.106 model-pixel reprojection error): two of eight polygon-intersecting local cells lacked evidence. A subsequent frozen image showed a person in front of the cabinet. Stored aggregate evidence cannot prove that person alone caused the earlier rejection. This is an explicit conservative limitation, not a passed automatic-recovery case. Regions touching low-texture, occluded, parallax or image-edge cells may remain paused even at the correct preset; users can return to a clear view or explicitly redraw/rebind. Do not weaken local support solely to make a specific acceptance example pass.

Final trial: transient movement remained pending, then recovered after stop; it no longer incurred the additional unmatched backoff. Successful unbinding copied the verified current coordinates into the ordinary manual zone. Cleanup removed only the temporary zone and temporary preset 1, retained preset 32, and returned the physical view. The resulting source has no test zones, assignments, counters or scene bindings; historical audit remains. Cleanup records are in `test/results/scene-matching-20261121/cleanup-*.json`.

Trial3 checks completed: native matcher/route 16 tests; affected alarm logic 41 tests; backend initial related suite 59 tests plus later targeted real-PG/local-support/storage/admission/pending regressions; frontend initial 59 tests, later binding/overlay 23 and notice 9 tests; release downgrade 21 tests; storage/provisioning 6 tests. Counts are per run and overlap, not an additive unique-test total. Backend/frontend types and trial3 build passed. This earlier review is superseded by the quantitative experiment below; it is not a current product-release sign-off. All new source, migration and test files must be included when committing.

## Quantitative re-evaluation, 2026-11-21 afternoon

The frozen challenge set contains 30 image pairs and 66 polygon judgments. Trial3 accepted five negative polygons: one small occlusion, three local foreground displacements, and one repeated-texture ambiguity displaced by 64 model pixels. Broad 8x6 cell support was insufficient to authorize the actual polygon interior. This is a reproduced defect, not a hypothetical limitation. Baseline evidence: `test/results/scene-quantitative-20261121/`.

Separate real-camera experiments exercise GB/T and ONVIF on the same physical Hikvision camera; these are not independent camera-model validations. Temporary polygons have no rule or counter assignments. Results and captures are in `test/results/scene-live-repeat-20261121/`. A screenshot looking aligned or a `matched` status alone is not a quantitative accuracy oracle. Offline local-feature estimates are reported only when their held-out residual and corner-support checks pass; asynchronous captures are explicitly identified.

## Trial5 measured result and release boundary

Trial5 is installed on 190 at `out/scene-binding-20261121-trial5`. Its production matcher/projection source is identical to the final pinned experiment named `scene-trial4-pinned-20261121`; trial5 additionally includes the corrected first-miss retry test. This section supersedes the earlier trial3 acceptance conclusion.

The v2 matcher adds GPU-generated local descriptors, ambiguity checks, and support inside the actual polygon footprint. Broad cell coverage alone no longer authorizes a polygon. Stable verification refreshes evidence without changing the analysis epoch; failed checks use bounded 5/10/20/45-second retry tiers. Old ONVIF IDLE observations cannot refresh visual verification. Startup invalidates saved matches until rechecked, while preserving immutable references and persisted current geometry.

| Frozen benchmark group | Image pairs | Visible ROI accepted | Negative ROI correctly rejected |
| --- | ---: | ---: | ---: |
| Original and sub-cell challenges | 30 | 39/47 | 19/19 |
| Independent challenges | 9 | 1/9 | 7/7 |
| Saved real-camera captures | 6 | 6/6 | Not applicable |

There are 88 polygon judgments: 43 accepted with a qualifying oracle, 3 accepted without a qualifying oracle, 16 visible positives rejected, and 26 negatives rejected. All five reproduced false acceptances are repaired; no negative was accepted in this finite set. This is not a claim of zero field false matches. Independent positives include repeated judgments of the same static region, so 1/9 is not an estimate of population accuracy; it does demonstrate a substantial availability limitation. Three real-camera cases lack independent corner support and must not be quoted as measured geometric accuracy. Full evidence: `test/results/scene-trial4-pinned-20261121/summary.json`, `regions.csv`, pinned digests and raw observations.

Real post-deployment browser checks used both protocols on the same Hikvision camera:

| Operation | Observed result |
| --- | --- |
| ONVIF right pan | Old overlay hidden; verified projected polygon recovered after 17.95 seconds |
| Refresh and open editor after pan | Persisted new coordinates retained; frozen editor polygon followed the cabinet |
| ONVIF preset return | Recovered after 17.17 seconds |
| Backend restart | Saved match invalidated and reverified after 27.31 seconds |
| GB pan partly outside view | Unmatched after 7.44 seconds; unreliable polygon hidden |
| GB preset return | Physical view returned; scene recovered after 49.22 seconds, but the separate preset operation timed out without an arrival acknowledgment |
| Fixed-camera regression | Three original zones and their rule/counter associations remained; no scene-binding option appeared |

These times include transport, capture, hardware admission and repeated verification, not just inference. They show that fast/seamless recovery is not yet established. Warm standalone matcher measurements were 367–413 ms, with peak process RSS about 238 MiB; cold process completion was 4.75 seconds. These are not whole-system throughput or 8-channel capacity results.

Latest targeted checks: native 18 passed; projection 4 passed; time-safety 16 passed; real isolated PostgreSQL 8 passed, 1 optional SSD/JPEG fixture skipped. Backend/frontend type/build checks passed. Earlier frontend, alarm and storage regressions are listed above; they were not all rerun after the native algorithm revision. Temporary physical zones had no real alarm or counter assignments: live end-to-end alarm triggering during transformed views remains unverified.

The paced-old-video experiment (`test/results/scene-time-20261121/paced-replay-verified.json`) reproduced old source pixels arriving with acceptable receiver timing. Receiver timestamps, image hashes and repeated IDLE cannot prove fresh camera exposure. This limitation remains explicit.

Cleanup restored the complete original `hik-gb-follow` channel configuration and verified the other channel hashes unchanged, removed the two temporary scene zones and temporary preset 1, retained preset 32, returned the physical view and stopped the two task observers. History/audit remains. Records: `test/results/scene-live-repeat-20261121/config-restored.json`, `cleanup-*.json`, and posttrial protocol transition logs. No GitHub commit, 189 rollout, broad data cleanup or new 8x3 FPS certification is claimed.

Release assessment: trial candidate for constrained scene evaluation, not general customer release approval. Remaining gates are availability across independent real scenes, acceptable recovery latency, source-freshness handling where available, and live alarm/counting validation with transformed geometry. Do not weaken ambiguity/occlusion rejection merely to improve acceptance counts.

## Downgrade guard

A release with active scene bindings requires `sceneBindingVersion: 1` and the scene runtime files. The release preflight checks the live database even for older PTZ-aware builds; a plain view-guard marker cannot authorize a downgrade that would interpret canonical coordinates as current coordinates.

Formal preset bindings additionally require `presetBindingVersion: 1`, migration 034 and the preset runtime. See PTZ-PRESET-ARMING.md for the current release boundary; the arbitrary-projection trial above remains disabled by default.
