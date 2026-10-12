#!/usr/bin/env python3
"""AINVR atomic AI binary deployment on an already provisioned S100P.
Keeps all credentials, license state, channels and model files unchanged.
Run after build-ai-s100p.sh. --start restarts and verifies the service.
"""
import argparse,hashlib,json,os,re,shutil,signal,subprocess,time,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SYSTEM_UNIT=Path('/etc/systemd/system/ainvr-ai.service')
SSD_ROOT=Path('/mnt/ainvr-ssd')
PROC_ROOT=Path('/proc')
HEALTH_WAIT_SECONDS=30
def run(*args):
    return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=60).stdout

def validate_dependency_report(report):
    if 'not found' in report:
        raise ValueError('Missing binary dependencies')
    if re.search(r'\blib(?:onnxruntime|nvinfer|cuda|cudart)[^ /]*\.so', report):
        raise ValueError('Expected the S100P BPU service without a CPU or Jetson inference backend')

def service_healthy(health, require_business_ready=False, expected_version=None, require_license_valid=False):
    if not isinstance(health, dict) or not isinstance(health.get('media'), dict):
        return False
    try:
        validate_runtime_info({'version': health.get('version'), 'ffmpeg': health['media'].get('ffmpeg')})
    except ValueError:
        return False
    if expected_version is not None and health.get('version') != expected_version:
        return False
    if require_license_valid and (not isinstance(health.get('business'), dict)
            or health['business'].get('license_phase') != 'valid'
            or health['business'].get('license_allowed') is not True):
        return False
    if require_business_ready and (not isinstance(health.get('business'), dict)
            or health['business'].get('ready') is not True):
        return False
    return (health.get('status') == 'ok' and isinstance(health.get('capabilities'), dict)
        and health['capabilities'].get('model_providers') == ['bpu'])

def validate_runtime_info(info):
    if not isinstance(info, dict) or not isinstance(info.get('version'), str) \
            or not info['version'].startswith('ainvr-s100p-reused-control-'):
        raise ValueError('Expected the original-controller S100P service')
    ffmpeg = info.get('ffmpeg')
    expected = {'version': '8.1.2', 'avformat_version': (62 << 16) | (12 << 8) | 102,
        'avcodec_version': (62 << 16) | (28 << 8) | 102,
        'avutil_version': (60 << 16) | (26 << 8) | 102}
    if not isinstance(ffmpeg, dict) or any(ffmpeg.get(k) != v for k, v in expected.items()):
        raise ValueError('Expected the pinned FFmpeg 8.1.2 runtime and matching media libraries')

def parse_binary_runtime(output):
    candidates = []
    for line in output.splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict) and 'version' in item and 'ffmpeg' in item:
            candidates.append(item)
    if len(candidates) != 1:
        raise ValueError('Binary did not report one unambiguous media runtime')
    validate_runtime_info(candidates[0])
    return candidates[0]

def service_state(kind):
    result=subprocess.run(['systemctl',kind,'ainvr-ai.service'],
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=10)
    state=result.stdout.strip()
    allowed={'is-enabled':{'enabled','enabled-runtime','disabled','linked','linked-runtime','static','indirect'},
             'is-active':{'active','inactive','failed','activating','deactivating','reloading'}}
    if state not in allowed[kind] or result.returncode not in (0,1,3):
        raise RuntimeError('Cannot determine original AI service state')
    return state

def deployed_binary_matches(pid,target,expected_sha256):
    if pid<=0:return False
    executable=PROC_ROOT/str(pid)/'exe'
    try:
        return (executable.resolve(strict=True)==target.resolve(strict=True)
            and hashlib.sha256(executable.read_bytes()).hexdigest()==expected_sha256)
    except OSError:
        return False

def restore_boot_state(state,unit,system):
    if state in ('enabled','enabled-runtime'):
        args=['systemctl','enable']
        if state=='enabled-runtime':args.append('--runtime')
        run(*args,'ainvr-ai.service')
    else:
        run('systemctl','disable','ainvr-ai.service')
        # systemctl disable can remove the original external unit symlink too.
        if not system.exists() and not system.is_symlink():system.symlink_to(unit)
        if not system.is_symlink() or system.resolve()!=unit.resolve():
            raise RuntimeError('AI unit link changed during rollback')
