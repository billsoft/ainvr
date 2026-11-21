-- Keep the forensic manifest and all referencing history rows after JPEG expiry.
ALTER TABLE arming_scene_frames ADD COLUMN image_retired_at timestamptz;
CREATE INDEX arming_scene_images_retained ON arming_scene_frames(captured_at) WHERE image_retired_at IS NULL;
CREATE INDEX arming_scene_current_frames ON arming_scene_zones(reference_frame_id);
CREATE INDEX arming_scene_frame_activity ON arming_scene_history(reference_frame_id,recorded_at DESC);
