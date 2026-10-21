-- Counters become a library (like triggers) bound to zones in each source's
-- arming. Additive only: the first-version flow tables stay so an earlier
-- console build still starts after a rollback.
CREATE TABLE flow_counter_definitions (
  counter_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version>0),
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE flow_counter_definition_versions (
  counter_id TEXT NOT NULL REFERENCES flow_counter_definitions(counter_id),
  version INTEGER NOT NULL CHECK(version>0),
  document JSONB NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(counter_id,version)
);
-- Rows are kept after a binding is removed (active=FALSE) so its history stays queryable.
CREATE TABLE flow_counter_bindings (
  binding_id TEXT PRIMARY KEY CHECK(binding_id LIKE 'flow-%'),
  source_id TEXT NOT NULL REFERENCES alarm_arming_sources(source_id),
  counter_id TEXT NOT NULL REFERENCES flow_counter_definitions(counter_id),
  execution_version INTEGER NOT NULL CHECK(execution_version>0),
  document JSONB NOT NULL,
  compiled_rule JSONB,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX flow_counter_bindings_source ON flow_counter_bindings(source_id);
CREATE INDEX flow_counter_bindings_counter ON flow_counter_bindings(counter_id);
