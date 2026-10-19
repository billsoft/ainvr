# AINVR tracking, motion and event delivery

Status: implementation in progress. Not deployed or accepted.

## Scope and acceptance

Implement independent modules inside the existing AI service for tracking,
motion estimation and line/region/dwell rules. Model adapters remain responsible
for model input/output transformations. Extend configuration, public results,
SEI, archive links and browser rendering together. Add asynchronous event
review and notification handling; they must never block the video worker.
Complete focused unit tests, integration tests, installation and actual browser
configuration, rendering and persistence checks before marking delivery done.
Preserve existing access-managed SRS bindings, recording and user configuration.

## Authoritative baseline

2026-10-19: remote /home/sunrise/ainvr, clean baseline c769bd7.
The public Detection has label_id but no track identity. ReusedChannelWorker
constructs original-coordinate FrameResult before result buffering, SEI and
archive. LocateAnythingBpuAdapter uses IsMultiOutput and the same InferOneFrame path.
The old InferPromptedFrame stub is not its production execution path.
Current JSON bbox is an object with x/y/w/h fields, not an array.
Do not break existing consumers by silently replacing the envelope.
Existing SEI payload budget must remain bounded.

## Contracts

- label_id is business identity; class_id is model-local; neither is track_id.
- A track identity includes channel and a new stream/tracking session epoch.
- Use source PTS for motion and dwell, never inference completion wall time.
- Reset state on stream generation, model/description or rule configuration
  changes; reject stale/out-of-order observations.
- Predicted positions are explicitly distinct from observed detections and must
  not create fabricated archive detections or rule crossings.
- Unknown confidence stays unknown (LocateAnything); do not synthesize 1.0.
- Motion units are normalized frame units/second or pixels/second. Physical
  speed requires calibration. This delivery does not claim physical collision
  detection from overlapping boxes.
- Finite line crossing, stable-side hysteresis, region entry/exit and dwell
  require confirmed observed tracks and bounded observation gaps.
- Store event IDs for idempotent delivery. Review and notification states are
  independent. Review unavailability is not approval; notifications must obey
  explicit configured destinations and policy.
- No outbound notifications without a user-configured authorized destination.
- Low sampling rates expose a reliability warning; motion prediction cannot
  manufacture intermediate observations.

## Work checklist

- [x] Inspect current source and configuration boundaries.
- [x] Add global assignment and finite geometry primitives with focused tests.
- [ ] Track lifecycle, velocity, bounded gaps, session reset and rule state.
- [ ] Strict configuration parsing and serialization; capability validation.
- [ ] Integrate both model worker paths and propagate identity to SEI/archive.
- [ ] Durable asynchronous events, review adapter and notification delivery.
- [ ] UI configuration, geometry editor, live overlay and event inspection.
- [ ] Integration/regression tests and bounded board runtime measurements.
- [ ] Transactional deployment, original-channel verification and browser QA.

## Initial implementation

analytics/assignment.hpp provides global one-to-one association with unmatched
tracks. This is a primitive, not a claim of implementing full ByteTrack.
analytics/geometry.hpp uses normalized original-frame coordinates, validates
simple polygons and distinguishes finite line crossing from line extension.
test/ai_port/analytics_core_test.cpp tests these boundaries without BPU jobs.

## Core verification 2026-10-19

Three standalone C++ suites passed on the S100P with address/undefined
behavior sanitizers and -Wall -Wextra -Werror. Covers global assignment,
finite segment geometry, lifecycle, PTS ordering, gap expiry, epoch IDs,
label isolation, hysteresis, region/dwell and strict config round trips.
These tests are not production integration, tracking accuracy or browser proof.
Core is not yet wired into channel config or workers. No service changed.

## ByteTrack integration checkpoint

