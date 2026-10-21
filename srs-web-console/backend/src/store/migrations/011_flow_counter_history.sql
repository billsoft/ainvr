-- Installations that applied an earlier 010 lost the first-version flow tables.
-- Recreate them empty so a rollback to that console build still starts.
CREATE TABLE IF NOT EXISTS flow_counters (
  counter_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision>0),
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS flow_counter_versions (
  counter_id TEXT NOT NULL REFERENCES flow_counters(counter_id),
  revision INTEGER NOT NULL CHECK(revision>0),
  document JSONB NOT NULL,
  actor TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(counter_id,revision)
);
CREATE INDEX IF NOT EXISTS flow_counters_assignment ON flow_counters((document->>'source_assignment_id'));
-- Counting-line history: each version applies from effective_from until the next
-- one. A version with reclassify=TRUE replaces every earlier one (explicit recount).
CREATE TABLE flow_counter_binding_versions (
  binding_id TEXT NOT NULL REFERENCES flow_counter_bindings(binding_id),
  seq INTEGER NOT NULL CHECK(seq>0),
  direction JSONB NOT NULL,
  reclassify BOOLEAN NOT NULL DEFAULT FALSE,
  actor TEXT NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(binding_id,seq)
);
INSERT INTO flow_counter_binding_versions(binding_id,seq,direction,reclassify,actor,effective_from)
  SELECT binding_id,1,document->'direction',FALSE,'migration',created_at FROM flow_counter_bindings;
