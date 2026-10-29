"""Search adapter for deploy_ptz_release's single transactional publisher.

No entrypoint, credentials, model copies, service calls or database work occurs
at import/check time. Apply/rollback are explicit operations of that publisher.
"""
import hashlib,json,os,pwd,re,secrets,shlex,shutil,time,urllib.request,subprocess
from pathlib import Path
from release_common import atomic_bytes,snapshot_files,restore_files,files,sha

FORMAT='ainvr-search-v1'
SERVICES=('ai-service','llm-service','search-service','backend','web','helper')
UNITS={'ai-service':'ainvr-ai','llm-service':'ainvr-llm','search-service':'ainvr-search','backend':'ainvr-backend','helper':'ainvr-restart-helper'}
WATCHED=('ainvr-onvif','ainvr-gb28181','ainvr-gb-media','ainvr-recorder','ainvr-ingest','ainvr-alarm','ainvr-web','ainvr-license','ainvr-os-helper')
UNIT_ROOT=Path('/etc/systemd/system')
TMPFILES=Path('/etc/tmpfiles.d/ainvr-large-models.conf')
BINARY_ARTIFACTS={'ai-service':('search-ai','ainvr_ai_service'),'llm-service':('search-llm','ainvr_llm_service'),'search-service':('search-native','ainvr_search_service')}

def targets(root):
    return {name:root/'deploy/s100p/bin'/file for name,(_,file) in BINARY_ARTIFACTS.items()}

def elf(path):
    with path.open('rb') as stream:data=stream.read(64)
    if len(data)<20 or data[:6]!=b'\x7fELF\x02\x01' or int.from_bytes(data[18:20],'little')!=183:
        raise ValueError('Expected an AArch64 release executable')

def runtime_dependencies(path):
    """Inspect ELF metadata only; never execute an SDK/model-linked binary."""
    elf(path)
    dynamic=subprocess.run(['readelf','--dynamic',str(path)],capture_output=True,text=True,check=True,timeout=15).stdout
    approved={'/usr/hobot/lib','/usr/lib','/usr/lib/aarch64-linux-gnu','/lib','/lib/aarch64-linux-gnu','/opt/ainvr/ffmpeg-8.1.2/lib','$ORIGIN'}
    for line in dynamic.splitlines():
        if '(NEEDED)' in line:
            name=re.search(r'\[([^]]+)\]',line)
            if not name or '/' in name.group(1):raise ValueError('Release library must resolve from installed runtime')
        elif '(RPATH)' in line or '(RUNPATH)' in line:
            value=re.search(r'\[([^]]*)\]',line)
            if not value or any(entry not in approved for entry in value.group(1).split(':')):raise ValueError('Release has a build/SSD runtime dependency')

def validate(publisher,candidate):
    candidate=publisher.validate_console(candidate)
    status=json.loads((candidate/'status.json').read_text())
    if status.get('releaseProfile')!='search' or status.get('searchComponents') is not True:
        raise ValueError('A complete search-profile candidate is required')
    artifacts=json.loads((candidate/'artifacts.json').read_text())
    required={'frontend','backend','helper','shared','deploy-package','search-ai','search-llm','search-native'}
    if set(artifacts)!=required:raise ValueError('Search artifact set is incomplete or contains unrelated services')
    for name,expected in artifacts.items():
        if files(candidate/name)!=expected:raise ValueError('Search artifact changed: '+name)
        if any('models'in Path(relative).parts or Path(relative).suffix.lower()in ('.hbm','.onnx','.safetensors','.pth','.pt','.model')for relative in expected):raise ValueError('Model weights/tokenizers must not be packaged')
    if any('models' in Path(name).parts for name in json.loads((candidate/'source-manifest.json').read_text())):
        raise ValueError('User model packages must not be part of release source/artifacts')
    contract=json.loads((candidate/'search-native/build-contract.json').read_text())
    if contract!={'schema':1,'bpu_text':True,'tokenizer':True,'hardware_probes':False,'models_packaged':False}:
        raise ValueError('The production search executable must include BPU text and checked tokenizer')
    for folder,file in BINARY_ARTIFACTS.values():runtime_dependencies(candidate/folder/file)
    if not all((candidate/'helper'/name).is_file() for name in ('restart_helper.py','observability.py')):
        raise ValueError('Search host helper is incomplete')
    return candidate

