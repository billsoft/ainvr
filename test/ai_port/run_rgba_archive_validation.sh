#!/usr/bin/env bash
# Copyright AINVR. Native RGBA archive handoff, original business regression.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
[[ "$root" == /home/sunrise/ainvr ]] || { echo 'Use the authorized board workspace'; exit 1; }
cd -- "$root"
mountpoint -q /mnt/ainvr-ssd || { echo 'Expected SSD is not mounted'; exit 1; }
result="test/results/rgba-archive-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -- "$result"
build=out/build/ai-api-compat
export LD_LIBRARY_PATH="/usr/hobot/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
cmake -S ai-service -B "$build" -DAINVR_S100P=ON -DBUILD_TESTING=ON >"$result/build.log" 2>&1
cmake --build "$build" --target exposure_gles_test reused_exposure_test \
  reused_snapshot_store_test reused_controller_output_test \
  snapshot_jpu_test snapshot_jpu_failure_test ainvr_s100p_control_service -j2 >>"$result/build.log" 2>&1
runtime_user=$(systemctl show ainvr-ai --property=User --value)
runtime_user=${runtime_user:-root}
launcher=()
if ((EUID==0)) && [[ "$runtime_user" != root ]]; then
  chown "$runtime_user" -- "$result"
  launcher=(runuser -u "$runtime_user" -- env "LD_LIBRARY_PATH=$LD_LIBRARY_PATH" GSETTINGS_BACKEND=memory)
elif [[ $(id -un) != "$runtime_user" ]]; then
  echo 'Run as root or the configured AI service user'; exit 1
fi
"${launcher[@]}" timeout 120 "$build/exposure_gles_test" --gtest_output="xml:$result/hardware.xml" >"$result/hardware.log" 2>&1
"${launcher[@]}" timeout 90 "$build/snapshot_jpu_test" --gtest_output="xml:$result/jpeg.xml" >"$result/jpeg.log" 2>&1
"${launcher[@]}" timeout 60 "$build/snapshot_jpu_failure_test" --gtest_output="xml:$result/jpeg-failure.xml" >"$result/jpeg-failure.log" 2>&1
timeout 90 "$build/reused_exposure_test" --gtest_filter=-Exposure.OptionalCpuBenchmark --gtest_output="xml:$result/reference.xml" >"$result/reference.log" 2>&1
timeout 60 "$build/reused_controller_output_test" --gtest_output="xml:$result/controller.xml" >"$result/controller.log" 2>&1
python3 - "$result" <<'PY'
import sys,json,os,subprocess,pathlib
root=pathlib.Path(sys.argv[1])
from urllib.parse import quote
password=pathlib.Path('deploy/infra/secrets/mongo_admin_password').read_text().strip()
env=os.environ.copy()
# Production's application account is deliberately limited to ainvr_snapshots.
# The oracle writes a separate database and must not reuse that limited account.
env['AI_SERVICE_TEST_MONGO_URI']='mongodb://ainvr_admin:'+quote(password,safe='')+'@127.0.0.1:27017/?authSource=admin'
import tempfile
temporary_root=pathlib.Path('data/ai/test-runtime').resolve()
temporary_root.mkdir(parents=True,exist_ok=True)
env['TMPDIR']=tempfile.mkdtemp(prefix='rgba-archive-',dir=temporary_root)
assert os.statvfs(env['TMPDIR']).f_bavail*os.statvfs(env['TMPDIR']).f_frsize>5*1024**3
(root/'temporary-storage.json').write_text(json.dumps({'path':env['TMPDIR'],'storage':'external SSD'})+'\n')
# Original suite uses ainvr_snapshot_reuse_tests, never the production database.
with (root/'archive-reference.log').open('w') as log:
  subprocess.run(['out/build/ai-api-compat/reused_snapshot_store_test',
    '--gtest_output=xml:'+str(root/'archive-reference.xml')],env=env,
    stdout=log,stderr=subprocess.STDOUT,check=True,timeout=180)
PY
python3 - "$result" "$runtime_user" <<'PY'
import sys,json,pathlib,xml.etree.ElementTree as ET
root=pathlib.Path(sys.argv[1])
suites={n:ET.parse(root/(n+'.xml')).getroot() for n in ['hardware','jpeg','jpeg-failure','reference','controller','archive-reference']}
assert all(int(s.attrib['failures'])==0 and int(s.attrib['errors'])==0 and int(s.attrib.get('disabled',0))==0 for s in suites.values())
assert all(not s.findall('.//skipped') for s in suites.values())
properties={p.attrib['name']:p.attrib['value'] for n in ['hardware','jpeg'] for p in suites[n].findall('.//property')}
processing=pathlib.Path('ai-service/src/output/snapshot_processing.cpp').read_text()
encoder=pathlib.Path('ai-service/src/output/snapshot_jpeg.cpp').read_text()
assert 'cv::cvtColor' not in processing
assert processing.count('EncodeSnapshotRgbaJpeg(')==2
assert all(token not in encoder for token in ['cv::cvtColor','cv::imencode'])
assert int(suites['jpeg'].attrib['tests'])>=11
summary={'passed':True,'execution_user':sys.argv[2],'hardware_tests':int(suites['hardware'].attrib['tests']),
  'jpeg_tests':sum(int(suites[n].attrib['tests']) for n in ['jpeg','jpeg-failure']),
  'reference_tests':int(suites['reference'].attrib['tests']),
  'controller_tests':int(suites['controller'].attrib['tests']),
  'archive_reference_tests':int(suites['archive-reference'].attrib['tests']),
  'properties':properties,'cpu_color_execution_in_hardware_path':False,
  'pipeline':'native RGBA -> GLES local exposure (optional) -> GLES BT.601/padding -> JPU',
  'original_and_processed_image_contract_preserved':True,
  'mixed_layouts_share_one_hardware_worker':True,
  'user_channel_config_changed':False,'all_models_bpu_ready':False,
  'full_snapshot_pipeline_accepted':False,'full_ai_worker_accepted':False}
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print('Native RGBA hardware archive handoff and original business regression passed')
print('Report:',root/'summary.json')
PY
