#!/usr/bin/env bash
# Copyright AINVR. Original publisher/cache/SEI -> SRS -> VPU/browser-parser validation.
# Uses an isolated temporary output stream; never modifies production channels.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
[[ "$root" == /home/sunrise/ainvr ]] || { echo 'Run from the authorized board workspace'; exit 1; }
cd -- "$root"
mountpoint -q /mnt/ainvr-ssd || { echo 'Expected SSD is not mounted'; exit 1; }
result="test/results/reused-sei-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -- "$result"
build=out/build/ai-api-compat
node=/opt/ainvr/node-v24.20.0-linux-arm64/bin/node
[[ -x "$node" ]] || { echo 'Configured Node runtime is unavailable'; exit 1; }
cmake -S ai-service -B "$build" -DAINVR_S100P=ON -DBUILD_TESTING=ON >"$result/build.log" 2>&1
cmake --build "$build" --target compressed_tap_test reused_publisher_test ainvr_reused_sei_probe -j2 >>"$result/build.log" 2>&1
timeout 60 "$build/compressed_tap_test" --gtest_output="xml:$result/tap.xml" >"$result/unit.log" 2>&1
timeout 60 "$build/reused_publisher_test" --gtest_output="xml:$result/publisher.xml" >>"$result/unit.log" 2>&1
runtime_user=$(systemctl show ainvr-ai --property=User --value)
runtime_user=${runtime_user:-root}
launcher=()
if ((EUID==0)) && [[ "$runtime_user" != root ]]; then
 chown "$runtime_user" -- "$result"
 launcher=(runuser -u "$runtime_user" --)
elif [[ $(id -un) != "$runtime_user" ]]; then
 echo 'Run as root or the configured AI service account'; exit 1
fi
"${launcher[@]}" env LD_LIBRARY_PATH=/usr/hobot/lib GSETTINGS_BACKEND=memory timeout 75 \
 "$build/ainvr_reused_sei_probe" "${1:-rtmp://127.0.0.1:1935/live/xm}" "$result/transport.json" >"$result/transport.log" 2>&1
"$node" --experimental-strip-types test/ai_port/verify_browser_sei.mts "$result/transport.json" "$result/browser-parser.json" >"$result/browser-parser.log" 2>&1
python3 - "$result" "$runtime_user" <<'PY'
import json,sys,pathlib,xml.etree.ElementTree as ET
root=pathlib.Path(sys.argv[1]);transport=json.loads((root/'transport.json').read_text());browser=json.loads((root/'browser-parser.json').read_text())
suites=[ET.parse(root/p).getroot() for p in ['tap.xml','publisher.xml']]
assert all(int(s.attrib['failures'])==0 and int(s.attrib['errors'])==0 for s in suites)
assert transport['passed'] and browser['passed']
r={'passed':True,'unit_tests_passed':sum(int(s.attrib['tests']) for s in suites),
 'transport_execution_user':sys.argv[2],'transport':transport['output_evidence'],
 'video_reencoded':False,'inference_executed':False,'actual_browser_playback_verified':False,
 'user_channel_configuration_modified':False}
(root/'summary.json').write_text(json.dumps(r,indent=2));print('Reused publisher, SRS, VPU and production browser parser checks passed')
print('Report:',root/'summary.json')
PY
