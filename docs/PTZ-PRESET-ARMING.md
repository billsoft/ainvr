# Preset-bound arming

## Customer contract

Fixed-camera arming keeps its current workflow. For a compatible PTZ camera, an operator selects a saved preset, explicitly moves to it, and draws/edits regions in the existing arming editor. A region can opt into that preset. Leaving the view suspends its spatial alarm and counting evidence. Returning does not itself authorize analysis: source identity, preset definition, stop/position and visual checks must pass. The monitor provides an explicit Return to arming view action, never a timer that takes control away from the operator.

This is known-view recovery, not arbitrary perspective attachment. Formal regions retain canonical coordinates. Existing arbitrary-projection records retain their data/history but are paused by default. A failed or stale status must not be displayed as active protection. Visual verification is distinct from applying alarm configuration.

## Product precedent

- Axis Object Analytics supports restricting scenarios to PTZ presets and recommends at least 15 seconds between guard-tour preset changes because the application recalibrates. That recommendation is not a promised 15-second recovery latency: https://help.axis.com/en-us/axis-object-analytics
- Dahua IVS configuration can select a preset and configure its region rules: https://www.dahuasecurity.com/asset/upload/uploads/soft/20190415/DH-TPC-SD2221_Web-Operation-Manual.pdf
- Hikvision TandemVu separates panoramic observation from PTZ tracking through calibration: https://assets.hikvision.com/prd/public/all/doc/sm000086508/UD34609B_TandemVu-PTZ-Camera_User-Manual_5.7.100_PDF1-TEST_en-US_20230822.PDF
- ONVIF PTZ status position and movement information depend on advertised device capabilities. Protocol name alone is insufficient: https://www.onvif.org/specs/2512/ONVIF-PTZ-Service-Spec-v2512.pdf

## UI and operation

1. The existing AI output's Arming button opens preset selection when formally supported. It does not move the camera until the operator presses Move to preset and edit.
2. Preset names are read from the camera/service, with a server-issued definition fingerprint. Missing or unconfirmed presets cannot be chosen. Choosing ordinary current-frame editing retains manual recovery semantics.
3. The editor identifies the chosen view and provides a per-region Only arm at this preset checkbox. New regions can be saved and bound in one operation. Cancel, X and Escape stop active movement and never save a draft.
4. The existing PTZ side panel shows a compact view-verification status and Return to arming view. It uses the shared guarded preset control path, terminating tracking/centering before moving.
5. Referenced preset positions cannot be overwritten or deleted until unbound; renaming is allowed. Other presets and fixed-camera zones remain independent.
6. A capability limitation is shown as a limitation; it is not treated as successful automatic recovery. GB cameras without reliable verified position/arrival retain ordinary arming and explicit manual view checking.

## Persistence and boundaries

Source identity, geometry, preset definition, frozen reference, manual/scene revisions and motion epoch fence every save and recovery. External movement, stop failure, source replacement, changed preset definition, backend restart and stale evidence invalidate authorization. Shared physical cameras must not receive contradictory home definitions. No automatic preset creation is needed, avoiding cancellation/orphan side effects.

Known-view verification must be tested separately from the arbitrary projector. A near-identity matrix alone is insufficient; confidence, distributed evidence, stable observations and device position are required. Dynamic foreground and repeated texture need explicit negative tests. Receiving new packets does not prove fresh source pixels; paced replay/frozen-source detection remains a documented limitation, not silently solved by hashes or timestamps.

The source view can be unavailable while the camera is looking elsewhere. Paused coverage is a monitoring gap, not zero traffic. Important continuous guarding should use a fixed camera/panoramic channel for rules and a PTZ for details.

## Required acceptance

- Algorithm: same-view valid drift versus wrong view, zoom, occlusion, repetitive patterns, malformed/insufficient evidence; fixed oracle and reproducible results.
- Backend: authenticated frozen selection, preset fingerprint and actor checks, concurrent motion/save, new-region binding, shared-camera conflicts, delete/overwrite rejection, rename, stale status and restart recovery.
- UI: deliberate movement, cancel/stop, return, unsupported-device explanation, no false success, fixed-camera regression, desktop and tablet layouts.
- Hardware: actual ONVIF preset return with region persistence, departure and invalidation, repeat returns, service restart and cleanup. GB unsupported gating is not a passed GB automatic-recovery test.
- Release: focused tests, builds, source/artifact manifests, migration/downgrade guard and complete git diff including new files. Record passed, failed and untested cases separately.

Acceptance results are appended after running the candidate; this design section alone is not release approval.

## Algorithm acceptance on frozen fixtures

