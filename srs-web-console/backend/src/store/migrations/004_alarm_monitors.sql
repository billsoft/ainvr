-- PG is authoritative; alarm-service receives immutable, versioned snapshots.
CREATE TABLE alarm_configuration_revision (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  revision BIGINT NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
INSERT INTO alarm_configuration_revision(singleton,revision) VALUES(TRUE,0);
CREATE TABLE alarm_monitors (
  monitor_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX alarm_monitors_channel ON alarm_monitors(channel_id);
CREATE TABLE alarm_monitor_versions (
  monitor_id TEXT NOT NULL REFERENCES alarm_monitors(monitor_id),
  version INTEGER NOT NULL,
  document JSONB NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(monitor_id,version)
);