def system_disk_paths(root,paths):
    """Runtime code/credentials may not silently follow an SSD bind/symlink."""
    device=root.stat().st_dev
    for path in paths:
        path=Path(path)
        if not path.is_relative_to(root):continue
        for parent in (path.parent,*path.parent.parents):
            if not parent.is_relative_to(root):break
            if parent.is_symlink():raise ValueError('Runtime directory must not be a symlink')
            if parent.exists()and parent.stat().st_dev!=device:raise ValueError('Runtime must remain on the system disk')

def plan(publisher,candidate):
    candidate=validate(publisher,candidate)
    return {'verified':True,'profile':'search','candidate':str(candidate),'productionChanged':False,
      'services':list(SERVICES),'unchangedServices':list(WATCHED)+['SRS'],
      'searchConfiguration':'preserved; no enablement or storage selection',
      'reviewCaller':'Save and apply the LLM settings to provision search-verify independently',
      'backups':'mounted SSD only; maximum three per service','modelsPackaged':False}

def unit_text(root):
    return '\n'.join(['# Managed by AINVR search release profile','[Unit]',
      'Description=AINVR native search service','After=network-online.target ainvr-backend.service systemd-tmpfiles-setup.service',
      'Wants=network-online.target','StartLimitIntervalSec=300','StartLimitBurst=2','[Service]',
      'Type=simple','User=sunrise','Group=sunrise','WorkingDirectory='+str(root/'search-service'),
      'ExecStart='+str(targets(root)['search-service'])+' --managed-config '+str(root/'deploy/s100p/runtime/search-service-bootstrap.json'),
      'Restart=on-failure','RestartSec=15','TimeoutStopSec=45','KillMode=mixed',
      'NoNewPrivileges=true','UMask=0077','Environment=MALLOC_ARENA_MAX=2',
      'InaccessiblePaths=/sys/kernel/debug','[Install]','WantedBy=multi-user.target',''])

def managed_paths(root,candidate):
    runtime=root/'deploy/s100p/runtime'
    result={'ai-service':[], 'llm-service':[UNIT_ROOT/'ainvr-llm.service.d/96-search-release.conf'],
      'search-service':[UNIT_ROOT/'ainvr-search.service',runtime/'search-service-bootstrap.json',runtime/'search-service-backend.env',TMPFILES],
      'backend':[UNIT_ROOT/'ainvr-backend.service.d/60-search-service.conf'], 'web':[],
      'helper':[root/'shared/host-restart-helper'/name for name in ('restart_helper.py','observability.py')]}
    result['helper'] += [root/'shared'/relative for relative in files(candidate/'shared')]
    # Do not roll generated AI JSON/overlay caches back over newly applied PG
    # state. The publisher never edits those caches; the config client owns
    # their regeneration. Deployment credentials/env are private SSD snapshots.
    result['ai-service'] += [runtime/'ai-service.env']
    result['llm-service'] += [runtime/'llm-service-bootstrap.json',runtime/'llm-service-backend.env']
    result['backend'] += [runtime/'backend.env']
    result['helper'] += [runtime/'restart-helper.env']
    # Existing unit files and all existing drop-ins/env remain private snapshots;
    # changes are made only to the explicit owned paths above.
    for service,unit in UNITS.items():
        file=UNIT_ROOT/(unit+'.service')
        if file not in result[service]:result[service].append(file)
        directory=UNIT_ROOT/(unit+'.service.d')
        if directory.is_symlink():raise ValueError('Unit drop-in directory cannot be a symlink')
        if directory.exists():result[service] += [p for p in sorted(directory.iterdir()) if p not in result[service]]
    return result