The service source now links the pinned, adapted ByteTrack library. FrameAnalytics
selects ByteTrack for scored detections and explicitly reports motion association
for unscored outputs; a change of algorithm resets the tracking session.
Six standalone tests pass, including detection-to-rule identity, public JSON and
SEI roundtrip, low-score recovery and stream epoch reset.
This is not deployment acceptance. Detector candidate thresholds still need to
preserve low-score candidates separately from visible/archive detections.
Production build log: test/results/analytics/production-tracker-build.log.
UI configuration, durable event storage, async review/notifications and real-browser
acceptance remain incomplete. No production service has been replaced.

## Durable event failure isolation checkpoint

EventOutbox now catches delivery failures per record: a rejected event remains
on SSD for retry without starving later valid events. The board-side test verifies
offline persistence, replay after reopen, rejection of the first queued record,
delivery of the following record, and later recovery of the rejected record.
Evidence: test/results/analytics/outbox-failure-isolation.json.
No production service was restarted or deployed. Async VLM review, notification
delivery, complete UX cases and browser/deployment acceptance remain incomplete.
The existing LocateAnything executor generates geometry from an image/description;
it is not yet a verified general-purpose yes/no event review API. Review integration
must preserve event-frame evidence and handle executor availability explicitly.

## Rule vertex editing checkpoint

The source-coordinate rule editor supports pointer dragging and keyboard arrows
(0.1% steps, Shift 1%), clamped to the frame. Pointer release/cancellation ends
dragging; the drag click cannot append a spurious polygon vertex. SVG vertices
have keyboard focus and coordinate labels. Eight geometry/editor tests passed
including drag-release, no-extra-point, keyboard movement and boundary clamping.
Evidence: test/results/analytics/rule-edit-tests.log. This is component-test
evidence only; actual browser pointer/touch and video alignment remain unverified.

The full frontend `npm run build` (TypeScript plus Vite) also passed; log:
test/results/analytics/rule-edit-build.log. Existing auth import chunking warning
is non-fatal. Build artifacts have not been installed into production.

## Asynchronous job state checkpoint

EventStore now provides atomic queuing, lease claims and guarded completion for
independent review/notification stages. Two Mongo clients race in an isolated
collection; exactly one claims an attempt. Expired ownership can be replaced,
stale completion cannot overwrite a new result, and immutable event replay
preserves downstream state. Lease tokens are omitted from history responses.
Evidence: test/results/analytics/jobs-report.json. No notifications were sent.
This is state-store infrastructure, not completed model review or notification
delivery: evidence capture, policy gating, queue consumers, retry policy and
UI configuration still require integration and end-to-end verification. External
notification delivery must use event-ID idempotency; leases alone cannot ensure
exactly-once delivery across a crash after sending. No production deployment.

## Event provenance and archive association checkpoint

Events now carry the triggering source PTS/index/dimensions, model name, frozen
rule geometry and observed target data. Unknown confidence remains null. The
worker links event IDs only to the same visible track in the same source frame;
archive metadata preserves these IDs and tracking session through durable replay.
Evidence states distinguish awaiting_archive, archive_disabled, no_visible_target
and frame_mismatch. Awaiting is deliberately not a claim that an image exists:
archive sampling/capacity may skip it. No whole-frame review evidence capture or
VLM call is claimed by this checkpoint. Six ByteTrack/frame integration suites
passed, including provenance, no cross-frame link and archive-codec roundtrip.
Evidence: test/results/analytics/evidence-tests.log. Production is unchanged.

Browser attempt: cua.getTab for the existing AI channels page failed before
page access with kernel asset path error (Windows error 3). This is not a
page/application failure and supplies no browser acceptance evidence.

## Event status UI and service build checkpoint

The S100P production target ainvr_s100p_control_service built successfully with
the current event provenance and job-state changes (evidence-service-build.log).
Event history now renders review and notification states separately in Chinese,
exposes target/source-frame evidence details, distinguishes awaiting archive
from available evidence, and retains unknown confidence as unavailable. Unknown
future states do not imply success. The record timestamp is labelled service
record time rather than falsely asserting capture time. Details summaries join
the modal keyboard focus cycle. Ten event UI tests and TypeScript build passed
(event-status-tests.log and event-status-types.log). No production install yet.

