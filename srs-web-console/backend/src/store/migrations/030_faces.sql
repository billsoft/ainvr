-- Face configuration only. Node owns vectors/capture history in existing Mongo;
-- image payloads belong to the selected SSD evidence storage.
CREATE TABLE faces_libraries (
  id uuid PRIMARY KEY, version integer NOT NULL CHECK (version > 0),
  document jsonb NOT NULL CHECK (octet_length(document::text) <= 524288),
  templates jsonb NOT NULL DEFAULT '{}' CHECK (octet_length(templates::text) <= 1048576),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by varchar(128) NOT NULL, deleted_at timestamptz
);
CREATE TABLE faces_library_versions (
  library_id uuid NOT NULL REFERENCES faces_libraries(id), version integer NOT NULL,
  document jsonb NOT NULL, templates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), retain_until timestamptz NOT NULL,
  PRIMARY KEY(library_id, version)
);
CREATE TABLE faces_operations (
  actor varchar(128) NOT NULL, operation_key uuid NOT NULL, request_hash char(64) NOT NULL,
  response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor, operation_key)
);
CREATE INDEX faces_operations_retention ON faces_operations(created_at);
CREATE INDEX faces_versions_retention ON faces_library_versions(retain_until);
