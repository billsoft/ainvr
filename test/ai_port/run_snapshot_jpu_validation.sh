#!/usr/bin/env bash
# Copyright AINVR. Real GLES/JPU checks; CPU reference store tests are separate.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
[[ "$root" == /home/sunrise/ainvr ]] || { echo 'Run from the authorized board workspace'; exit 1; }
cd -- "$root"
mountpoint -q /mnt/ainvr-ssd || { echo 'Expected SSD is not mounted'; exit 1; }
result="test/results/snapshot-jpu-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -- "$result"
build=out/build/ai-api-compat
export LD_LIBRARY_PATH="/usr/hobot/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
cmake -S ai-service -B "$build" -DAINVR_S100P=ON -DBUILD_TESTING=ON >"$result/build.log" 2>&1
cmake --build "$build" --target snapshot_jpu_test snapshot_jpu_failure_test -j2 >>"$result/build.log" 2>&1
runtime_user=$(systemctl show ainvr-ai --property=User --value)
runtime_user=${runtime_user:-root}
launcher=()
if ((EUID==0)) && [[ "$runtime_user" != root ]]; then
  chown "$runtime_user" -- "$result"
  launcher=(runuser -u "$runtime_user" -- env "LD_LIBRARY_PATH=$LD_LIBRARY_PATH")
elif [[ $(id -un) != "$runtime_user" ]]; then
  echo 'Run as root or the configured AI service account'; exit 1
fi
"${launcher[@]}" timeout 90 "$build/snapshot_jpu_test" --gtest_output="xml:$result/hardware.xml" >"$result/hardware.log" 2>&1
"${launcher[@]}" timeout 60 "$build/snapshot_jpu_failure_test" --gtest_output="xml:$result/failure.xml" >"$result/failure.log" 2>&1
python3 - "$result" "$runtime_user" <<'PY'
import sys,json,pathlib,xml.etree.ElementTree as ET
root=pathlib.Path(sys.argv[1]);suites=[ET.parse(root/name).getroot() for name in ['hardware.xml','failure.xml']]
assert all(int(s.attrib['failures'])==0 and int(s.attrib['errors'])==0 for s in suites)
r={'passed':True,'tests_passed':sum(int(s.attrib['tests']) for s in suites),
   'execution_user':sys.argv[2],
   'pipeline':'BGR bytes -> GLES full-range BT.601 NV12 with SDK edge padding -> JPU',
   'cpu_color_or_jpeg_fallback':False,'odd_dimensions_preserved':True,
   'maximum_tested_width':8191,'minimum_supported_visible_dimension':17,
   'failure_and_retry_verified':True,'original_archive_business_suite':'separate CPU reference oracle',
   'full_snapshot_pipeline_accepted':False}
(root/'summary.json').write_text(json.dumps(r,indent=2))
print('GLES/JPU hardware checks passed:',r['tests_passed'],'tests')
print('Report:',root/'summary.json')
PY