## Asynchronous stage consumer checkpoint

EventWorker now polls bounded channel-scoped pending/expired jobs, atomically
claims ownership, invokes a cancellable/deadline-aware handler off the inference
thread, and commits outcomes only with valid ownership. Recovery attempts are
bounded; invalid handler outcomes fail closed. Exceptions in one job do not
starve later jobs. Stop joins the owned thread; handlers must obey transport
deadlines and cancellation (there is no unsafe detached timeout thread).
Two independent Mongo clients/consumers passed an isolated integration test for
claim races, expired-owner recovery, per-job failure, channel/stage isolation
and completed-job exclusion. Evidence: event-worker-report.json under
test/results/analytics/. Handlers were fixtures: no BPU inference or notification
was performed. Worker is not yet connected to the production channel manager.
Production adapter, evidence capture, configuration/policy, notifications,
deployment and browser acceptance remain required.

## Production snapshot path audit correction

Inspection found that the active SnapshotStore AppendWrite and SavePending /
ReadPending paths did not preserve track_id, despite the separate archive-document
and archive-codec helpers doing so. Both active paths now include track_id; old
pending records default to an empty identity. The existing pending roundtrip
fixture was extended to verify identity and legacy compatibility. Its focused
reference-test build is in progress (snapshot-identity-build.log); actual Mongo
archive and hardware runtime acceptance are still required. Earlier codec-only
checks must not be read as proof of the active SnapshotStore path.

## Original event evidence retrieval checkpoint

The focused SnapshotStore pending roundtrip test passed, including track_id and
legacy absence (snapshot-identity-tests.log). EventStore::LoadEvidence reads only
a snapshot matching channel, event ID, tracking session, track ID and exact
source PTS, then returns original_image JPEG bytes/dimensions. It has no latest
frame or enhanced-image fallback; missing evidence returns empty and duplicate
matches fail as ambiguous. An isolated real-Mongo test passed identity mismatch,
missing, exact match, invalid PTS and ambiguous-match cases. The test JPEG is an
envelope fixture only, not evidence of image decoding/model execution. Report:
test/results/analytics/evidence-read-report.json. Actual reviewer integration,
lookup indexing, image decode, policy/config/UI, notification delivery and final
production/browser acceptance remain incomplete. No production deployment.

## Hardware review-image preparation checkpoint

ReviewImage parses JPEG frame dimensions as metadata, verifies stored dimensions,
decodes with the existing JPU interface and uses Mali GLES for color/cropping and
Pillow-compatible RGB resize/normalization. No CPU image decoder/resizer was
introduced. A single bounded 640x320 fixture run on S100P passed with 301056 finite
values (3x224x448), and mismatched dimensions were rejected. Evidence:
test/results/analytics/review-image-report.json and review-image-hardware.log.
This validates only this hardware preparation path, not model inference, odd
image dimensions or pixel parity. Production review handler remains unconnected.

## Ordered Mongo queries and compound indexes

Audit found ordinary nlohmann::json alphabetically reordered BSON sort/index
keys, putting _id ahead of timestamp and channel_id. EventStore now uses
ordered_json for query options and index definitions. The new channel_time_v2
index preserves channel/time/id ordering; review and notification readiness
indexes support channel/status/lease-expiry filtering. Existing indexes remain
intact for a non-destructive rollout. A real isolated Mongo regression deliberately
opposes ID order and time order, verifying newest-first history and oldest-first
pending jobs along with ownership races and replay protection. Passed:
test/results/analytics/jobs-index-report.json. This is not production deployment
or full query-plan/performance acceptance; evidence lookup indexing and actual
review/notification integration remain outstanding.

