#!/bin/bash
# Copyright AINVR. Ubuntu-maintained ARM64 Docker and Compose packages.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
    echo 'Run this installer as root.' >&2
    exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update
apt-get -s install --no-install-recommends docker.io docker-compose-v2 docker-buildx
apt-get install -y --no-install-recommends docker.io docker-compose-v2 docker-buildx
# RDK S100/S100P kernel requires the legacy backend (official FAQ Q30).
update-alternatives --set iptables /usr/sbin/iptables-legacy
update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
systemctl reset-failed docker
systemctl enable --now docker
docker version
docker compose version
