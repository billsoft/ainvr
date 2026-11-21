#!/usr/bin/env python3
"""Paired backend/frontend/alarm publisher. Default read-only; no automatic rollback.

Run on 190 from the repository. --execute is reserved for the release operator.
Legacy repository alarm code requires an explicit full git revision of the running
process; dirty working-tree sources are NEVER used as its rollback authority.
"""
import argparse,fcntl,io,json,os,re,shutil,subprocess,tarfile,time,uuid
from pathlib import Path
import release_common as common
import deploy_ptz_release as previous

ROOT=Path(__file__).resolve().parents[1]
SSD=Path('/mnt/ainvr-ssd')
BACKUPS=SSD/'ainvr-rollback'
RELEASES=SSD/'ainvr-release'
NODE='/opt/node-v26.13.0-linux-arm64/bin/node'
BACKEND=ROOT/'srs-web-console/backend/dist'
FRONTS=[ROOT/'srs-web-console/frontend/dist',Path('/home/sunrise/ainvr/srs-web-console/frontend/dist')]
DROPIN=Path('/etc/systemd/system/ainvr-alarm.service.d/95-ptz-control.conf')
BOOTSTRAP=ROOT/'deploy/s100p/runtime/alarm-service-bootstrap.json'
SERVICES=['backend','web','alarm-service']

def run(args,timeout=60):
    # Do not leak subprocess stderr/arguments containing live configuration.
    result=subprocess.run(list(map(str,args)),capture_output=True,text=True,timeout=timeout)
    if result.returncode:raise RuntimeError('Command failed: '+str(args[0]))
    return result.stdout.strip()

def save(path,value):common.atomic_bytes(path,(json.dumps(value,indent=2)+'\n').encode())

def failure(error,stage):
    # Include actionable errors, never subprocess output or credential-bearing URLs.
    message=re.sub(r'(?:https?|mongodb(?:\+srv)?):\/\/\S+','[URL]',str(error))[:500]
    return {'stage':stage,'type':type(error).__name__,'message':message}

def cleanup(record,persist):
    """Retention is maintenance after acceptance, never a reason to stop service."""
    warnings=[];old=previous.require_ssd
    try:
        previous.require_ssd=require_ssd
        for service in SERVICES:
            try:previous.prune(service)
            except Exception as error:warnings.append({'service':service,**failure(error,'retention')})
    finally:previous.require_ssd=old
    record['cleanupWarnings']=warnings;record['stage']='complete';persist()
    return warnings

def require_ssd():
    if not SSD.is_mount() or SSD.stat().st_dev==Path('/').stat().st_dev:
        raise RuntimeError('Mounted external SSD required')
    for p in [ROOT,BACKUPS,RELEASES]:
        if p.is_symlink() or not p.resolve().is_relative_to(SSD) or p.resolve().stat().st_dev!=SSD.stat().st_dev:
            raise RuntimeError('Expected existing real SSD directory: '+str(p))

def validate(candidate):
    candidate=common.validate(candidate)
    status=json.loads((candidate/'status.json').read_text())
    marker=json.loads((candidate/'backend/ptz-compatibility.json').read_text())
    if status.get('motionAdmissionVersion')!=1 or marker.get('motionAdmissionVersion')!=1:
        raise ValueError('Paired motion protocol 1 candidate required')
    artifacts=json.loads((candidate/'artifacts.json').read_text())
    if not {'backend','frontend','alarm-src','deploy-package','shared'}<=artifacts.keys():
        raise ValueError('Incomplete paired release')
    for folder,expected in artifacts.items():
        common.relative(folder)
        if not expected or common.files(candidate/folder)!=expected:raise ValueError('Artifact changed: '+folder)
    for entry in ['main.mjs','motion-admission.mjs','ingestion.mjs','observation-pump.mjs']:
        if not (candidate/'alarm-src'/entry).is_file():raise ValueError('Alarm protocol implementation missing')
    sources=json.loads((candidate/'source-manifest.json').read_text())
    if not {'alarm-service/package.json','alarm-service/package-lock.json'}<=sources.keys():raise ValueError('Alarm dependency fence missing')
    for name in ['deploy_ptz_motion.py','ptz-motion-state.mjs','test_deploy_ptz_motion.py']:
        rel='deploy-package/'+name
        if rel not in sources or not (candidate/rel).is_file() or common.sha(candidate/rel)!=sources[rel]:
            raise ValueError('Publisher missing from source/artifact fence: '+name)
    # No independently assembled alarm tree may borrow a backend's marker.
    for name,digest in artifacts['alarm-src'].items():
        if sources.get('alarm-service/src/'+name)!=digest:raise ValueError('Mixed alarm generation')
    return candidate

def probe():return json.loads(run([NODE,ROOT/'deploy-package/ptz-motion-state.mjs',ROOT],30))

