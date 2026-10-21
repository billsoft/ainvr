-- Configuration authority stays in PostgreSQL. No spatial extension required.
CREATE TABLE alarm_zones (
  zone_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX alarm_zones_channel ON alarm_zones(channel_id);
CREATE TABLE alarm_zone_versions (
  zone_id TEXT NOT NULL REFERENCES alarm_zones(zone_id),
  version INTEGER NOT NULL,
  document JSONB NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(zone_id, version)
);
CREATE TABLE alarm_config_operations (
  actor TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(actor, operation_key)
);