## LocateAnything target-presence reviewer integration checkpoint

LocateReview now implements an EventWorker-compatible handler using exact original
archived evidence, JPU/GLES preparation, and the existing LocateAnything adapter.
The adapter exposes RunPreparedRgb with normalized tensor validation and stale
result clearing; ordinary video RunFrame delegates to the same generation path.
Model manifest validation, executor health checks, generation parsing and the
exclusive channel lease remain in force. Review explicitly means target_presence,
records temporal_rule_verified=false and never invents a confidence value.
Missing evidence or an occupied model is unavailable, not approval. All GPU
objects stay on the handler thread and deadline cancellation reaches generation.
This handler is not yet wired to channel configuration/production workers;
notification policy and UI must distinguish target confirmation from verification
of a temporal rule. Syntax check passed. The linked integration test is building;
no hardware inference or production deployment is claimed at this checkpoint.

The linked analytics_locate_review_test subsequently built and passed on S100P
with isolated Mongo access: cancellation before evidence access, missing evidence
without model load, invalid empty review description, and clearing stale geometry
before a rejected prepared-image request. Report: locate-review-report.json.
No neural inference was run. Event details now disclose target-presence-only
scope so approval cannot imply temporal rule confirmation; 11 event UI tests
and TypeScript checking passed (review-scope-ui.log, review-scope-types.log).
Actual model output validation, channel policy/queue wiring, shared-resource
scheduling, notifications, deployment and browser acceptance remain open.

## Channel review wiring checkpoint

Analytics configuration now round-trips an explicit optional review request
(enabled, installed absolute model path, target description, token bound,
timeout). Strict bounds reject invalid types/unknown fields and review without
persistent events. Channel start preflights the review model contract and requires
snapshot archiving. New event outbox records freeze review_request; successful
idempotent delivery queues review without resetting finished jobs. A channel-owned
EventWorker executes LocateReview using the frozen request and stops with the
channel. Review waits up to ten seconds for exact original archive evidence,
within its job deadline; generation cancellation maps to timeout, not approval.
Model occupancy still maps to unavailable; shared executor scheduling is not yet
implemented. Existing channels keep review disabled. Frontend type/form preserves
review fields without aliasing; four form tests and TypeScript checks passed.
Standalone strict config tests passed. Full service and async integration builds
are in progress (review-wiring-build.log); no production deployment or UI toggle
acceptance yet. Notification transport/policy and browser acceptance remain open.

The full ainvr_s100p_control_service build completed successfully. The linked
real EventWorker + LocateReview integration test passed against isolated Mongo:
missing original evidence reached unavailable after the bounded archive wait,
notification remained not_requested, and cancellation/stale-output cases passed.
Evidence: review-wiring-report.json. This does not prove source-video event to
archive to successful BPU review end-to-end behavior. No deployment was performed.

## Review configuration UI checkpoint

AnalyticsReviewSettings is now embedded in the channel wizard: explicit opt-in,
plain target description, bounded timeout, target-presence limitations, and
archive/event-persistence prerequisites. Backend health declares the supported
review capability; older/unknown services cannot enable a new request. Existing
requests can still be disabled when prerequisites disappear. No automatic
notification is promised. The existing installed model preset supplies the path;
users are not asked for device filesystem paths. Relative HBM paths resolve under
the service model root for preflight and become absolute in frozen event requests;
parent-directory traversal is rejected. Existing absolute paths remain supported.
Seven settings tests plus four form tests passed; frontend production build,
strict C++ config tests and worker syntax checking passed. Evidence:
review-settings-ui.log, review-settings-build.log,
review-settings-worker-syntax.log. Latest capability/path changes still require
full service rebuild before deployment. Actual browser, model inference and
notification acceptance remain incomplete; no production install was performed.

## Bounded webhook notification transport checkpoint

