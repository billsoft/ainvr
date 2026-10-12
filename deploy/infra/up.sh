#!/bin/bash
# Copyright AINVR. Run only the base infrastructure, never the reference stack.
set -euo pipefail
cd -- "$(dirname -- "$(readlink -f -- "$0")")"
python3 prepare.py
docker compose config --quiet
for image in ossrs/srs:7.0.162 postgres:16-alpine mongo:7.0; do
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        docker pull --platform linux/arm64 "$image"
    fi
done
python3 check-images.py
docker compose run --rm --no-deps --entrypoint ./objs/srs srs -t -c conf/ainvr/srs.conf
docker compose run --rm --no-deps --entrypoint ./objs/srs srs -t -c conf/ainvr/hls.conf
docker compose up -d --wait --wait-timeout 180
docker compose ps
