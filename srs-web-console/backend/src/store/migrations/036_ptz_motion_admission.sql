-- Admission is installed only after the consumer confirms the complete snapshot.
CREATE TABLE ptz_motion_scopes (
 source_id text NOT NULL, processor_id text NOT NULL,
 guard_epoch text NOT NULL, execution_digest text NOT NULL,
 snapshot_revision bigint NOT NULL, allowed boolean NOT NULL,
 installed boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(source_id,processor_id)
);
-- A complete publication also proves that removed/empty alias scopes no longer
-- run their older rules. Per-processor ACKs cannot establish this absence.
CREATE TABLE ptz_motion_guard_installations (
 resource_key text PRIMARY KEY, source_digest text NOT NULL,
 snapshot_revision bigint NOT NULL, installed boolean NOT NULL DEFAULT false
);
-- Introducing the protocol changes the execution snapshot, even without an author edit.
UPDATE alarm_configuration_revision SET revision=revision+1 WHERE singleton;
