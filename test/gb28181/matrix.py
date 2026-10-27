#!/usr/bin/env python3
"""Serial bounded media matrix. Uses isolated SIP/media/SRS ports, no production input."""
import fcntl
import hashlib
import itertools
import json
import os
from pathlib import Path
import subprocess
import time

root=Path(__file__).resolve().parents[2]
suffix=os.environ.get('AINVR_GB_TEST_FIXTURE_SUFFIX','')
assert len(suffix)<=32 and (not suffix or suffix.replace('-','').isalnum()),'Invalid fixture suffix'
out=Path(os.environ.get('AINVR_GB_TEST_RESULTS',str(root/'test/results/gb28181')))/'matrix'
out.mkdir(parents=True,exist_ok=False)
gateway=Path(os.environ.get('AINVR_GB_TEST_GATEWAY',str(root/'out/gb28181/gateway'))).resolve()
gateway_sha=hashlib.sha256(gateway.read_bytes()).hexdigest()
lock=(out/'run.lock').open('w')
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
cases=[]
for version,signaling,media,video,audio in itertools.product(['2.0','3.0'],['udp','tcp'],['udp','tcp-passive','tcp-active'],['h264','hevc'],['silent','aac','alaw','mulaw']):
    fixture=f'{video}-{audio}{suffix}'
    command=['python3',str(root/'test/gb28181/pipeline_probe.py'),'--version',version,'--signaling',signaling,'--media',media,'--fixture',fixture,'--video',video]
    if audio=='silent':command.append('--silent')
    start=time.monotonic()
    # Includes the separate 60-second offline startup lifecycle plus bounded
    # recording/cleanup. The probe still enforces INVITE-to-publish <= 10s.
    result=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=90,text=True)
    assert hashlib.sha256(gateway.read_bytes()).hexdigest()==gateway_sha,'Gateway changed during matrix'
    case={'version':version,'signaling':signaling,'media':media,'video':video,'audio':audio,'passed':result.returncode==0,'seconds':round(time.monotonic()-start,2)}
    cases.append(case)
    (out/f'{version}-{signaling}-{media}-{fixture}.log').write_text(result.stdout)
    (out/'report.json').write_text(json.dumps({'complete':len(cases)==96,'passed':len(cases)==96 and all(c['passed'] for c in cases),'gatewaySHA256':gateway_sha,'cases':cases},indent=2)+'\n')
    print(json.dumps(case),flush=True)
    if result.returncode:raise SystemExit('Matrix stopped at failed case; inspect its log before resuming.')
