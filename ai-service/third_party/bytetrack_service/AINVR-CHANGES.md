# Service adaptation
Derived from ../bytetrack at the commit recorded in UPSTREAM.json.
MIT license retained. The sibling directory remains unmodified for comparison.
Changes: atomic saturating IDs; replace process exits with exceptions;
correct allocation element counts; discard obsolete removal history.
This is not yet the production adapter: source-time dynamics, label isolation,
candidate bounds and integration remain required.

Source-time adaptation adds update_at with strictly increasing source timestamps,
time-based expiry before matching (including previously active tracks), and Kalman
transition scaled by elapsed nominal intervals. Process noise is scaled linearly
with elapsed intervals; this is an explicit approximation requiring real-video
evaluation, not a claim of identical covariance to repeated discrete updates.
The frame-count API remains for upstream regression comparison.
Reference lifecycle and source-time tests live in test/bytetrack.
