-- Search control state only. Images, vectors and query results belong in the
-- history store, never in the eMMC parameter database.
CREATE TABLE search_jobs (
  id UUID PRIMARY KEY,
  actor TEXT NOT NULL,
  request_key UUID NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('index','rebuild','verify')),
  payload JSONB NOT NULL CHECK (octet_length(payload::text) <= 16384),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','failed','cancelled')),
  generation INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner UUID,
  lease_until TIMESTAMPTZ,
  result_ref TEXT CHECK (length(result_ref) <= 256),
  error_code TEXT CHECK (length(error_code) <= 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE(actor, request_key),
  CHECK (expires_at > created_at),
  CHECK ((state = 'running') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX search_jobs_claim ON search_jobs(kind,created_at) WHERE state IN ('pending','running');
CREATE INDEX search_jobs_expiry ON search_jobs(expires_at);

CREATE TABLE search_index_shards (
  id UUID PRIMARY KEY,
  channel_id UUID NOT NULL,
  model_version TEXT NOT NULL CHECK (length(model_version) BETWEEN 1 AND 128),
  day DATE NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('pending','building','ready','failed','deleting')),
  manifest_key TEXT CHECK (length(manifest_key) <= 256),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(channel_id,model_version,day)
);
