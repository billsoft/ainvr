-- Keep deleted identity in the same authority row. A stale editor can never
-- address a newly created object with an old ID/version pair.
ALTER TABLE floor_plans ADD COLUMN deleted_at TIMESTAMPTZ;
