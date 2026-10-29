#!/usr/bin/env python3
"""Update an existing LLM installation; retain credentials and central settings.

Back up releases, verify frozen sources, roll back on failed health checks.
Never stops recording, streaming or AI. Run only after isolated tests finish.
"""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, time, urllib.request
R = pathlib.Path('/home/sunrise/ainvr')
def run(args):
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=90).decode().strip()
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def health(url):
    with urllib.request.urlopen(url, timeout=5) as f: return json.load(f)
def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--candidate',required=True,type=pathlib.Path)
    a=ap.parse_args(); c=a.candidate.resolve()
    assert os.geteuid()==0 and pathlib.Path('/mnt/ainvr-ssd').is_mount()
    assert c==a.candidate and str(c).startswith('/mnt/ainvr-ssd/ainvr-llm-web-')
    manifest=json.loads((c/'source-manifest.json').read_text())
    built=json.loads((c/'status.json').read_text())
    assert built['phase']=='passed' and all(sha(R/p)==h for p,h in manifest.items()), 'stale source'
    for art in built['artifacts'].values():
        root=pathlib.Path(art['root'])
        digest=hashlib.sha256(json.dumps([(str(p.relative_to(root)),sha(p)) for p in sorted(root.rglob('*')) if p.is_file()]).encode()).hexdigest()
        assert digest==art['sha256'], 'artifact changed'
    unit=pathlib.Path('/etc/systemd/system/ainvr-llm.service')
    original=unit.read_text()
    old=health('http://127.0.0.1:8300/health')
    assert old['config_version']>0 and old['model']=='unloaded', 'finish isolated tests and unload before update'
    evidence=R/'test/results/llm-service-development'
    quality=json.loads((evidence/'final-559-quality.json').read_text())
    endurance=json.loads((evidence/'service-endurance.json').read_text())
    identity=json.loads((evidence/'endurance-provenance.json').read_text())
    assert quality['quality_gate'] and endurance['passed'] and endurance['stability']['passed'], 'acceptance incomplete'
    assert all(v==0 for v in endurance['restore'].values()), 'service restoration failed'
    assert identity['binary_sha256']==sha(pathlib.Path('/mnt/ainvr-ssd/llm-build/ainvr/ainvr_llm_service')), 'untested binary'
    before={s:run(['systemctl','show',s,'-p','MainPID','--value']) for s in ['ainvr-ai','ainvr-recorder','ainvr-ingest','ainvr-alarm']}
    stamp=time.strftime('%Y%m%d-%H%M%S')
    release=R/'deploy/s100p/llm-service'/('release-'+stamp); release.mkdir()
    binary=release/'ainvr_llm_service'
    shutil.copy2('/mnt/ainvr-ssd/llm-build/ainvr/ainvr_llm_service',binary)
    binary.chmod(0o755);run(['ldd',str(binary)])
    (release/'previous-unit.txt').write_text(original)
    report={'started_at':time.time(),'binary_sha256':sha(binary),'baseline':before,'phase':'prepared'}
    out=R/'test/results/llm-service-development/production-admission-update.json'
    swapped=[]
    def record(phase):report.update(phase=phase,updated_at=time.time());out.write_text(json.dumps(report,indent=2))
    try:
        # Recreate the shared lock directory at boot, owned by both service users.
        conf=pathlib.Path('/etc/tmpfiles.d/ainvr-large-models.conf')
        expected=(R/'deploy-package/ainvr-large-models.tmpfiles.conf').read_text()
        assert not conf.exists() or conf.read_text()==expected, 'conflicting runtime-directory policy'
        conf.write_text(expected);run(['systemd-tmpfiles','--create',str(conf)])
        for name in ['backend','frontend']:
            target=R/'srs-web-console'/name/'dist'; prepared=target.with_name('dist.llm-next-'+stamp)
            shutil.copytree(built['artifacts'][name]['root'],prepared)
            if name=='frontend':
                for p in (target/'assets').glob('*'):
                    if p.is_file() and not (prepared/'assets'/p.name).exists():shutil.copy2(p,prepared/'assets'/p.name)
            previous=target.with_name('dist.llm-before-'+stamp)
            target.rename(previous);prepared.rename(target);swapped.append((target,previous))
        lines=original.splitlines()
        if 'Environment=MALLOC_ARENA_MAX=2' not in lines:
            lines.insert(lines.index('[Service]')+1,'Environment=MALLOC_ARENA_MAX=2')
        assert sum(x.startswith('ExecStart=') for x in lines)==1
        text='\n'.join('ExecStart='+str(binary)+' --bootstrap '+str(R/'deploy/s100p/runtime/llm-service-bootstrap.json') if x.startswith('ExecStart=') else 'WorkingDirectory='+str(release) if x.startswith('WorkingDirectory=') else x for x in lines)+'\n'
        tmp=unit.with_suffix('.service.next');tmp.write_text(text);os.replace(tmp,unit)
        run(['systemd-analyze','verify',str(unit)]);run(['systemctl','daemon-reload'])
        run(['systemctl','restart','ainvr-backend']);run(['systemctl','restart','ainvr-llm'])
        for _ in range(60):
            try:
                current=health('http://127.0.0.1:8300/health')
                backend=health('http://127.0.0.1:3001/api/health')
                if current['config_version']==old['config_version'] and current['model']=='unloaded' and current['admission']['mode']=='byte_accounted_coexistence' and backend['data']['status']=='ok':break
            except Exception:pass
            time.sleep(1)
        else:raise RuntimeError('new services did not acknowledge existing configuration')
        after={s:run(['systemctl','show',s,'-p','MainPID','--value']) for s in before}
        assert before==after,'unrelated service changed'
        report.update(health=current,console_artifacts=built['artifacts'],rollback_directories=[str(p) for _,p in swapped])
        record('deployed-unloaded');print(json.dumps({'phase':report['phase']}))
    except BaseException:
        unit.write_text(original)
        for target,previous in reversed(swapped):
            target.rename(target.with_name('dist.llm-failed-'+stamp));previous.rename(target)
        run(['systemctl','daemon-reload']);run(['systemctl','restart','ainvr-backend']);run(['systemctl','restart','ainvr-llm'])
        record('rolled-back');raise
if __name__=='__main__':main()