WebhookNotifier implements the EventWorker handler interface for an explicitly
configured HTTP(S) destination. By default it refuses delivery unless review is
approved. It sends an allowlisted event summary with review scope, never the
full event, image bytes, prompt or lease token. Event ID is the Idempotency-Key;
receivers must honor it to deduplicate delivery (exactly-once is not promised).
TLS uses libcurl verification defaults, redirects are disabled, response bytes
are capped, and embedded URL credentials/fragments are rejected. Each attempt
has an overall timeout within the job deadline. At most three attempts retry
connection/transport failures, 408/429 and 5xx; permanent HTTP errors fail without
retry. No endpoint or response body is persisted in outcome details.
Loopback-only receiver acceptance passed retry equality/idempotency, rejected
review states with zero requests, non-retried 400, blocked redirect, oversized
response, deadlines/cancellation and endpoint validation. Evidence:
test/results/analytics/webhook-report.json; reusable receiver test:
test/analytics/test_analytics_webhook.py. No external notification was sent.
Transport compilation passed; production config, policy-driven queuing after
review, notification UI and live/browser acceptance still remain incomplete.

## Notification policy and channel lifecycle checkpoint

Config now includes explicit notification opt-in, endpoint and require_review
(default true). Strict parsing requires event persistence and an enabled reviewer
when review gating is selected. Start validates the HTTP(S) destination without
sending. Events freeze their notification request; a channel-owned notification
worker is started only when configured and stopped with the channel. Its Mongo
scheduler promotes only eligible unsent records: waiting review, pending after
approval/direct opt-in, or suppressed for rejected/failed/timed-out/unavailable
review. Terminal records are never reset by scheduler/outbox replay. History
responses omit notification endpoints; worker queries retain them for delivery.
Stopping/disabling the consumer leaves durable pending work; later enable resumes
frozen requests, including their original destination, so UI must disclose this.
Isolated Mongo policy test passed eligibility, suppression, later promotion,
redaction and terminal replay. A real loopback receiver test also passed Mongo
scheduling -> EventWorker -> WebhookNotifier -> HTTP receipt -> sent persistence;
replaying the event produced exactly one receiver request in this controlled test.
Evidence: notification-policy-report.json and notification-worker-report.json.
No external notification or production install occurred. Full service build is
running in notification-wiring-build.log. Notification settings UI, actual media
and review end-to-end checks, deployment and browser acceptance remain required.

## Notification settings UI and browser access checkpoint

The preceding notification-wiring full service build completed successfully.
Notification settings now expose explicit opt-in, review-gated/default versus
direct policy and an HTTP callback destination. Prerequisites, direct-mode false
positive risk, receiver idempotency and frozen backlog behavior are disclosed.
Unknown/older services cannot enable new notifications; existing settings can
still be disabled. URL validation rejects unsupported schemes, embedded login,
fragments and line breaks. No automatic test notification is emitted.
Twenty-three notification/review/form tests and frontend production build passed
(notification-settings-ui.log, notification-settings-build.log). A new health
capability flag was added after that service build and needs rebuilding before
release. No production install was performed.
App-browser automation still fails initializing its kernel assets. An isolated
local Chrome/CDP browser successfully opened the real AINVR URL and observed its
password login screen; this establishes an alternative browser-test path only,
not authentication or feature acceptance. No production settings were changed.

### Reference-frame editing safety checkpoint
Spatial rule edits now require a successfully loaded reference image with valid
dimensions. Blank/unloaded/failed images cannot accept point movement, redraw,
undo or geometry type changes. Existing coordinates remain intact; naming and
deletion remain available. Changing the source clears the captured reference
and old video handle. Capture/upload resets readiness until image load succeeds.
Rule editor plus channel wizard: 43 tests passed; frontend production build
passed (reference-editor-ui.log, reference-editor-build.log under
test/results/analytics). Fresh core/tracker/config build and three CTest cases
passed. These are source/component checks, not deployed browser acceptance.
No production installation or channel configuration change was made.

