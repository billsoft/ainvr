CREATE FUNCTION arming_scene_epoch(source text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT encode(sha256(convert_to(COALESCE(string_agg(resource_key || ':' || revision::text, '|' ORDER BY resource_key COLLATE "C"), ''),'UTF8')),'hex')
 FROM ptz_view_guards WHERE source=ANY(source_ids) AND (blocked OR restored_at IS NOT NULL)
$$;
CREATE TABLE arming_scene_frames (
 frame_id uuid PRIMARY KEY, source_id text NOT NULL, processor_id text NOT NULL,
 actor text NOT NULL, identity text NOT NULL, resource text NOT NULL, epoch text NOT NULL,
 geometry_revision text NOT NULL, captured_at timestamptz NOT NULL, image jsonb NOT NULL,
 pose jsonb, manual_revision integer NOT NULL, items jsonb NOT NULL
);
CREATE SEQUENCE arming_scene_revision AS integer;
CREATE TABLE arming_scene_zones (
 source_id text NOT NULL, processor_id text NOT NULL, zone_id text NOT NULL,
 revision integer NOT NULL DEFAULT nextval('arming_scene_revision'), zone_version int NOT NULL,
 reference_frame_id uuid NOT NULL REFERENCES arming_scene_frames, reference_points jsonb NOT NULL,
 identity text NOT NULL, resource text NOT NULL, geometry_revision text NOT NULL, epoch text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','matched','unmatched')), reason text NOT NULL,
 current_points jsonb, pose jsonb, evidence jsonb, changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 visual_checked_at timestamptz, checked_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(source_id,processor_id,zone_id),
 CHECK((state='matched')=(current_points IS NOT NULL))
);
CREATE TABLE arming_scene_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, source_id text NOT NULL,processor_id text NOT NULL,
 zone_id text NOT NULL, revision int NOT NULL, operation text NOT NULL, document jsonb NOT NULL,
 reference_frame_id uuid NOT NULL REFERENCES arming_scene_frames, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ON arming_scene_history(source_id,processor_id,zone_id,recorded_at);
CREATE FUNCTION arming_scene_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r arming_scene_zones;
BEGIN
 IF TG_OP='DELETE' THEN r:=OLD; ELSE r:=NEW; END IF;
 IF TG_OP<>'UPDATE' OR OLD.revision<>NEW.revision THEN
 INSERT INTO arming_scene_history(source_id,processor_id,zone_id,revision,operation,document,reference_frame_id)
 VALUES(r.source_id,r.processor_id,r.zone_id,r.revision,TG_OP,to_jsonb(r),r.reference_frame_id);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER arming_scene_journal AFTER INSERT OR UPDATE OR DELETE ON arming_scene_zones
 FOR EACH ROW EXECUTE FUNCTION arming_scene_journal();

-- The PTZ block/restore transaction already holds the global revision lock and
-- publishes a new alarm revision. Journal the invalidation in that transaction,
-- including sources removed from a resource's binding since its previous epoch.
CREATE FUNCTION arming_scene_guard_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids text[];
BEGIN
 IF TG_OP='UPDATE' AND NEW.revision=OLD.revision AND NEW.source_ids=OLD.source_ids THEN RETURN NULL; END IF;
 IF TG_OP='INSERT' AND NOT NEW.blocked AND NEW.restored_at IS NULL THEN RETURN NULL; END IF;
 ids:=NEW.source_ids;
 IF TG_OP='UPDATE' THEN ids:=ids||OLD.source_ids; END IF;
 UPDATE arming_scene_zones SET revision=nextval('arming_scene_revision'),state='pending',current_points=NULL,
   reason='视角已变化',changed_at=clock_timestamp(),checked_at=clock_timestamp()
   WHERE source_id=ANY(ids);
 RETURN NULL;
END $$;
CREATE TRIGGER arming_scene_guard_changed AFTER INSERT OR UPDATE OF revision,source_ids ON ptz_view_guards
 FOR EACH ROW EXECUTE FUNCTION arming_scene_guard_changed();
