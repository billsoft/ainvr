-- Triggers replace monitors: one behavior per trigger, one or more AI channels,
-- each channel with its own zone, direction (zone edges) and approach range.
CREATE TABLE alarm_triggers (
  trigger_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version > 0),
  document JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE alarm_trigger_versions (
  trigger_id TEXT NOT NULL REFERENCES alarm_triggers(trigger_id),
  version INTEGER NOT NULL,
  document JSONB NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(trigger_id,version)
);
-- Each behavior of an old monitor becomes its own trigger. The id keeps the old rule
-- id (monitor:behavior), so recorded statistics stay attributable. Contact and line
-- crossing are not trigger behaviors and are not carried over; directions reset to
-- "any" because the old angle filters have no edge equivalent.
WITH source AS (
  SELECT m.monitor_id, m.document AS d, b.behavior
  FROM alarm_monitors m, jsonb_array_elements_text(m.document->'behaviors') AS b(behavior)
  WHERE b.behavior IN ('appearance','region_approach','region_enter','region_traverse')
), converted AS (
  SELECT monitor_id||':'||behavior AS trigger_id, jsonb_build_object(
    'trigger_id', monitor_id||':'||behavior,
    'name', d->>'name',
    'behavior', behavior,
    -- Older monitors stored numbers only; the number stands in for the name until re-confirmed.
    'labels', (SELECT jsonb_agg(jsonb_build_object('label_id',l,'name',l)) FROM jsonb_array_elements_text(d->'label_ids') AS l),
    'duration_ms', CASE WHEN behavior='appearance'
      THEN COALESCE((d#>>'{behavior_settings,appearance,duration_ms}')::int,(d->>'duration_ms')::int,0) ELSE 0 END,
    'alarm_enabled', COALESCE((d->>'alarm_enabled')::boolean,true),
    'state', d->>'state',
    'schedule', COALESCE(d->'schedule','{"mode":"always"}'::jsonb),
    'bindings', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'channel_id', d->>'channel_id',
      'label_map_version', d->>'label_map_version',
      'geometry_revision', d->>'geometry_revision',
      'direction', '{"entry_edges":[],"exit_edges":[]}'::jsonb,
      'approach_px', CASE WHEN behavior='region_approach'
        THEN GREATEST(1,round((d->>'approach_distance')::numeric*COALESCE((d#>>'{source_binding,width}')::numeric,1920)))::int END,
      'input_stream_id', d->>'input_stream_id',
      'source_binding', d->'source_binding',
      'zone_snapshot', CASE WHEN behavior<>'appearance' THEN d->'zone_snapshot' END
    )) || jsonb_build_object(
      'zone_id', CASE WHEN behavior='appearance' THEN NULL ELSE d->'zone_id' END,
      'zone_version', CASE WHEN behavior='appearance' THEN NULL ELSE d->'zone_version' END))
  ) AS document
  FROM source
)
INSERT INTO alarm_triggers(trigger_id,version,document) SELECT trigger_id,1,document FROM converted;
INSERT INTO alarm_trigger_versions(trigger_id,version,document,actor) SELECT trigger_id,1,document,'migration-005' FROM alarm_triggers;
-- New rule ids are published on the next synchronization.
UPDATE alarm_configuration_revision SET revision=revision+1 WHERE singleton=TRUE;
