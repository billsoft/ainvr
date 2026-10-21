-- New storage is introduced alongside legacy tables. Legacy rows are retained
-- until the explicit conversion and operator confirmation flow is complete.
CREATE TABLE alarm_trigger_definitions (
  trigger_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version>0),
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE alarm_trigger_definition_versions (
  trigger_id TEXT NOT NULL REFERENCES alarm_trigger_definitions(trigger_id),
  version INTEGER NOT NULL CHECK(version>0),
  document JSONB NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(trigger_id,version)
);
CREATE TABLE alarm_arming_sources (
  source_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision>0),
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE alarm_arming_versions (
  source_id TEXT NOT NULL REFERENCES alarm_arming_sources(source_id),
  revision INTEGER NOT NULL CHECK(revision>0),
  document JSONB NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,revision)
);
CREATE TABLE alarm_trigger_assignments (
  assignment_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES alarm_arming_sources(source_id),
  trigger_id TEXT NOT NULL REFERENCES alarm_trigger_definitions(trigger_id),
  execution_version INTEGER NOT NULL CHECK(execution_version>0),
  document JSONB NOT NULL,
  compiled_rule JSONB,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX alarm_trigger_assignments_source ON alarm_trigger_assignments(source_id);
CREATE INDEX alarm_trigger_assignments_trigger ON alarm_trigger_assignments(trigger_id);
