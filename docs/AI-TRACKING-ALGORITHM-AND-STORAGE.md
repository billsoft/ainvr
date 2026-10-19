# Tracking algorithm and retention decisions — 2026-10-19

Implementation target remains full tracking/motion/rules, asynchronous review
and notification, deployment and real browser acceptance.

## Algorithms

First production selection: ByteTrack for scored, sufficiently frequent
detections from fixed-camera YOLO/YOLOE. Add proper Kalman motion filtering,
high/low confidence association and lifecycle reference tests before exposing
the ByteTrack name. Current analytics/tracker.hpp is a basic normalized-motion
global-assignment baseline, NOT complete ByteTrack. Do not ship it mislabeled.
OC-SORT is a later comparison option for nonlinear motion. BoT-SORT/ReID requires
additional appearance/model and camera-motion hardware validation.
LocateAnything's unknown score must not be fabricated; expose a clearly named
motion association mode, with low-cadence reliability warning, or disable an
incompatible algorithm. Never silently claim ByteTrack low-score recovery.

Primary references:
- https://github.com/FoundationVision/ByteTrack
- https://github.com/noahcao/OC_SORT
- https://github.com/NirAharon/BoT-SORT
- https://github.com/nwojke/deep_sort

## UI

AI processor configuration: tracking enabled, compatible installed algorithm,
tracked labels, lost timeout, confirmation parameters in advanced controls.
Rules have interactive finite-line/polygon editing.
Preview controls separately toggle boxes, target IDs and trajectories;
trajectory duration defaults to 10 seconds and has a bounded point count.
Use full session-qualified IDs internally, short numbers for display.
This is browser-local display state, no service restart. Missing tracking
metadata means unavailable, never fabricate a trajectory from label identity.
Draw observed paths solid; any prediction is distinct and must not count events.

## Retention and transport

Live association state: bounded per-channel RAM, not database round trips.
Live previews: video-frame-aligned SEI plus a bounded browser ring buffer.
Keep SEI small: current detections/track IDs only, no entire path/event history.
MongoDB: asynchronous track summaries, segmented/downsampled trajectory points,
rule events, review/delivery state. Unique event IDs and track+segment keys make
retries idempotent. Compound channel/time/track/rule indexes and separate
retention policies; never grow one track document indefinitely.
Default proposed retention: event-associated trajectories; optional all-track
recording and explicit retention in UI. Events persist independently of viewer.
Durable local outbox absorbs database outages; bounded capacity, visible health
and explicit gap reporting. No silent loss or blocking image inference.
Review/notification consumers reference an event and evidence; no outbound
delivery until an explicit destination is configured.

## Current implementation progress

Core geometry, assignment, lifecycle, motion, line/region/dwell primitives,
strict configuration, FrameResult/API and SEI track identity, archive codec and
browser parser/drawing are now connected in source.
Core suites and frame/SEI/archive tests passed. Frontend wire regression: 43
tests passed. These are not tracking benchmark or browser-rendering acceptance.
Full service compilation succeeded; latest controller/archive changes are
under regression rebuild. Nothing has been installed or production-enabled.
Still required: complete ByteTrack, high/low-score candidate interface,
configuration/rule editor, live trail buffer, durable event and track storage,
asynchronous review/notification and failure tests, deploy/browser acceptance.