def service_state(publisher,unit,optional=False):
    text=publisher.run(['systemctl','show',unit,'--property=LoadState,ActiveState,UnitFileState,MainPID,ExecStart'])
    values=dict(line.split('=',1) for line in text.splitlines() if '=' in line)
    if optional and values.get('LoadState')=='not-found':return {'exists':False,'active':False,'enabled':'not-found','executable':None,'pid':0}
    if values.get('LoadState')!='loaded' or values.get('ActiveState') not in ('active','inactive','failed'):
        raise ValueError('Cannot snapshot stable service state: '+unit)
    enabled=values.get('UnitFileState')
    if enabled not in ('enabled','enabled-runtime','disabled','static','linked','linked-runtime'):
        raise ValueError('Unsupported original service enablement: '+unit)
    command=re.search(r'\bpath=([^ ;}]+)',values.get('ExecStart',''))
    if not command:raise ValueError('Cannot identify service executable: '+unit)
    pid=int(values.get('MainPID','0'))
    if values['ActiveState']=='active' and pid<=0:raise ValueError('Active service has no process: '+unit)
    return {'exists':True,'active':values['ActiveState']=='active','enabled':enabled,'executable':command.group(1),'pid':pid}

def stop(publisher,unit,optional=False):
    if optional and publisher.run(['systemctl','show',unit,'--value','--property=LoadState'])=='not-found':return
    publisher.run(['systemctl','stop',unit])
    state=publisher.run(['systemctl','show',unit,'--property=MainPID,ActiveState'])
    parts=dict(line.split('=',1) for line in state.splitlines() if '=' in line)
    if parts.get('MainPID')!='0' or parts.get('ActiveState') not in ('inactive','failed'):
        raise RuntimeError('Service has not released process ownership: '+unit)

def identity_files(root,owner):
    runtime=root/'deploy/s100p/runtime';bootstrap=runtime/'search-service-bootstrap.json';environment=runtime/'search-service-backend.env'
    if bootstrap.exists()!=environment.exists():raise ValueError('Incomplete search identity requires reconciliation')
    if bootstrap.exists():
        for path in (bootstrap,environment):
            if path.is_symlink() or not path.is_file() or path.stat().st_nlink!=1 or path.stat().st_size>16384 or path.stat().st_mode&0o077 or path.stat().st_uid!=owner.pw_uid:
                raise ValueError('Search identity must be private and owned by sunrise')
        value=json.loads(bootstrap.read_text());text=environment.read_text()
        token=value.get('service_token','')
        if value.get('control_url')!='http://127.0.0.1:3001' or not isinstance(token,str) or not re.fullmatch(r'[A-Za-z0-9._~-]{32,512}',token) or text!='CONFIG_SERVICE_TOKEN_SEARCH_SERVICE='+token+'\nSEARCH_SERVICE_HOST=127.0.0.1\n':
            raise ValueError('Search identity does not match the backend caller')
        return {}
    token=secrets.token_hex(48)
    return {bootstrap:(json.dumps({'control_url':'http://127.0.0.1:3001','service_token':token},separators=(',',':'))+'\n').encode(),
      environment:('CONFIG_SERVICE_TOKEN_SEARCH_SERVICE='+token+'\nSEARCH_SERVICE_HOST=127.0.0.1\n').encode()}

