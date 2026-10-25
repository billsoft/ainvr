#!/bin/sh
set -eu
cd /home/sunrise/ainvr
release=deploy/s100p/reference-review/release-latest-20261025
[ ! -e "$release" ]
mkdir -p "$release"
cp -a alarm-service/src "$release/src"
ln -s /home/sunrise/ainvr/alarm-service/node_modules "$release/node_modules"
cp /mnt/ainvr-ssd/llm-build/ainvr/ainvr_llm_image_probe "$release/ainvr_llm_image_probe"
install -m 0644 deploy-package/review-reference/ainvr-review-reference.service /etc/systemd/system/ainvr-review-reference.service
systemctl daemon-reload
systemctl enable ainvr-review-reference
systemctl restart ainvr-review-reference
systemctl is-active ainvr-review-reference
