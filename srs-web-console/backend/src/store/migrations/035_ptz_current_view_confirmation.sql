-- Explicit operator confirmation, independent of document write timestamps.
-- No frame FK: receipt metadata survives routine frozen-image retention.
CREATE TABLE ptz_arming_confirmations (
 source_id text NOT NULL, processor_id text NOT NULL, resource text NOT NULL,
 epoch text NOT NULL, identity text NOT NULL, geometry_revision text NOT NULL, pose jsonb,
 scope_digest text NOT NULL, frame_id uuid NOT NULL, captured_at timestamptz NOT NULL,
 actor text NOT NULL, confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(source_id,processor_id)
);