def write_set(root,candidate,owner):
    result={path:(data,0o600,(owner.pw_uid,owner.pw_gid)) for path,data in identity_files(root,owner).items()}
    result[UNIT_ROOT/'ainvr-search.service']=(unit_text(root).encode(),0o644,None)
    result[UNIT_ROOT/'ainvr-backend.service.d/60-search-service.conf']=(('[Service]\nEnvironmentFile='+str(root/'deploy/s100p/runtime/search-service-backend.env')+'\n').encode(),0o644,None)
    result[UNIT_ROOT/'ainvr-llm.service.d/96-search-release.conf']=(('[Service]\nWorkingDirectory='+str(root/'llm-service')+'\nExecStart=\nExecStart='+str(targets(root)['llm-service'])+' --bootstrap '+str(root/'deploy/s100p/runtime/llm-service-bootstrap.json')+'\n').encode(),0o644,None)
    for name in ('restart_helper.py','observability.py'):result[root/'shared/host-restart-helper'/name]=((candidate/'helper'/name).read_bytes(),0o644,None)
    for relative in files(candidate/'shared'):result[root/'shared'/relative]=((candidate/'shared'/relative).read_bytes(),0o644,None)
    policy=(candidate/'deploy-package/ainvr-large-models.tmpfiles.conf').read_bytes()
    if TMPFILES.exists():
        if TMPFILES.is_symlink() or TMPFILES.read_bytes()!=policy:raise ValueError('Conflicting shared BPU runtime-directory policy')
    else:result[TMPFILES]=(policy,0o644,None)
    return result

def fingerprint(path):
    if not path.exists() and not path.is_symlink():return None
    return {'link':os.readlink(path) if path.is_symlink() else None,'sha256':sha(path),'mode':path.stat().st_mode&0o777}

def durable_tree(path):
    # No symlink in a rollback tree is accepted by files(). Persist all bytes
    # and directory entries before the common publisher writes prepared state.
    files(path)
    for child in sorted(path.rglob('*'),reverse=True):
        fd=os.open(child,os.O_RDONLY|(os.O_DIRECTORY if child.is_dir() else 0)|os.O_NOFOLLOW)
        try:os.fsync(fd)
        finally:os.close(fd)
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)

def watched(publisher):
    values={unit:publisher.run(['systemctl','show',unit,'--property=MainPID,ActiveState,ExecMainStartTimestampMonotonic']) for unit in WATCHED}
    values['SRS']=publisher.run(['docker','inspect','--format','{{.State.Pid}} {{.State.StartedAt}}','ainvr-srs'])
    return values

def wait(publisher,service,expected):
    if service=='ai-service':publisher.wait_ai(expected);return
    url={'search-service':'http://127.0.0.1:8400/health','llm-service':'http://127.0.0.1:8300/health','backend':'http://127.0.0.1:3001/api/health'}.get(service)
    # A cold multi-GB HBM load and its configuration fetch can legitimately
    # exceed the old 50s probe window. Keep a bounded startup budget; running
    # or loading alone is never evidence that inference is ready.
    deadline=time.monotonic()+(180 if service=='llm-service' else 50)
    while time.monotonic()<deadline:
        try:
            pid=publisher.run(['systemctl','show',UNITS[service],'--value','--property=MainPID'])
            if expected and sha(Path('/proc')/pid/'exe')!=expected:raise ValueError()
            if not url:return
            with urllib.request.urlopen(url,timeout=2) as response:health=json.load(response)
            if service=='search-service' and health.get('alive') is True:return
            if service=='llm-service' and health.get('config_version',0)>0 and (
                (health.get('model')=='ready' and health.get('ready') is True) or health.get('model')=='disabled'):return
            if service=='backend' and health.get('data',{}).get('status')=='ok':return
        except (OSError,ValueError,subprocess.CalledProcessError):pass
        time.sleep(.25)
    raise RuntimeError('Release service liveness/hash check failed: '+service)

def parameter_state(publisher):
    return json.loads(publisher.run([publisher.NODE,publisher.ROOT/'deploy-package/search-production-state.mjs',publisher.ROOT]))