def atomic(path,data,mode):
    temp=path.with_name(path.name+'.install-'+str(os.getpid()))
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)
    try:
        with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        os.replace(temp,path)
        fd=os.open(path.parent,os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
    finally:
        if temp.exists():temp.unlink()
def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--binary',type=Path,default=ROOT/'out/build/ai-s100p/ainvr_s100p_control_service')
    p.add_argument('--start',action='store_true');args=p.parse_args()
    if os.geteuid()!=0:raise SystemExit('Run as root on the target S100P')
    source=args.binary.resolve(strict=True);data=source.read_bytes()
    if data[:4]!=b'\x7fELF' or data[4:6]!=b'\x02\x01' or int.from_bytes(data[18:20],'little')!=183:
        raise SystemExit('Expected a little-endian AArch64 ELF executable')
    validate_dependency_report(run('ldd',str(source)))
    diagnostic = subprocess.run([str(source), '--runtime-info'], check=True, timeout=10,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    candidate_runtime=parse_binary_runtime(diagnostic.stdout)
    candidate_sha256=hashlib.sha256(data).hexdigest()
    protected={}
    for rel in ['deploy/s100p/runtime/ai-service.json','deploy/s100p/runtime/ai-service.env','data/ai/config_overlay.json']:
        if not (ROOT/rel).is_file():raise SystemExit('Provision AI configuration before installation: '+rel)
        protected[rel]=hashlib.sha256((ROOT/rel).read_bytes()).hexdigest()
    unit=ROOT/'deploy/s100p/ainvr-ai.service';oldunit=unit.read_bytes()
    system=SYSTEM_UNIT
    if not system.is_symlink() or system.resolve()!=unit.resolve():
        raise SystemExit('Expected the existing AINVR-managed AI unit symlink')
    bindir=ROOT/'deploy/s100p/bin';bindir.mkdir(exist_ok=True)
    target=bindir/'ainvr_ai_service'
    oldbinary=target.read_bytes() if target.exists() else None
    text=oldunit.decode();lines=text.splitlines();commands=[l for l in lines if l.startswith('ExecStart=')]
    if len(commands)!=1:raise SystemExit('Unexpected service command')
    command=commands[0];parts=command.split(' ',1)
    if len(parts)!=2 or not parts[0].startswith('ExecStart='+str(ROOT)+'/'):
        raise SystemExit('Service executable is outside the AINVR root')
    newunit=text.replace(command,'ExecStart='+str(target)+' '+parts[1]).encode()
    if not SSD_ROOT.is_mount():
        raise SystemExit('Mount the AINVR SSD before creating deployment backups')
    backup=SSD_ROOT/'migration-backups'/('ai-install-'+time.strftime('%Y%m%d-%H%M%S')+'-'+str(os.getpid()))
    backup.parent.mkdir(parents=True,exist_ok=True)
    backup.mkdir(mode=0o700)
    (backup/'ainvr-ai.service').write_bytes(oldunit)
    previous=Path(parts[0].removeprefix('ExecStart='))
    shutil.copy2(previous,backup/'ainvr_ai_service')
    boot_before=service_state('is-enabled')
    active_before=service_state('is-active') in ('active','activating','reloading')
    (backup/'deployment-state.json').write_text(json.dumps({'boot_state':boot_before,
        'active':active_before,'configuration_sha256':protected,
        'candidate_sha256':candidate_sha256,'candidate_version':candidate_runtime['version']},indent=2)+'\n')
    require_business_ready = False
    require_license_valid = False
    if args.start:
        try:
            with urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3) as r:
                previous_health=json.load(r)
            previous_business = previous_health.get('business', {})
            require_license_valid = previous_business.get('license_phase') == 'valid'
            # Older S100P builds reported license permission as overall readiness,
            # omitting archive health. Preserve that known permission, without
            # treating the missing archive assessment as a prior success.
            require_business_ready = previous_business.get('ready') is True
            if (previous_health.get('version') == 'ainvr-s100p-reused-control-0.10'
                    and require_license_valid
                    and 'license_allowed' not in previous_business
                    and 'archive_unavailable_channels' not in previous_business):
                require_business_ready = False
        except (OSError,ValueError):
            pass
    boot_touched=False
    service_touched=False
    if unit.read_bytes()!=oldunit or (target.read_bytes() if target.exists() else None)!=oldbinary:
        raise RuntimeError('Concurrent AI executable or unit change; installation cancelled')
    if any(hashlib.sha256((ROOT/rel).read_bytes()).hexdigest()!=digest for rel,digest in protected.items()):
        raise RuntimeError('Concurrent AI configuration change; installation cancelled')
    def interrupted(_signum,_frame):
        raise InterruptedError('AI installation interrupted; restoring previous deployment')
    handlers={s:signal.getsignal(s) for s in (signal.SIGINT,signal.SIGTERM)}
    for s in handlers:signal.signal(s,interrupted)
    try:
        # Both replacements belong to the rollback boundary. atomic() can fail
        # after rename (directory fsync), so rollback examines installed bytes.
        atomic(target,data,0o755);atomic(unit,newunit,0o644)
        run('systemctl','daemon-reload')
        boot_touched=True
        run('systemctl','enable','ainvr-ai.service')
        if args.start:
            service_touched=True
            run('systemctl','restart','ainvr-ai.service')
            deadline=time.monotonic()+HEALTH_WAIT_SECONDS
            while True:
                try:
                    with urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=2) as r:
                        health=json.load(r)
                    pid=int(run('systemctl','show','ainvr-ai.service','-p','MainPID','--value').strip())
                    if (deployed_binary_matches(pid,target,candidate_sha256)
                            and service_healthy(health,require_business_ready,candidate_runtime['version'],require_license_valid)):break
                except (OSError,ValueError):pass
                if time.monotonic()>deadline:raise RuntimeError('Deployed service health verification timed out')
                time.sleep(.25)
    except BaseException:
        # Complete recovery even if a second termination request arrives.
        for s in handlers:signal.signal(s,signal.SIG_IGN)
        # Preserve a concurrent edit rather than overwrite it during recovery.
        current_unit=unit.read_bytes()
        if current_unit not in (oldunit,newunit):
            raise RuntimeError('Concurrent AI unit change; automatic rollback cannot overwrite it')
        if current_unit!=oldunit:atomic(unit,oldunit,0o644)
        current_binary=target.read_bytes() if target.exists() else None
        if current_binary not in (oldbinary,data):
            raise RuntimeError('Concurrent AI binary change; automatic rollback cannot overwrite it')
        if current_binary!=oldbinary:
            if oldbinary is not None:atomic(target,oldbinary,0o755)
            elif target.exists():target.unlink()
        run('systemctl','daemon-reload')
        if boot_touched:restore_boot_state(boot_before,unit,system)
        if service_touched:
            run('systemctl','restart' if active_before else 'stop','ainvr-ai.service')
        raise
    finally:
        for s,handler in handlers.items():signal.signal(s,handler)
    print(json.dumps({'installed':str(target),'sha256':candidate_sha256,
        'version':candidate_runtime['version'],
        'restarted_and_healthy':args.start,'business_readiness_preserved':require_business_ready,
        'rollback':str(backup)}))
if __name__=='__main__':main()