def require_no_legacy(state):
    if not isinstance(state.get('legacyPending'),int) or state['legacyPending']!=0:
        raise RuntimeError('Legacy pending outcomes require original-engine recovery; nothing discarded')

def identities():
    watched=previous.WATCHED+['ainvr-ai','ainvr-onvif','ainvr-gb28181']
    result={u:run(['systemctl','show',u,'--property=MainPID,ActiveState,ExecMainStartTimestampMonotonic']) for u in watched}
    result['srs']=run(['docker','inspect','--format','{{.State.Pid}} {{.State.StartedAt}}','ainvr-srs'])
    return result

def fingerprints():
    result=previous.fingerprints()
    result['alarm_bootstrap']=common.sha(BOOTSTRAP)
    return result

def pid(unit):return int(run(['systemctl','show',unit,'--value','--property=MainPID']))

def alarm_source(legacy):
    current=pid('ainvr-alarm')
    if current<=0:raise RuntimeError('Alarm must be running for initial process identity verification')
    args=(Path('/proc')/str(current)/'cmdline').read_bytes().decode().split('\0')
    mains=[Path(a) for a in args if a.endswith('/src/main.mjs')]
    if len(mains)!=1 or '--config-center' not in args or args[args.index('--config-center')+1]!=str(BOOTSTRAP):
        raise RuntimeError('Unexpected alarm process/bootstrap')
    source=mains[0].parent
    if source==ROOT/'alarm-service/src':
        if not legacy or not re.fullmatch('[0-9a-f]{40}',legacy):raise ValueError('Explicit --legacy-alarm-revision full SHA required')
        if run(['git','-C',ROOT,'rev-parse',legacy+'^{commit}'])!=legacy:raise ValueError('Legacy revision mismatch')
        return {'pid':current,'source':str(source),'legacy':legacy}
    if source.is_symlink() or not source.resolve().is_relative_to(RELEASES):raise RuntimeError('Unexpected alarm source location')
    return {'pid':current,'source':str(source),'legacy':None}

def backup_alarm(info,target):
    if info['legacy']:
        result=subprocess.run(['git','-C',str(ROOT),'archive',info['legacy'],'alarm-service/src'],capture_output=True,check=True,timeout=30)
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
            for member in archive:
                name=Path(member.name)
                if name==Path('alarm-service') or name==Path('alarm-service/src'):continue
                if not name.is_relative_to('alarm-service/src') or '..' in name.parts or not (member.isfile() or member.isdir()):
                    raise ValueError('Unsafe legacy archive')
                dest=target/name.relative_to('alarm-service')
                if member.isdir():dest.mkdir(parents=True,exist_ok=True)
                else:
                    dest.parent.mkdir(parents=True,exist_ok=True)
                    common.atomic_bytes(dest,archive.extractfile(member).read(),member.mode&0o777)
    else:shutil.copytree(info['source'],target/'src')
    if not (target/'src/main.mjs').is_file():raise RuntimeError('Legacy alarm backup entrypoint missing')

def preflight(candidate,legacy):
    candidate=validate(candidate);require_ssd()
    if BACKEND.is_symlink() or not BACKEND.is_dir():raise RuntimeError('Live backend dist must be a real directory')
    expected=str(BACKEND/'server.js')
    if expected not in run(['systemctl','show','ainvr-backend','--value','--property=ExecStart']):raise RuntimeError('Backend service target changed')
    for target in FRONTS:
        if not target.is_symlink() or not target.resolve(strict=True).is_relative_to(RELEASES):raise RuntimeError('Frontend live target changed')
    if FRONTS[0].resolve()!=FRONTS[1].resolve():raise RuntimeError('Frontend targets are already split')
    info=alarm_source(legacy);state=probe();require_no_legacy(state)
    return {'candidate':str(candidate),'alarm':info,'state':state,'configuration':fingerprints(),'watched':identities(),
            'backendPid':pid('ainvr-backend'),'frontTargets':[os.readlink(p) for p in FRONTS]}