def parameters_unchanged(before,after):
    # New optional search settings may be introduced by additive PG migrations.
    # Existing documents, secrets and camera/arming state cannot be reset.
    if set(before)!=set(after):return False
    def migrated_seed(old_hash,new_hash):
        if not all(isinstance(value,str)and re.fullmatch('[a-f0-9]{64}',value)for value in (old_hash,new_hash)):return False
        pre=before.get('search_seed_020')or {};post=after.get('search_seed_020')or {}
        if not re.fullmatch('[a-f0-9]{64}',pre.get('migration_sha256',''))or pre.get('migration_sha256')!=post.get('migration_sha256'):return False
        eligible=pre.get('eligible')or {};completed=post.get('completed')or {}
        return (eligible.get('document_hash')==old_hash and eligible.get('expected_after_hash')==new_hash
          and completed.get('document_hash')==new_hash and eligible.get('document_id')==completed.get('document_id')
          and isinstance(eligible.get('desired_version'),int)and eligible['desired_version']==completed.get('version_before')
          and isinstance(completed.get('version_after'),int)and completed['version_after']>completed['version_before'])
    def initial_seed(new_hash):
        if not isinstance(new_hash,str)or not re.fullmatch('[a-f0-9]{64}',new_hash):return False
        proof=after.get('search_seed_020')or {}
        return bool(re.fullmatch('[a-f0-9]{64}',proof.get('migration_sha256',''))and any(
          (proof.get(state)or {}).get('document_hash')==new_hash for state in ('eligible','completed')))
    for name,want in before.items():
        got=after[name]
        if name=='config_documents':
            if any(got.get(key)!=value and not(key=='search-service/system/settings'and migrated_seed(value,got.get(key)))for key,value in want.items()):return False
            if any(key not in want and not(key=='search-service/system/settings'and initial_seed(got[key]))for key in got):return False
        elif name=='search_seed_020':continue # proof is checked only for the exact allowed document transition
        elif got!=want:return False
    return True

def _check_snapshot_paths(publisher,state):
    root=publisher.ROOT
    for service,records in state['managedFiles'].items():
        if service not in SERVICES:raise ValueError('Unknown rollback service')
        for name,record in records.items():
            path=Path(name)
            if not (path.is_relative_to(root) or path==TMPFILES or path==UNIT_ROOT/(UNITS.get(service,'')+'.service') or
              (service in UNITS and path.parent==UNIT_ROOT/(UNITS[service]+'.service.d'))):
                raise ValueError('Rollback file escapes profile allowlist')
            if record.get('link') and not Path(record['target']).is_relative_to(root):raise ValueError('Rollback unit symlink escapes repository')

def check_rollback(publisher,state,paths):
    if state.get('format')!=FORMAT or set(paths)!=set(SERVICES) or state.get('phase')=='rolled_back' or state.get('retentionRemoved'):
        raise ValueError('Invalid or incomplete search rollback transaction')
    _check_snapshot_paths(publisher,state)
    for service,path in paths.items():
        if path.is_symlink() or path.resolve().parent!=(publisher.BACKUPS/service).resolve():raise ValueError('Invalid search rollback path')
        actual=files(path)
        for name,digest in state['integrity'][service].items():
            if actual.get(name)!=digest:raise ValueError('Search rollback artifact changed: '+service)
    for service,target in targets(publisher.ROOT).items():
        if fingerprint(target) not in state['allowedBinaries'][service]:raise ValueError('Concurrent search binary deployment: '+service)
    for service,folder in (('backend','backend'),('web','frontend')):
        if files(publisher.ROOT/'srs-web-console'/folder/'dist') not in state['allowedTrees'][service]:raise ValueError('Concurrent console deployment')
    for name,allowed in state['allowedFiles'].items():
        if fingerprint(Path(name)) not in allowed:raise ValueError('Concurrent managed configuration change')

