CREATE TABLE floor_plans (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK (version > 0),
  document JSONB NOT NULL CHECK (octet_length(document::text) <= 524288),
  image JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL, updated_by TEXT NOT NULL
);
CREATE UNIQUE INDEX floor_plans_image_ref ON floor_plans ((image->>'ref')) WHERE image IS NOT NULL;
CREATE TABLE floor_plan_operations (
  actor TEXT NOT NULL, operation_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(actor,operation_key)
);
