-- Existing projections remain historical/experimental; never promote them.
ALTER TABLE arming_scene_frames ADD COLUMN binding_mode text NOT NULL DEFAULT 'experimental_projection'
 CHECK(binding_mode IN ('preset','experimental_projection','current'));
ALTER TABLE arming_scene_frames ADD COLUMN preset_home jsonb;
ALTER TABLE arming_scene_zones ADD COLUMN binding_mode text NOT NULL DEFAULT 'experimental_projection'
 CHECK(binding_mode IN ('preset','experimental_projection'));
ALTER TABLE arming_scene_zones ADD COLUMN preset_home jsonb;
CREATE TABLE arming_preset_definitions (
 resource text NOT NULL, preset_id text NOT NULL, version uuid NOT NULL, present boolean NOT NULL DEFAULT true,
 PRIMARY KEY(resource,preset_id)
);
-- Tombstones survive remove/recreate. Only deliberate position mutations rotate
-- this version; labels and shortcut edits do not invalidate a home.
UPDATE arming_scene_zones SET state='pending',current_points=NULL,
 reason='实验性视角投影默认关闭',revision=nextval('arming_scene_revision'),changed_at=clock_timestamp()
 WHERE state='matched';
UPDATE alarm_configuration_revision SET revision=revision+1 WHERE singleton;
