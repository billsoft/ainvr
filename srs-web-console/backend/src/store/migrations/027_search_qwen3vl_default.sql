-- Advance only the untouched optional-service seed (018 -> 020 result) to the Qwen3-VL-Embedding-2B package.
-- Like 020 this is NOT a model selection override: any user edit, enable, description change, secret, custom
-- field, pre-existing extra document, non-migration audit entry or different desired snapshot opts out.
-- Installed deployments move through the explicit operator cutover (deploy-package/search_fresh_model_cutover.mjs),
-- which also clears the old vector space. 2048-d vectors need a smaller default sample cap (62,500 fit the
-- 128M-float exact projection), so max_samples is advanced together with the package.
DO $$
DECLARE
  legacy_seed JSONB := '{
  "schema_version": "1.0",
  "enabled": false,
  "listen": {"host": "127.0.0.1", "port": 8400},
  "callers": [],
  "history": {"source": "ai-history"},
  "index_storage": {"volume_id": null, "relative_path": "ainvr/search-index"},
  "model": {"package_id": "siglip2-base-full-int8"},
  "sampling": {
    "mode": "all", "channel_ids": [], "object": true, "scene": true,
    "object_interval_ms": 1000, "scene_active_interval_ms": 10000, "scene_static_interval_ms": 60000,
    "scene_change_min_interval_ms": 3000, "track_slots": 8
  },
  "limits": {
    "query_concurrency": 2, "http_workers": 4, "http_queue": 4, "producer_queue": 1, "producer_bytes": 134217728,
    "max_samples": 100000, "max_bytes": 1073741824, "retention_days": 30, "max_coverage": 100000,
    "max_searches": 1000, "search_ttl_s": 3600, "image_max_bytes": 8388608
  }
}'::jsonb;
  document_id BIGINT;
  previous_version INTEGER;
  next_version INTEGER;
  new_version_id BIGINT;
  target JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('config_publish'));
  SELECT d.id, state.desired_version INTO document_id, previous_version
    FROM config_documents d
    JOIN config_service_states state ON state.service_name='search-service'
    WHERE d.service='search-service' AND d."group"='system' AND d.name='settings'
      AND d.config=legacy_seed AND d.description='智能录像搜索（默认关闭）'
      AND (SELECT count(*) FROM config_documents WHERE service='search-service')=1
      AND NOT EXISTS(SELECT 1 FROM config_audit_logs WHERE service='search-service' AND actor<>'migration')
      -- Untouched since migration 020 published it: the document timestamp is that migration's own transaction time.
      AND EXISTS(SELECT 1 FROM config_audit_logs a WHERE a.service='search-service' AND a.actor='migration' AND a.action='publish'
        AND a."group"='system' AND a.config_name='settings' AND a.version_after=state.desired_version AND d.updated_at=a.created_at
        AND a.detail='{"initial_default_only":true,"previous_package":"siglip-so400m-i18n-full-int8","package":"siglip2-base-full-int8","enabled":false}'::jsonb)
      AND NOT EXISTS(SELECT 1 FROM config_secrets WHERE key_path LIKE 'search-service/%')
      AND EXISTS(
        SELECT 1 FROM config_versions desired
        JOIN config_snapshots snapshot ON snapshot.version_id=desired.id
        WHERE desired.version=state.desired_version
          AND snapshot.service=d.service AND snapshot."group"=d."group" AND snapshot.name=d.name
          AND snapshot.config=legacy_seed)
    FOR UPDATE OF d,state;
  IF document_id IS NULL THEN RETURN; END IF;

  target := jsonb_set(jsonb_set(legacy_seed,'{model,package_id}',to_jsonb('qwen3vl-embedding-2b-o2'::text),false),
                      '{limits,max_samples}',to_jsonb(60000),false);
  LOCK TABLE config_versions IN EXCLUSIVE MODE;
  UPDATE config_documents SET config=target WHERE id=document_id;
  SELECT COALESCE(MAX(version),0)+1 INTO next_version FROM config_versions;
  INSERT INTO config_versions(version,status,published_by,published_at,change_summary)
    VALUES(next_version,'published','migration',now(),'智能搜索未修改默认选型调整为 Qwen3-VL-Embedding-2B；保持关闭')
    RETURNING id INTO new_version_id;
  INSERT INTO config_snapshots(version_id,service,"group",name,config)
    SELECT new_version_id,service,"group",name,config FROM config_documents ORDER BY service,"group",name;
  UPDATE config_service_states SET desired_version=next_version,status='pending',restart_required=false
    WHERE service_name='search-service';
  INSERT INTO config_audit_logs(actor,action,service,"group",config_name,version_before,version_after,detail)
    VALUES('migration','publish','search-service','system','settings',previous_version,next_version,
      '{"initial_default_only":true,"previous_package":"siglip2-base-full-int8","package":"qwen3vl-embedding-2b-o2","enabled":false}'::jsonb);
END;
$$;