def paired_switch(candidate,release,record):
    # Called only after durable backups. No network transaction lock spans Mongo.
    if pid('ainvr-alarm')!=record['before']['alarm']['pid'] or pid('ainvr-backend')!=record['before']['backendPid']:
        raise RuntimeError('Service process changed since preflight')
    record['stage']='source-fence-before-stop';validate(candidate)
    record['stage']='stop-alarm'
    run(['systemctl','stop','ainvr-alarm'])
    if pid('ainvr-alarm')!=0:raise RuntimeError('Alarm did not stop')
    record['stage']='pending-after-stop';stopped=probe();require_no_legacy(stopped)
    if stopped['configurationDigest']!=record['before']['state']['configurationDigest']:raise RuntimeError('Applied alarm configuration changed')
    record['stage']='stop-backend';run(['systemctl','stop','ainvr-backend'])
    if pid('ainvr-backend')!=0:raise RuntimeError('Backend did not stop')
    record['stage']='source-fence-after-stop';validate(candidate)
    if fingerprints()!=record['before']['configuration'] or identities()!=record['before']['watched']:raise RuntimeError('Configuration or unrelated service changed')
    record['stage']='replace-paired-programs';previous.swap_tree(candidate/'backend',BACKEND)
    for target in FRONTS:
        temp=target.with_name('.motion-link-'+uuid.uuid4().hex)
        temp.symlink_to(release/'frontend');os.replace(temp,target)
    content=f'[Service]\nWorkingDirectory={release}/alarm\nExecStart=\nExecStart={NODE} {release}/alarm/src/main.mjs --config-center {BOOTSTRAP}\n'
    common.atomic_bytes(DROPIN,content.encode(),0o644)
    run(['systemctl','daemon-reload'])
    record['stage']='start-backend';run(['systemctl','start','ainvr-backend']);common.ready()
    record['stage']='start-alarm';run(['systemctl','start','ainvr-alarm'])
    record['stage']='protocol-readiness'
    deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        try:
            state=probe()
            if state.get('protocolReady') is True:
                live=alarm_source(None)
                if live['source']!=str(release/'alarm/src'):raise RuntimeError('Alarm runtime is not pinned to candidate')
                return state
        except (RuntimeError,ValueError,subprocess.TimeoutExpired):pass
        time.sleep(1)
    raise RuntimeError('Paired motion protocol/complete-scope ACK readiness not confirmed')

def deploy(candidate,legacy):
    require_ssd()
    with (BACKUPS/'.ptz-motion.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        before=preflight(candidate,legacy);candidate=Path(before['candidate'])
        tag=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+str(time.time_ns())
        release=RELEASES/('motion-'+tag);release.mkdir(mode=0o755)
        paths={service:BACKUPS/service/tag for service in SERVICES}
        for p in paths.values():p.mkdir(parents=True,mode=0o700)
        record={'format':'ainvr-motion-v1','phase':'preparing','stage':'backup','before':before,'release':str(release),'backups':{k:str(v) for k,v in paths.items()}}
        journal=paths['backend']/'deployment.json'
        def persist():
            save(journal,record)
            for p in paths.values():save(p/'backup.json',{'format':'ainvr-motion-v1','phase':record['phase'],'transaction':str(journal)})
        persist();switching=False
        try:
            shutil.copytree(BACKEND,paths['backend']/'dist')
            shutil.copytree(FRONTS[0].resolve(),paths['web']/'dist')
            backup_alarm(before['alarm'],paths['alarm-service'])
            record['dropin']=common.snapshot_files([DROPIN],paths['alarm-service']/'units',ROOT)
            record['backupTrees']={k:common.files(p/('src' if k=='alarm-service' else 'dist')) for k,p in paths.items()}
            shutil.copytree(candidate/'frontend',release/'frontend')
            shutil.copytree(candidate/'alarm-src',release/'alarm/src')
            (release/'alarm/node_modules').symlink_to(ROOT/'alarm-service/node_modules',target_is_directory=True)
            # ESM needs the package's type and stable dependency authority.
            shutil.copy2(ROOT/'alarm-service/package.json',release/'alarm/package.json')
            artifacts=json.loads((candidate/'artifacts.json').read_text())
            if common.files(release/'frontend')!=artifacts['frontend'] or common.files(release/'alarm/src')!=artifacts['alarm-src']:raise RuntimeError('Staged release changed')
            record['phase']='prepared';persist()
            switching=True
            record['after']=paired_switch(candidate,release,record)
            record['stage']='postcheck'
            if fingerprints()!=before['configuration'] or identities()!=before['watched']:raise RuntimeError('Configuration/PID preservation verification failed')
            if common.files(BACKEND)!=artifacts['backend']:raise RuntimeError('Live backend artifact mismatch')
        except BaseException as error:
            record['phase']='failed';record['error']=failure(error,record['stage']);persist()
            # No half rollback. Disabling the alarm process leaves facts/counts
            # unconsumed while the operator repairs the paired release.
            if switching:run(['systemctl','stop','ainvr-alarm'])
            raise RuntimeError('Paired release failed at '+record['stage']+' ('+type(error).__name__+'); '+('alarm held stopped; ' if switching else '')+'no rollback. Inspect '+str(journal)) from error
        # Acceptance is complete. Neither retention nor recording maintenance
        # warnings may turn a verified healthy release into a stopped service.
        record['phase']='applied';record['stage']='accepted';persist()
        warnings=cleanup(record,persist)
        return {'phase':'applied','transaction':str(journal),'release':str(release),'cleanupWarnings':warnings}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate',type=Path,required=True)
    parser.add_argument('--legacy-alarm-revision')
    parser.add_argument('--execute',action='store_true')
    args=parser.parse_args()
    result=deploy(args.candidate,args.legacy_alarm_revision) if args.execute else preflight(args.candidate,args.legacy_alarm_revision)
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()
