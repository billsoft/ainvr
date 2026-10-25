-- Explicit per-device media peers; existing devices keep registered-peer behavior.
ALTER TABLE gb28181_devices ADD COLUMN media_ips JSONB NOT NULL DEFAULT '[]'::jsonb
 CHECK (jsonb_typeof(media_ips)='array' AND jsonb_array_length(media_ips)<=8);