def _resume(publisher,state,first_install=False):
    # Keep original boot and running intent. Only a newly introduced daemon is
    # started on installation; its PG enabled flag remains unchanged/disabled.
    for service in ('backend','helper','llm-service','ai-service','search-service'):
        old=state['serviceStates'][service];unit=UNITS[service]
        # Existing boot intent is never changed by this profile. In particular
        # systemctl disable can remove linked unit files, so do not use it as a
        # pretend no-op for originally disabled/linked installations.
        if old['exists']:
            if old['active']:publisher.run(['systemctl','start',unit])
        elif first_install and service=='search-service':publisher.run(['systemctl','enable','--now',unit])

def rollback(publisher,backup):
    publisher.require_ssd();backup=backup.resolve(strict=True)
    if backup.parent!=publisher.BACKUPS/'backend':raise ValueError('Expected backend SSD rollback transaction')
    state=json.loads((backup/'deployment.json').read_text());paths={key:Path(value) for key,value in state['backups'].items()}
    check_rollback(publisher,state,paths);publisher.ptz_preflight(publisher.ROOT,paths['backend']/'dist')
    # Stop sampling/search before restoring ANY old AI/LLM runtime. A failed
    # stop is fatal; do not load another vendor model over unknown task custody.
    for service in ('search-service','ai-service','backend','llm-service','helper'):
        if service=='search-service' or state['serviceStates'][service]['exists']:stop(publisher,UNITS[service],service=='search-service')
    check_rollback(publisher,state,paths)
    if not state['serviceStates']['search-service']['exists']:
        # Remove only enablement created for the newly introduced daemon,
        # before restoring the original (absent) unit and private identity.
        if publisher.run(['systemctl','show','ainvr-search','--value','--property=LoadState'])!='not-found':publisher.run(['systemctl','disable','ainvr-search'])
    for service,records in state['managedFiles'].items():restore_files(records,paths[service]/'managed',records,publisher.ROOT)
    for service,target in targets(publisher.ROOT).items():
        if state['serviceStates'][service]['exists']:publisher.atomic_file(paths[service]/'binary',target)
        elif target.exists():target.unlink()
    # Original LLM release directories may have been pruned. Override only its
    # executable/cwd, using the exact old binary materialized from verified SSD.
    if state['serviceStates']['llm-service']['exists']:
        text='[Service]\nWorkingDirectory='+str(publisher.ROOT/'llm-service')+'\nExecStart=\nExecStart='+str(targets(publisher.ROOT)['llm-service'])+' --bootstrap '+str(publisher.ROOT/'deploy/s100p/runtime/llm-service-bootstrap.json')+'\n'
        atomic_bytes(UNIT_ROOT/'ainvr-llm.service.d/96-search-release.conf',text.encode(),0o644)
    for service,folder in (('backend','backend'),('web','frontend')):publisher.swap_tree(paths[service]/'dist',publisher.ROOT/'srs-web-console'/folder/'dist')
    publisher.run(['systemctl','daemon-reload']);_resume(publisher,state)
    for service in ('backend','llm-service','ai-service','search-service'):
        if state['serviceStates'][service]['active']:
            expected=sha(paths[service]/'binary') if service in BINARY_ARTIFACTS else None
            wait(publisher,service,expected)
    if watched(publisher)!=state['watched']:raise RuntimeError('An unrelated service changed during rollback')
    state['phase']='rolled_back';publisher.save(backup/'deployment.json',state)
    for service,path in paths.items():publisher.save(path/'backup.json',{'service':service,'phase':'rolled_back','at':time.time()})
    return {'rolledBack':True,'profile':'search','configurationRestored':False,'schemaRetained':True,'source':'verified SSD backups'}

