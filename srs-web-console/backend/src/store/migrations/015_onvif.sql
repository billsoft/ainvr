-- Device identity is independent of IP address, RTSP URI, and the channel UUID.
CREATE TABLE onvif_settings (
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
 revision BIGINT NOT NULL DEFAULT 1,
 document JSONB NOT NULL DEFAULT '{}',
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO onvif_settings(singleton) VALUES(true);
CREATE TABLE onvif_devices (
 device_id UUID PRIMARY KEY,
 name TEXT NOT NULL,
 service_url TEXT NOT NULL,
 username TEXT NOT NULL,
 secret_ref TEXT NOT NULL,
 certificate_sha256 TEXT NOT NULL DEFAULT '',
 epr TEXT,
 version INTEGER NOT NULL DEFAULT 1,
 capabilities JSONB,
 last_probe_at TIMESTAMPTZ,
 last_error TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX onvif_device_epr ON onvif_devices(epr) WHERE epr IS NOT NULL AND epr<>'';
