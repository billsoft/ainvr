-- PTZ is configuration/control state, independent of history storage and SRS.
CREATE TABLE ptz_settings (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
 revision BIGINT NOT NULL DEFAULT 1,
 document JSONB NOT NULL DEFAULT '{"enabled":true,"capacity":4,"leaseMs":1200}'::jsonb
);
INSERT INTO ptz_settings(singleton) VALUES(TRUE);
CREATE TABLE ptz_camera_settings (
 source_id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL DEFAULT 1,
 identity TEXT NOT NULL,
 document JSONB NOT NULL DEFAULT '{}'::jsonb,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ptz_presets (
 resource_key TEXT NOT NULL,
 preset_id TEXT NOT NULL,
 name TEXT NOT NULL,
 shortcut SMALLINT CHECK(shortcut BETWEEN 1 AND 9),
 position JSONB,
 device_state TEXT NOT NULL DEFAULT 'delivery_accepted',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(resource_key,preset_id),
 UNIQUE(resource_key,shortcut)
);
CREATE TABLE ptz_view_guards (
 resource_key TEXT PRIMARY KEY,
 revision BIGINT NOT NULL DEFAULT 1,
 blocked BOOLEAN NOT NULL DEFAULT TRUE,
 stop_pending BOOLEAN NOT NULL DEFAULT FALSE,
 source_ids TEXT[] NOT NULL,
 baseline JSONB,
 changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 restored_at TIMESTAMPTZ,
 actor TEXT NOT NULL
);
