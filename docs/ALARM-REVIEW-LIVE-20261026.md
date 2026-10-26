# Alarm live updates and evidence review — 2026-10-26

## Delivered behavior

- The alarm list polls every three seconds without reloading the page. It reconciles the visible filter, retains loaded history and its paging cursor, preserves a scrolled anchor, and suspends list reconciliation during detail/confirmation/purge dialogs and uncertain acknowledgements. In-flight responses are fenced against filter changes and acknowledgements. The manual new-alarm/update banners are removed.
- Complete behavior evidence uses the main review worker, newest first, with all required real keyframes, the target crop and concise behavior/moment description. Predictions do not prove transitions. The actual model images and marked context images remain inspectable.
- Without a valid signed validation artifact this same pipeline records reference scores for each keyframe and does not acknowledge an alarm. A reference is tied to the evidence generation and input/prompt version; it does not prevent later qualified review. Human decisions retain priority.
- The legacy retained-image worker honors the trigger review flag and only serves incomplete/legacy evidence. It no longer races the main pipeline while keyframes are being captured. It cannot acknowledge alarms.
- Evidence crops use constant gray outside the source frame instead of repeated edge pixels. This is opt-in for review images; ordinary detection preprocessing keeps its existing default. The CPU test oracle matches the GPU option; production image work remains on GLES/JPU, model inference remains on BPU.
- Caller profile is now `target-context-zh-v3-border`; older validation artifacts cannot qualify it. Re-review previews select the latest prepared image for the same keyframe.
- Trigger UI explicitly distinguishes allowing AI analysis from validated automatic decisions. It does not imply that checking a box validates a model.

## Verification

- Frontend: 27 alarm-feed, 8 trigger-wizard, 2 purge, 1 definition-display tests passed (38 unique tests).
- Alarm service: 23 review/qualification/signing tests passed, including isolated real MongoDB tests; no skips in that run.
- LLM: 3 CTest cases passed, service and image-probe builds passed. CPU reference source syntax checked.
- S100P real JPEG -> JPU/GLES -> model-input probe: 896x448, 35,040 out-of-frame pixels checked as neutral gray; visual inspection confirms removal of stretched edge content.
- Production: current profile completed real two-frame analyses; LLM ready and successful calls observed. Browser observed new records appearing without clicking refresh; detail dialog remained usable. No production alarm was manually acknowledged or deleted by this test.
- Frontend build and git diff whitespace checks passed. Existing bundle-size warnings remain.

## What is NOT validated

Automatic confirmation/rejection remains unavailable: `/etc/ainvr/review-validation.json` and its public key are absent. No artifact was fabricated. Existing measured classifier false negatives are a reason to require an independently labeled, representative dataset for the current input profile and thresholds. Repeated frames of the same video and scores near one are not that validation. No claim of model accuracy qualification or full automatic-review acceptance is made.

The model checks visual category; rule geometry, dwell and direction are verified by the behavior engine. A target outside the original camera frame cannot be reconstructed by padding. Multi-person ambiguity, reflections/screens and clipped targets remain important validation cases.

## Deployment and rollback

Installed on 192.168.100.189; port 80 and 8088 share the frontend. Only alarm/reference and LLM services were restarted; AI and recorder were not restarted. Definitions, arming, historical decisions and video were retained. No commit/push was performed.

Board-local rollback artifacts are under `/home/sunrise/ainvr/test/results/alarm-live-20261026/` (ignored test outputs, not portable release assets): `index.before.html`, `review-worker.before.mjs`, `reference-review.before.mjs`, `repository.before.mjs`, `review-prompt.before.mjs`, `ainvr_llm_service.before`. Restore these to their recorded service paths, restarting only the corresponding new workers/LLM; never delete alarm history for rollback. See `systemctl cat ainvr-alarm ainvr-review-reference ainvr-llm` for active release paths. New frontend assets are retained for open browser tabs.
