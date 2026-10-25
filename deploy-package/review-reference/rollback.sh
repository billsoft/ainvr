#!/bin/sh
set -eu
systemctl disable --now ainvr-review-reference
# Retain scores and image artifacts for audit; handling and original review remain intact.