### Four-step processor wizard checkpoint
The wizard now has Basic, Model, Tracking/Rules, and Output steps. Tracking,
review and notification controls are separate from output selection. Analytics
validation runs before advancing from step 3 and at final submission (returning
to the relevant step on error). Disabled tracking preserves existing rules.
Thirty-nine wizard tests plus sixty-nine form, parallel-channel and reference
editor tests passed; production frontend build passed. Evidence:
test/results/analytics/four-step-{wizard,regression,build}.log.
Existing SRS ownership/conflict checks remain covered. No production install
or browser acceptance is claimed by these component tests.

### No-confidence motion association: Kalman wiring
Tracker::Process now maintains per-track constant-velocity Kalman state in
source-time seconds. Prediction advances from its own last filter timestamp,
including empty observation frames; corrections use actual detection boxes.
Expiration and session reset discard filter state. Predicted geometry is used
only for association: returned boxes/anchors and rule evaluation still use
observations, and missing frames do not emit rule events. Published velocity
remains observed bottom-center displacement per source second, not mislabeled
as filtered velocity. ByteTrack identities are still consumed without another
association pass. Three basic CTest suites passed, including short-occlusion
reacquisition, stale PTS rejection, no predictive crossing, and expiration.
This supersedes the earlier note that motion_filter.hpp was unused on the
no-confidence path. Camera accuracy and production rollout remain unverified.

### Read-only LocateAnything PC reference review
Reviewed D:/code/LocateAnything-3B tracker.py, crossing.py, ARCHITECTURE.md,
reid.py and counting evaluation/tests. The 51 unittest cases in test_gatecounter
and test_evaluate_counting passed (python -B; no model loaded/source modified).
Useful references: source-time Kalman association, physical and Mahalanobis
gates, quality-sensitive observations, strict corridor transaction evidence,
separate identity/geometry gaps, no predicted-point counting, and event-level
evaluation. Preserve semantic differences: PC uses filtered bbox center; AINVR
rules use observed bottom-center. PC final counts depend on offline stitching
and replay; its once-per-identity/direction policy must not silently become
AINVR repeated-pass semantics. ReID defaults to CUDA/OSNet and requires separate
BPU conversion/validation before use on S100P.
Eight subtest clips were inspected with local OpenCV metadata: seven open as
1920x1080 at approximately 25fps. Candidate short fixture:
193-0720/问题视频/subtest_16-43_clip_2m40s-3m00s.mp4 (20.09 sec,
49,023,670 bytes); subsequent 32-second clips are also available. This is only
container/metadata inspection, not full decode or tracking accuracy acceptance.
subtest_08-13_from8m28.mp4 fails opening with moov atom not found; exclude until
recovered or replaced from source. Ground truth still needs verification/manual
annotation before counting accuracy claims; do not use model results as truth.

### Real-video fixture inspection
The 20-second PC corridor clip was copied to SSD with matching SHA-256, see
test/results/analytics/corridor-fixture-inspection.json. Local OpenCV full read
and board ffprobe independently yield 499 decoded frames vs 502 container
frames. Codec is MPEG-4 Part 2, not H264/H265; do not treat it as a verified
production VPU input. Contact-sheet inspection shows successive similarly
dressed pedestrians, partial occlusion and fisheye distortion. Manual event
annotation and a separately hashed compatible derivative remain required.
No camera channel, recording, SRS binding or production service was changed.

Track metadata now includes exact-string last_observed_pts_ns, observation_age_ms
and geometry_source=last_observation. Missing-target bbox remains the last
observation, never current-frame prediction. Six integration CTest cases passed
(provenance-test.log), including timestamps beyond the double integer precision
limit, missing observations, reacquisition and no events on missing frames.

