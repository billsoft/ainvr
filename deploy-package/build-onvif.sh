#!/bin/sh
# Build against the already pinned board Go toolchain; no production restart.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
GO=${AINVR_GO:-$ROOT/out/gb28181/go/bin/go}
test -x "$GO" || { echo 'Set AINVR_GO to a Go 1.24+ toolchain' >&2; exit 1; }
mkdir -p "$ROOT/out/onvif"
cd "$ROOT/onvif-service"
GOMAXPROCS=2 GOTELEMETRY=off "$GO" mod verify
GOMAXPROCS=2 GOTELEMETRY=off "$GO" test -race -p 2 -timeout 60s ./...
GOMAXPROCS=2 GOTELEMETRY=off "$GO" build -trimpath -o "$ROOT/out/onvif/ainvr_onvif" ./cmd/onvif
"$GO" version -m "$ROOT/out/onvif/ainvr_onvif" > "$ROOT/out/onvif/build-info.txt"
sha256sum "$ROOT/out/onvif/ainvr_onvif" > "$ROOT/out/onvif/binary.sha256"
