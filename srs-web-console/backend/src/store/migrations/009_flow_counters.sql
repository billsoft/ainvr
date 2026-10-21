-- Config authority only. Passage facts stay in the independent analysis service.
CREATE TABLE flow_counters (
  counter_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision>0),
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE flow_counter_versions (
  counter_id TEXT NOT NULL REFERENCES flow_counters(counter_id),
  revision INTEGER NOT NULL CHECK(revision>0),
  document JSONB NOT NULL,
  actor TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(counter_id,revision)
);
CREATE INDEX flow_counters_assignment ON flow_counters((document->>'source_assignment_id'));