### Hardware corridor fixture checkpoint (2026-10-19)
Prepared H264 derivative preserves all 499 decodable source frames and relative
PTS (fixture-h264-verification.json); preparation is offline software only.
The first 100 frames now pass the current production VpuDecoder/MediaSource
wrapper: 100 unique tokens, complete EOS drain, maximum source PTS difference
496 ns against ffprobe decimal timestamps, NV12 pixel MAE 0 against offline
software reference. Evidence: test/results/analytics/vpu-20261019-104725/summary.json.
No production channel/configuration/service restart was performed; ainvr-ai
remained active. This is decode evidence only, not tracking/counting acceptance.
Initial attempt vpu-20261019-104625 failed with Unsupported video codec because
the old probe build recipe linked system FFmpeg against objects compiled with
FFmpeg 8.1.2 headers. Rebuilding the probe against the production FFmpeg 8.1.2
libraries resolved it. Preserve the failed evidence; use matching dependencies
for subsequent probes. Reproduction: test/results/analytics/verify_corridor_vpu_ffmpeg8.py.
PC reference correction: current crossing.py resets transactions after a completed
pass and uses spatial/time deduplication; its once-per-identity class docstring is
stale. Do not use that docstring or the earlier review note as current behavior.

### Real BPU-to-tracking smoke (2026-10-19)
Added test/ai_port/corridor_analytics_probe.cpp. It consumes verified VPU NV12
frames and their source PTS, executes the installed YOLO26x HBM through the
production adapter, decodes separate 0.10 tracking/0.25 visible candidates,
and calls FrameAnalytics and CopyTrackIdentities. No production config changed.
Build recipe: test/results/analytics/build_corridor_probe.py (uses production
include/link dependencies); build logs corridor-adapter-build.log and
corridor-probe-build.log. HBM SHA256:
65e2cd362771a616c39a5d55b5fd520cb8a0f78112bd389a284179effd75948d.
Report: test/results/analytics/corridor-bpu-tracking-v1.json; runtime log sibling
.log. Twenty frames sampled every five source frames from the first 100 frames:
16 visible detections, seven carrying the same stable track ID at indices
65/70/75/80/85/90/95. Actual preprocessing backend pym+gles-color, BPU runtime
reported HBRT 4.7.5. Source lacks color metadata; BT601 limited default explicit.
Other visible detections remain unassociated; ByteTrack creation threshold is
0.6 and tentative confirmation differs from display threshold. Two detections
are labeled boat; this is detector output, not manually verified ground truth.
This PASS proves a real hardware detector/online tracker smoke only. It does
not prove people-count accuracy, occlusion recovery, region events, SEI player,
Mongo persistence or deployment. No rules were configured in this smoke.
Production ainvr-ai remained active throughout; no restart or recording change.

### Full-video sampling sensitivity (2026-10-19)
VPU probe now accepts an optional bounded maximum of 1..500 frames, retaining
120 default for existing tests. Full 499-frame source passed EOS/token/PTS
and pixel oracle checks (max PTS decimal rounding error 500ns, pixel MAE 0):
test/results/analytics/vpu-20261019-110028/summary.json. SSD raw output retained.
Corridor analytics probe supports explicit stride 1..25 (default 5), bounded
500 input frames, and a test-only person line x=.5,y=.25..9. Current production
configuration was not modified. Full-video reports:
- corridor-bpu-tracking-full-v2.json: 100 samples at stride5, 5 line events.
- corridor-bpu-tracking-full-stride1-v3.json: 499 samples at stride1, 6 line events.
- corridor-sampling-comparison.json: strict monotone source PTS, expected
  hardware backend, unique visible IDs per frame and person-only line events.
