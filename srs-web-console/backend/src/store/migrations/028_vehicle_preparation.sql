-- Bounded configuration only; never store snapshots, passages or model outputs here.
CREATE TABLE vehicle_preparation (
  id text PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  document jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
