"""Serialize post-quality acceptance; restore managed service after protocol tests."""
import json, os, pathlib, pwd, subprocess, time
R=pathlib.Path('/home/sunrise/ainvr')
O=R/'test/results/llm-service-development/admission-acceptance.json'
def main():
    report={}
    def record(phase):report.update(phase=phase,updated_at=time.time());O.write_text(json.dumps(report,indent=2))
    record('waiting-for-independent-set')
    deadline=time.monotonic()+2400
    while time.monotonic()<deadline:
        d=json.loads((R/'test/results/llm-service-development/residency-final-559.json').read_text())
        if 'now' in d:
            assert d.get('passed') and len(d['requests'])==559 and all(v==0 for v in d['restore'].values()), 'independent run failed'
            break
        time.sleep(5)
    else:raise TimeoutError('independent set')
    active=subprocess.run(['systemctl','is-active','--quiet','ainvr-llm']).returncode==0
    try:
        record('protocol-and-fault-recovery')
        subprocess.run(['systemctl','stop','ainvr-llm'],check=True,timeout=90)
        for name in ['test_http_control.py','test_config_roundtrip.py']:
            subprocess.run(['python3',str(R/'llm-service/tests'/name)],check=True,timeout=150)
    finally:
        owner=pwd.getpwnam('sunrise')
        for n in ['bpu-reservation.lock','bpu-reservations.json']:
            p=pathlib.Path('/run/ainvr')/n
            if p.exists():os.chown(p,owner.pw_uid,owner.pw_gid)
        if active:subprocess.run(['systemctl','start','ainvr-llm'],check=True,timeout=90)
    record('sdk-and-one-hour-stability')
    subprocess.run(['/mnt/ainvr-ssd/llm-build/sdk-venv/bin/python',str(R/'llm-service/tests/test_service_endurance.py')],check=True,timeout=4200)
    record('passed')
if __name__=='__main__':main()
