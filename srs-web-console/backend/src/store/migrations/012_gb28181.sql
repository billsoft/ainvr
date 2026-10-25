-- GB configuration is isolated from existing inputs. Secrets use config_secrets.
CREATE TABLE gb28181_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  document JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO gb28181_settings(singleton) VALUES(true);
CREATE TABLE gb28181_devices (
  device_id VARCHAR(20) PRIMARY KEY CHECK(device_id ~ '^[0-9]{20}$'),
  name TEXT NOT NULL,
  profile TEXT NOT NULL CHECK(profile IN ('auto','2016','2022')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  secret_ref TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE gb28181_catalog (
  device_id VARCHAR(20) NOT NULL REFERENCES gb28181_devices(device_id),
  channel_id VARCHAR(20) NOT NULL CHECK(channel_id ~ '^[0-9]{20}$'),
  document JSONB NOT NULL,
  available BOOLEAN NOT NULL DEFAULT true,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(device_id,channel_id)
);
CREATE TABLE gb28181_bindings (
  binding_id UUID PRIMARY KEY,
  device_id VARCHAR(20) NOT NULL,
  channel_id VARCHAR(20) NOT NULL,
  input_id UUID,
  stream_name TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  transport TEXT NOT NULL CHECK(transport IN ('udp','tcp-passive','tcp-active')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(device_id,channel_id),
  FOREIGN KEY(device_id,channel_id) REFERENCES gb28181_catalog(device_id,channel_id)
);
