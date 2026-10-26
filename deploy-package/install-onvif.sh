#!/bin/sh
# Explicit checksummed candidate deployment; no independent partial installer.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if test "$#" -eq 0; then
 echo "Build: python3 deploy-package/build-onvif-release.py" >&2
 echo "Apply: $0 --apply out/onvif-release-TIMESTAMP [--baseline-ingest PRECHANGE.tar.gz]" >&2
 echo "Rollback: $0 --rollback .Codex-trash/onvif-deploy-TIMESTAMP" >&2
 exit 2
fi
exec python3 "$ROOT/deploy-package/deploy_onvif_release.py" "$@"
