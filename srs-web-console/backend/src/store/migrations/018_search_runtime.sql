-- Parameter/control state only. Images and embeddings remain in history Mongo.
CREATE TABLE search_runtime_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  desired_version INTEGER NOT NULL CHECK(desired_version > 0),
  revision TEXT NOT NULL CHECK(revision ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK(status IN ('applied','failed')),
  error_code TEXT CHECK(error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A newly introduced optional service starts disabled. Existing documents,
-- service versions, channels and histories are preserved. Provision no secrets
-- until an administrator explicitly saves this category.
INSERT INTO config_documents(service,"group",name,config,description)
VALUES('search-service','system','settings','{
  "schema_version":"1.0","enabled":false,
  "listen":{"host":"127.0.0.1","port":8400},"callers":[],
  "history":{"source":"ai-history"},
  "index_storage":{"volume_id":null,"relative_path":"ainvr/search-index"},
  "model":{"package_id":"siglip-so400m-i18n-full-int8"},
  "sampling":{"mode":"all","channel_ids":[],"object":true,"scene":true,
    "object_interval_ms":1000,"scene_active_interval_ms":10000,"scene_static_interval_ms":60000,
    "scene_change_min_interval_ms":3000,"track_slots":8},
  "limits":{"query_concurrency":2,"http_workers":4,"http_queue":4,"producer_queue":1,
    "producer_bytes":134217728,"max_samples":100000,"max_bytes":1073741824,
    "retention_days":30,"max_coverage":100000,"max_searches":1000,
    "search_ttl_s":3600,"image_max_bytes":8388608}
}'::jsonb,'智能录像搜索（默认关闭）')
ON CONFLICT(service,"group",name) DO NOTHING;

-- Publish only this new service's initial disabled definition. The snapshot is
-- complete, following PgConfigStore.publish; other services' desired/applied
-- versions do not move. The native service may ACK disabled without models/SSD.
DO $$
DECLARE next_version INTEGER; new_version_id BIGINT;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM config_service_states WHERE service_name='search-service' AND desired_version IS NOT NULL) THEN
    LOCK TABLE config_versions IN EXCLUSIVE MODE;
    SELECT COALESCE(MAX(version),0)+1 INTO next_version FROM config_versions;
    INSERT INTO config_versions(version,status,published_by,published_at,change_summary)
      VALUES(next_version,'published','migration',now(),'初始化智能录像搜索：保持关闭') RETURNING id INTO new_version_id;
    INSERT INTO config_snapshots(version_id,service,"group",name,config)
      SELECT new_version_id,service,"group",name,config FROM config_documents;
    INSERT INTO config_service_states(service_name,desired_version,status,restart_required)
      VALUES('search-service',next_version,'pending',false)
      ON CONFLICT(service_name) DO UPDATE SET desired_version=EXCLUDED.desired_version,status='pending',restart_required=false;
  END IF;
END;
$$;