def apply(publisher,candidate):
    candidate=validate(publisher,candidate);publisher.require_ssd();publisher.backend_ready()
    if shutil.disk_usage(publisher.ROOT).free<1<<30 or shutil.disk_usage(publisher.SSD).free<256<<20:raise ValueError('Insufficient release/rollback storage')
    owner=pwd.getpwnam('sunrise');root=publisher.ROOT
    states={service:service_state(publisher,unit,service=='search-service') for service,unit in UNITS.items()}
    for service,unit in UNITS.items():
        if states[service]['exists']and not(UNIT_ROOT/(unit+'.service')).exists():raise ValueError('Expected a managed /etc unit: '+unit)
    for service in ('ai-service','llm-service'):
        executable=Path(states[service]['executable'])
        if not executable.is_relative_to(root):raise ValueError('Unsupported installed binary location')
    before=parameter_state(publisher);observers=watched(publisher)
    managed=managed_paths(root,candidate)
    system_disk_paths(root,[*targets(root).values(),*[path for group in managed.values()for path in group]])
    writes=write_set(root,candidate,owner)
    stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+str(time.time_ns());paths={}
    try:
        for service in SERVICES:
            bucket=publisher.BACKUPS/service
            if bucket.is_symlink():raise ValueError('Service backup bucket must not be a symlink')
            if bucket.exists():publisher.prune(service)
            bucket.mkdir(mode=0o700,exist_ok=True)
            path=bucket/stamp;path.mkdir(mode=0o700);paths[service]=path
            publisher.save(path/'backup.json',{'service':service,'phase':'preparing','at':time.time()})
    except BaseException:
        for service,path in paths.items():
            if path.parent==publisher.BACKUPS/service and not path.is_symlink():shutil.rmtree(path)
        raise
    state={'format':FORMAT,'phase':'preparing','profile':'search','backups':{key:str(path) for key,path in paths.items()},
      'serviceStates':states,'configuration':before,'watched':observers,'managedFiles':{},'allowedFiles':{},'allowedBinaries':{},'allowedTrees':{}}
    record=paths['backend']/'deployment.json';changed=False
    try:
        for service,items in managed.items():
            state['managedFiles'][service]=snapshot_files(items,paths[service]/'managed',root)
            for path in items:state['allowedFiles'][str(path)]=[fingerprint(path)]
        for path,(data,mode,_) in writes.items():
            state['allowedFiles'][str(path)].append({'link':None,'sha256':hashlib.sha256(data).hexdigest(),'mode':mode})
        for service,target in targets(root).items():
            state['allowedBinaries'][service]=[fingerprint(target)]
            folder,file=BINARY_ARTIFACTS[service]
            state['allowedBinaries'][service].append({'link':None,'sha256':sha(candidate/folder/file),'mode':0o755})
            if states[service]['exists']:
                source=Path(states[service]['executable'])
                if source.is_symlink() or not source.is_file():raise ValueError('Installed executable is not a regular eMMC file')
                if states[service]['active'] and sha(Path('/proc')/str(states[service]['pid'])/'exe')!=sha(source):raise ValueError('Running executable differs from installed release')
                atomic_bytes(paths[service]/'binary',source.read_bytes(),0o755)
        for service,folder in (('backend','backend'),('web','frontend')):
            source=root/'srs-web-console'/folder/'dist';shutil.copytree(source,paths[service]/'dist')
            state['allowedTrees'][service]=[files(source),files(candidate/folder)]
        for path in paths.values():durable_tree(path)
        state['integrity']=publisher.backup_inventory(paths)
        for inventory in state['integrity'].values():inventory.pop('backup.json',None)
        state['phase']='prepared';publisher.save(record,state)
        changed=True
        for service in ('search-service','ai-service','backend','llm-service','helper'):
            if states[service]['exists']:stop(publisher,UNITS[service])
        for service,target in targets(root).items():
            target.parent.mkdir(parents=True,exist_ok=True);folder,file=BINARY_ARTIFACTS[service];publisher.atomic_file(candidate/folder/file,target);target.chmod(0o755)
        for path,(data,mode,file_owner) in writes.items():atomic_bytes(path,data,mode,file_owner)
        for service,folder in (('backend','backend'),('web','frontend')):publisher.swap_tree(candidate/folder,root/'srs-web-console'/folder/'dist')
        publisher.run(['systemd-analyze','verify',UNIT_ROOT/'ainvr-search.service'])
        publisher.run(['systemd-tmpfiles','--create',TMPFILES]);publisher.run(['systemctl','daemon-reload'])
        _resume(publisher,state,True)
        for service in ('backend','llm-service','ai-service','search-service'):
            if states[service]['active'] or (service=='search-service' and not states[service]['exists']):
                expected=sha(targets(root)[service]) if service in BINARY_ARTIFACTS else None;wait(publisher,service,expected)
        if watched(publisher)!=observers:raise RuntimeError('An unrelated camera/media service changed')
        if not parameters_unchanged(before,parameter_state(publisher)):raise RuntimeError('Existing customer parameters changed')
        state['phase']='applied';publisher.save(record,state)
        for service,path in paths.items():publisher.save(path/'backup.json',{'service':service,'phase':'applied','at':time.time()})
    except BaseException:
        if changed:
            state['phase']='failed';publisher.save(record,state);rollback(publisher,paths['backend'])
        else:
            # Nothing live was changed. Keep no unrecognized half-transaction.
            for service,path in paths.items():
                if path.parent!=publisher.BACKUPS/service or path.is_symlink():raise ValueError('Unsafe incomplete backup')
                shutil.rmtree(path)
        raise
    for service in SERVICES:publisher.prune(service)
    return {'applied':True,'profile':'search','rollback':str(paths['backend']),'configurationPreserved':True,
      'modelsPackaged':False,'searchEnablementChanged':False,'backups':'SSD only; maximum three per service'}

