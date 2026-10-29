-- Advance only the untouched optional-service seed from 018. This is not a
-- model selection override: any user edit, audit, secret, custom field, enable,
-- description, pre-existing document, or different desired snapshot opts out.
-- PostgreSQL remains the version authority; do not rewrite 018 or applied state.
DO $$
DECLARE
  legacy_seed JSONB := '{
  "schema_version": "1.0",
  "enabled": false,
  "listen": {
    "host": "127.0.0.1",
    "port": 8400
  },
  "callers": [],
  "history": {
    "source": "ai-history"
  },
  "index_storage": {
    "volume_id": null,
    "relative_path": "ainvr/search-index"
  },
  "model": {
    "package_id": "siglip-so400m-i18n-full-int8"
  },
  "sampling": {
    "mode": "all",
    "channel_ids": [],
    "object": true,
    "scene": true,
    "object_interval_ms": 1000,
    "scene_active_interval_ms": 10000,
    "scene_static_interval_ms": 60000,
    "scene_change_min_interval_ms": 3000,
    "track_slots": 8
  },
  "limits": {
    "query_concurrency": 2,
    "http_workers": 4,
    "http_queue": 4,
    "producer_queue": 1,
    "producer_bytes": 134217728,
    "max_samples": 100000,
    "max_bytes": 1073741824,
    "retention_days": 30,
    "max_coverage": 100000,
    "max_searches": 1000,
    "search_ttl_s": 3600,
    "image_max_bytes": 8388608
  }
}'::jsonb;
  document_id BIGINT;
  previous_version INTEGER;
  next_version INTEGER;
  new_version_id BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('config_publish'));
  SELECT d.id, state.desired_version INTO document_id, previous_version
    FROM config_documents d
    JOIN config_service_states state ON state.service_name='search-service'
    WHERE d.service='search-service' AND d."group"='system' AND d.name='settings'
      AND d.config=legacy_seed AND d.description='智能录像搜索（默认关闭）'
      AND d.created_at=d.updated_at
      AND (SELECT count(*) FROM config_documents WHERE service='search-service')=1
      AND NOT EXISTS(SELECT 1 FROM config_audit_logs WHERE service='search-service')
      AND NOT EXISTS(SELECT 1 FROM config_secrets WHERE key_path LIKE 'search-service/%')
      AND EXISTS(
        SELECT 1 FROM config_versions initial
        JOIN config_snapshots snapshot ON snapshot.version_id=initial.id
        WHERE initial.published_by='migration'
          AND initial.change_summary='初始化智能录像搜索：保持关闭'
          AND initial.created_at=d.created_at AND snapshot.created_at=d.created_at
          AND snapshot.service=d.service AND snapshot."group"=d."group" AND snapshot.name=d.name
          AND snapshot.config=legacy_seed)
      AND EXISTS(
        SELECT 1 FROM config_versions desired
        JOIN config_snapshots snapshot ON snapshot.version_id=desired.id
        WHERE desired.version=state.desired_version
          AND snapshot.service=d.service AND snapshot."group"=d."group" AND snapshot.name=d.name
          AND snapshot.config=legacy_seed)
    FOR UPDATE OF d,state;
  IF document_id IS NULL THEN RETURN; END IF;

  LOCK TABLE config_versions IN EXCLUSIVE MODE;
  UPDATE config_documents SET config=jsonb_set(config,'{model,package_id}',to_jsonb('siglip2-base-full-int8'::text),false)
    WHERE id=document_id;
  SELECT COALESCE(MAX(version),0)+1 INTO next_version FROM config_versions;
  INSERT INTO config_versions(version,status,published_by,published_at,change_summary)
    VALUES(next_version,'published','migration',now(),'智能搜索未修改默认选型调整为 SigLIP2 Base 256；保持关闭')
    RETURNING id INTO new_version_id;
  INSERT INTO config_snapshots(version_id,service,"group",name,config)
    SELECT new_version_id,service,"group",name,config FROM config_documents ORDER BY service,"group",name;
  UPDATE config_service_states SET desired_version=next_version,status='pending',restart_required=false
    WHERE service_name='search-service';
  INSERT INTO config_audit_logs(actor,action,service,"group",config_name,version_before,version_after,detail)
    VALUES('migration','publish','search-service','system','settings',previous_version,next_version,
      '{"initial_default_only":true,"previous_package":"siglip-so400m-i18n-full-int8","package":"siglip2-base-full-int8","enabled":false}'::jsonb);
END;
$$;
