#!/usr/bin/env python3
"""AINVR: original worker business + real VPU/GLES; model double is test-only."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]


def main():
    assert ROOT.resolve() == Path('/home/sunrise/ainvr') and Path('/mnt/ainvr-ssd').is_mount()
    assert os.geteuid() == 0
    result = ROOT/'test/results'/('reused-worker-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+str(os.getpid()))
    result.mkdir()
    build = Path(os.environ.get('AINVR_TEST_BUILD_DIR', ROOT/'out/build/ai-api-compat')).resolve()
    assert build.is_relative_to(ROOT/'out/build'), 'Build directory must stay in the AINVR build tree'
    user = subprocess.check_output(['systemctl', 'show', 'ainvr-ai', '--property=User', '--value'], text=True).strip()
    account = pwd.getpwnam(user);os.chown(result, account.pw_uid, account.pw_gid)
    suites = ['nv12_rgba_test', 'reused_worker_test', 'gles_test', 'image_preprocessor_test', 'bpu_image_input_test', 'reused_controller_output_test']
    with (result/'build.log').open('w') as log:
        subprocess.run(['cmake','-S',str(ROOT/'ai-service'),'-B',str(build),'-DAINVR_S100P=ON','-DBUILD_TESTING=ON'],
                       stdout=log,stderr=subprocess.STDOUT,check=True,timeout=60)
        subprocess.run(['cmake','--build',str(build),'--target',*suites,'ainvr_bpu_image_probe','ainvr_s100p_control_service','-j2'],
                       stdout=log,stderr=subprocess.STDOUT,check=True,timeout=300)
    env = dict(os.environ, LD_LIBRARY_PATH='/usr/hobot/lib')
    results = []
    for suite in suites:
        with (result/(suite+'.log')).open('w') as log:
            subprocess.run(['runuser','-u',user,'--',str(build/suite),'--gtest_output=xml:'+str(result/(suite+'.xml'))],
                           env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=90)
        tree = ET.parse(result/(suite+'.xml')).getroot()
        assert all(int(tree.attrib.get(k,'0'))==0 for k in ['failures','errors','disabled'])
        assert not tree.findall('.//skipped')
        results.append({'suite':suite,'passed':int(tree.attrib['tests'])})
    model = '/opt/hobot/model/s100/basic/yolo11n_detect_nashe_640x640_nv12.hbm'
    with (result/'official-bpu.log').open('w') as log:
        subprocess.run(['runuser','-u',user,'--',str(build/'ainvr_bpu_image_probe'),
                        'rtmp://127.0.0.1:1935/live/xm',model,'10',str(result/'official-bpu.json')],
                       env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=90)
    bpu = json.loads((result/'official-bpu.json').read_text())
    assert bpu['passed'] and not bpu['cpu_inference'] and not bpu['cpu_image_processing']
    summary = {'passed':True,'execution_user':user,'suites':results,'tests_passed':sum(x['passed'] for x in results),
               'hardware':'real S100P VPU/GLES; separate official-model BPU smoke test',
               'worker_model_is_test_double':True,'user_model_inference_verified':False,
               'official_bpu_frames':len(bpu['frames']),'production_worker_deployed':False,
               'user_channel_configuration_modified':False,
               'worker_sha256':hashlib.sha256((ROOT/'ai-service/src/pipeline/reused_channel_worker.cpp').read_bytes()).hexdigest()}
    (result/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    print(json.dumps(summary,indent=2));print('RESULT',result)


if __name__ == '__main__':
    main()