The offline replay evaluated `projectPresetView` on 45 frozen reference/current image pairs with 88 labeled regions. It reused the pinned outputs from the earlier BPU matcher run. No new BPU inference was run for this evaluation. Each decision applies to one region in one pair. Acceptance returns the region's registered coordinates unchanged.

| Fixture label | Regions accepted | Expected decision |
| --- | ---: | --- |
| Same view, registered region still visible | 29/34 | Accept |
| Different view, including pan or zoom away from the preset | 0/28 | Reject |
| Occluded, independently moving or ambiguous region | 0/26 | Reject |

The five same-view rejections came from two pairs. Extreme darkness accounted for three regions. In the other pair, the cabinet remained visible but occlusion elsewhere left too little distributed evidence to confirm the view, so both cabinet regions were rejected.

The independent fixture set contributed five of the 34 same-view positives. All five unchanged background regions passed despite changes elsewhere in the images. This 5/5 measures recovery of visible regions at a known view. Multiple regions share images and backgrounds, so these counts do not establish field acceptance or false-accept rates on new cameras.

The replay runner is [preset-view-replay.mjs](../test/ptz/preset-view-replay.mjs). On board 190, `test/results/preset-view-20261121/baseline/replay.json` records each decision and the SHA-256 hashes of the fixture manifest, matcher observations and verification code.

## Hardware and browser acceptance, 2026-11-21

The 190 candidate was exercised on the existing Hikvision camera through ONVIF. Its AI output temporarily used that source; a dedicated temporary preset and region were used, without operational rule/counter assignments.

- Creating and saving a new region with its preset binding succeeded through the browser. The reference image, original coordinates and preset definition survived page reload and backend restart.
- Both rightward and leftward departures hid the region and persisted an unmatched state with no active current points. Explicit return recovered the unchanged original coordinates in both repetitions. From the return's pending transition, these recoveries took approximately 18 and 21 seconds. This is bounded known-view recovery, not uninterrupted protection while moving.
- Backend restart invalidated the prior matched authorization before starting normal rule synchronization, then recovered after approximately 14 seconds. Merely reloading a page did not move the camera.
- Desktop and 768×1024 tablet flows were inspected in the in-app browser. Existing bindings were selected by default; movement required an explicit action. Region selection, the binding checkbox, undo, cancel and saved-state display were exercised. The tablet editor places its controls below the image; the formal-view description is one compact bar.
- The existing fixed-camera output retained its three regions, rule associations and running boarding counter. Its Arming action opened the original editor directly, without preset selection.
- A real unbind save exposed a runtime-revision conflict after background reconciliation. This was treated as a release blocker, not dismissed as a test artifact; the regression was reproduced before fixing it. The fix distinguishes immutable binding definitions from background verification revisions and fences newer unresolved negative evidence at commit. A failed save retains the draft and original binding.

The live temporary region did not generate alarm or counter events. Rule gating, counting continuity boundaries and configuration concurrency were verified by automated isolated tests, not a real intrusion trial. This run is not an eight-channel capacity recertification, an outdoor endurance test, or proof of compatibility with every ONVIF camera. GB sources without trustworthy position/arrival feedback remain manual-only. Paced old source pixels remain undetectable with certainty; receiver time is not camera exposure time.

### Final focused regression

The final backend concurrency suite passed 54/54 tests against an isolated PostgreSQL database. It covers binding-definition changes, delete/recreate, pending-to-matched updates, late negative evidence including same-state timestamp changes, actor/epoch/geometry fencing, restart invalidation and independent visual confirmations. A newer independently confirmed matched result can supersede an earlier pending refresh; unresolved negative evidence cannot be overwritten by an older save proof.

Related frontend tests passed 30 unique cases (the 29-case run plus one added launcher case, with the affected eight launcher tests and ten binding tests rechecked). Native optical-flow and scene-matcher tests passed 18/18. Frontend/backend type checks and production builds passed. Unchanged native/frontend artifacts were reused in the final backend-only repair only after source SHA equality checks. The release manifest excludes local test caches so a clean checkout does not depend on ignored files.

Final candidate4 was applied to 190. The in-app browser repeated explicit preset return, frozen editing, unchecking the binding and Save: the page reported saved and the scene binding disappeared from PG while the ordinary region remained. Cleanup then removed only the named temporary region/preset 1, preserved preset 32 and all other preset metadata, and restored the full AI overlay exactly to the SHA-verified original configuration. Other AI configurations and input-channel configuration were compared unchanged. No cleanup motion commands were issued; the camera remained at the saved original view. Audit/history was retained.

After restoration, the real GB AI output played again. Its Arming action opened the ordinary editor and explicitly explained that formal preset binding requires verified ONVIF position/stop feedback; no unsupported binding checkbox was offered. The in-app browser console contained no error entries during the focused UI run.