def prepare_components(root,out,run,builds):
    """Build only the three selected targets, never execute them or load HBM.

    Build inputs can reside on SSD. Only their statically linked output and
    installed eMMC SDK/FFmpeg runtime may be needed after installation.
    """
    configurations={
      'ai-service':('ai-service','ainvr_s100p_control_service',['-DAINVR_S100P=ON','-DAINVR_BUILD_CPU_REFERENCE=OFF']),
      'llm-service':('llm-service','ainvr_llm_service',[]),
      'search-service':('search-service','ainvr_search_service',['-DAINVR_SEARCH_WITH_TOKENIZER=ON','-DAINVR_SEARCH_WITH_BPU_TEXT=ON','-DAINVR_SEARCH_BUILD_HARDWARE_PROBES=OFF'])}
    for service,(source,target,flags) in configurations.items():
        build=builds[service]
        if build.is_symlink() or not build.resolve().is_relative_to(root/'out') or build.is_relative_to(out):raise ValueError('Use isolated build directories under repository out/, outside candidate')
        run(['cmake','-S',str(root/source),'-B',str(build),'-DCMAKE_BUILD_TYPE=Release','-DBUILD_TESTING=OFF',*flags],root,service+'-configure',300)
        run(['cmake','--build',str(build),'--target',target,'-j2'],root,service+'-build',1800)
        cache=(build/'CMakeCache.txt').read_text()
        required={'ai-service':['AINVR_S100P:BOOL=ON','AINVR_BUILD_CPU_REFERENCE:BOOL=OFF'],
          'llm-service':[], 'search-service':['AINVR_SEARCH_WITH_TOKENIZER:BOOL=ON','AINVR_SEARCH_WITH_BPU_TEXT:BOOL=ON','AINVR_SEARCH_BUILD_HARDWARE_PROBES:BOOL=OFF']}[service]
        if any(value not in cache.splitlines() for value in required):raise ValueError('Release build configuration does not match selected profile')
        folder,file=BINARY_ARTIFACTS[service];destination=out/folder
        destination.mkdir();binary=destination/file;shutil.copy2(build/target,binary);binary.chmod(0o755)
        runtime_dependencies(binary)
    (out/'search-native/build-contract.json').write_text(json.dumps({'schema':1,'bpu_text':True,'tokenizer':True,'hardware_probes':False,'models_packaged':False})+'\n')