A contact-sheet review around frames230..300 identified a fragmented pedestrian:
stride5 ID9 disappeared near crossing and ID19 appeared after crossing, losing
that event. Stride1 emits an additional event at frame285 / 11.405s. This is
sampling sensitivity evidence, not complete manual ground-truth acceptance;
all identities and other events still need visual verification. Do not claim
6/6 accuracy solely because totals match a visual impression.
Important UX implication: low-frequency VLM sampling cannot silently promise
reliable crossing counts. Detector sampling and actual source-frame gaps must
be visible; predictions must not fabricate the missing passage.
No service restart, camera configuration or SRS change; ainvr-ai verified active.
Reproduction scripts are in test/results/analytics/verify_corridor_vpu_full.py,
build_corridor_probe.py and compare_corridor_sampling.py; source probes are in
test/ai_port. No CPU model inference was used; software decode is oracle only.

### User-directed line placement comparison (2026-10-19)
User requested moving the counting line rightward by 20% of image width toward
the stairs. Tested normalized x=.7 (previous .5), preserving y=.25..9 and
observed bbox bottom-center anchor. Probe now accepts optional line_x, default
.5 for reproducibility, and records rule geometry/anchor in each new report.
At the same stride5 (~5fps), corridor-bpu-line70-stride5-v4.json generated six
same-direction events versus five at center. Controlled comparison verified
all visible boxes, scores, classes and source PTS exactly equal between runs:
see corridor-line-position-comparison.json. Previously lost ID9 now crosses at
10.605s before fragmentation, instead of failing to register the later center
crossing. This improves event timing/placement, not model detection accuracy.
Keep both reports; manual identity/event annotation still incomplete. No claim
of complete traffic-count accuracy or generalization to other scenes.
Production zone configuration was not changed; ainvr-ai remained active.

### Sampling and counting-anchor UX checkpoint (2026-10-19)
Tracking step now shows configured source detection interval (or follow-source
mode), explicitly distinguishes actual processing capacity, and explains that
sparse detections may miss a crossing. Prediction is described as association
support, not evidence for fabricated events. Rule editor documents observed
bbox bottom-center anchor and placement in a complete/less-occluded view.
Wizard tests cover 5fps, 0.5fps and follow-source mode plus disabling tracking.
47 wizard/editor tests passed (sampling-guidance-ui.log); production frontend
build passed (sampling-guidance-build.log). Not deployed in this checkpoint.
CUA still fails initializing kernel assets. The previously isolated Chrome CDP
review browser is alive on its DevToolsActivePort; DOM inspection confirms real
AINVR /ai-channels currently displays access-password login. No feature browser
acceptance claimed and no authentication configuration changed. Local review
helper: D:/codex-task-staging/ainvr-analytics/inspect-review-browser.mjs.


### 2026-10-19 real asynchronous neural review checkpoint

- Built `test/ai_port/analytics_neural_review_probe.cpp` against the production S100P libraries. Real isolated Mongo event/evidence -> EventWorker -> JPU/GLES preprocessing -> BPU executor -> durable review result executed.
- First root-run test failed before inference because the secure channel lock belongs to sunrise. Preserved `test/results/analytics/neural-review-20261019-112349.json` and diagnostic log `neural-review-20261019-112536.log`. Lock protection was not weakened; corrected test execution identity to production service user sunrise.
- Authoritative result: `test/results/analytics/neural-review-20261019-112623/result.json`, execution restoration evidence alongside it. Person image approved (4 boxes; inference 4724.88 ms). Visually empty corridor image incorrectly approved (2 boxes; inference 21337.08 ms). Semantic acceptance FAILED. These timings are only these two calls, not steady-state throughput.
- AI was stopped only for bounded exclusive model access and restored in Python finally; recorder stayed active. Synthetic unique test-channel evidence collection was removed by test cleanup; isolated event records retained. No notification sent and no production channel configuration changed.
- The review plumbing works, but false-positive cause remains unresolved: must compare JPU/GLES tensor with reference and inspect generated geometry before attributing it to model quality. Do not advertise this reviewer as a reliable false-alarm filter or mark full deployment/browser acceptance complete. Resident executor scheduling with the existing LocateAnything channel also remains outstanding.
