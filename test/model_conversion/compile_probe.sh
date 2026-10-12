#!/usr/bin/env bash
# AINVR: run INSIDE official OE 3.7.0 toolchain, never on the deployment venv.
# A fast-perf HBM is only a compatibility/performance experiment, NOT an
# accuracy-calibrated production model. Use representative calibration later.
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo 'Usage: compile_probe.sh /absolute/model.onnx /new/output/directory' >&2
  exit 2
fi
command -v hb_compile >/dev/null || { echo 'Official S-series hb_compile toolchain is required' >&2; exit 3; }
model=$(realpath -- "$1")
test -f "$model"
# Refuse to mix outputs with previous experiments.
mkdir -- "$2"
output=$(realpath -- "$2")
cd -- "$output"
hb_compile --model "$model" --march nash-m --fast-perf 2>&1 | tee compile.log
