#!/usr/bin/env bash
# Copyright AINVR. Official-model hardware validation only; never changes channel config.
# Usage: bash test/ai_port/run_bpu_image_validation.sh [input_url] [frame_count]
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
[[ "$root" == /home/sunrise/ainvr ]] || { echo 'Run from the authorized board workspace'; exit 1; }
cd -- "$root"
frames=${2:-30}
[[ "$frames" =~ ^[0-9]+$ ]] && ((frames>=1 && frames<=60)) || { echo 'Frame count must be 1..60'; exit 1; }
input=${1:-rtmp://127.0.0.1:1935/live/xm}
model=/opt/hobot/model/s100/basic/yolo11n_detect_nashe_640x640_nv12.hbm
[[ -r "$model" ]] || { echo 'Official NV12 validation model is absent'; exit 1; }
mountpoint -q /mnt/ainvr-ssd || { echo 'Expected SSD is not mounted'; exit 1; }
build=out/build/ai-api-compat
result="test/results/bpu-image-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -- "$result"
export LD_LIBRARY_PATH="/usr/hobot/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
cmake -S ai-service -B "$build" -DAINVR_S100P=ON -DBUILD_TESTING=ON >"$result/build.log" 2>&1
cmake --build "$build" --target bpu_image_input_test image_preprocessor_test ainvr_bpu_image_probe -j2 >>"$result/build.log" 2>&1
timeout 80 "$build/bpu_image_input_test" --gtest_output="xml:$result/input-tests.xml" >"$result/tests.log" 2>&1
timeout 60 "$build/image_preprocessor_test" --gtest_output="xml:$result/image-tests.xml" >>"$result/tests.log" 2>&1
timeout 110 "$build/ainvr_bpu_image_probe" "$input" "$model" "$frames" "$result/live.json" >"$result/live.log" 2>&1
python3 - "$result/live.json" <<'PY'
import json,sys,statistics
r=json.load(open(sys.argv[1])); assert r['passed'] and not r['cpu_inference'] and not r['cpu_image_processing']
print('Official-model hardware validation passed; user-model conversion/accuracy remains separate.')
print('Source:',r['source_width'],'x',r['source_height'],'Frames:',len(r['frames']))
print('Image backends:',sorted({f['image_backend'] for f in r['frames']}))
for key in ['preprocess_ms','inference_ms','output_decode_ms']:
    print(key, 'median=',round(statistics.median(f[key] for f in r['frames']),3),'ms')
print('Report:',sys.argv[1])
PY
