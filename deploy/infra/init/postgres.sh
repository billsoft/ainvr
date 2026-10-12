#!/bin/sh
# Copyright AINVR. App role owns its database without cluster admin rights.
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1 <<'SQL'
\set app_password `cat /run/secrets/pg_app_password`
CREATE ROLE ainvr_config LOGIN PASSWORD :'app_password';
ALTER DATABASE ainvr_config OWNER TO ainvr_config;
GRANT ALL ON SCHEMA public TO ainvr_config;
SQL
