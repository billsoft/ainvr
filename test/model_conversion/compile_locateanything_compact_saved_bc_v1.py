"""Resume the exact nine-layer AR graph after an observed RAM-floor stop.

Wait for the existing prefill compiler to terminate before allocating a new
compiler. No duration limit,no recalibration/export/GPU/production action.
Use jobs1 to reduce parallel compiler workspace. Preserve original metadata
as a hashed embedded report;never impersonate the original export producer.
"""
from pathlib import Path
import argparse,copy,hashlib,json,os,signal,subprocess,sys,time,traceback
ROOT=Path('/work/official-llm-v1');BASE=Path('/opt/locate-oellm-research-v1')
ORIGINAL=BASE/'compact-affine-g32-control-decoder-group-0-8-s1-v2-sdk448'
OUT=BASE/'compact-affine-g32-control-decoder-group-0-8-s1-resume-v1-sdk448'
GUARD=ROOT/'compact-affine-g32-control-group0-s1-resume-v1-guard.json'
LOG=ROOT/'compact-affine-g32-control-group0-s1-resume-v1.log'
BC_SHA='106e5e0006e45ff88cac9eb9d03519e4696ad6cc151d0c2989fddaee7fe835be'
EXPORT_SHA='dc65fb759764d89a9c026ae05a3171c0931888343cf1dca3124f9439e3f4067d'
OLD_AR=(345268,'10073525');PREFILL=(345269,'10073527')
def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda:f.read(4*1024**2),b''):h.update(chunk)
    return h.hexdigest()
def write(path,value):
    temp=path.with_suffix('.json.tmp');temp.write_text(json.dumps(value,indent=2)+'\n');temp.replace(path)
def live(pair):
    path=Path('/proc')/str(pair[0])
    try:
        fields=(path/'stat').read_text().rsplit(')',1)[1].split()
        return fields[19]==pair[1] and fields[0]!='Z'
    except FileNotFoundError:return False
def available():return int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024
def original_metadata():
    path=ORIGINAL/'status.json';raw=path.read_text();value=json.loads(raw)
    assert value['status']=='compiling' and value['source_sha256']==EXPORT_SHA
    assert (value['start_layer'],value['end_layer'],value['sequence_capacity'])==(0,8,1)
    assert value['converted_bc_sha256']==BC_SHA and len(value['selected_modules'])==63
    assert not (ORIGINAL/'stack.hbm').exists() and not live(OLD_AR)
    return raw,value

def worker():
    raw,origin=original_metadata();assert digest(ORIGINAL/'stack-converted.bc')==BC_SHA
    report=copy.deepcopy(origin)
    report.update(status='loading_saved_bc',source_sha256=digest(__file__),export_source_sha256=EXPORT_SHA,
      started=time.time(),maximum_compile_seconds=None,compile_jobs=1,optimization=0,
      compile_resume=dict(original_status_utf8=raw,original_status_sha256=hashlib.sha256(raw.encode()).hexdigest(),
        original_converted_bc_sha256=BC_SHA,compiler_restarted_from_saved_bc=True,recalibration_executed=False,
        graph_or_weight_changes=False,original_memory_stop_guard_sha256=digest(ROOT/'compact-affine-g32-control-group0-s1-v3-unlimited-v1.json')))
    write(OUT/'status.json',report)
    try:
        for key in ['DEV_B30_TRITON_VPU','DEV_B30_ENABLE_VPU_EXTRA_OP','DEV_B30_ENABLE_VPU_TRIAL_OP']:os.environ[key]='1'
        os.environ['OMP_NUM_THREADS']='2';os.environ['OPENBLAS_NUM_THREADS']='2';os.environ['MKL_NUM_THREADS']='2'
        sys.path.insert(0,str(BASE/'sdk448-isolated/python'))
        from hbdk4.compiler import load,compile,link
        os.link(ORIGINAL/'stack-converted.bc',OUT/'stack-converted.bc')
        assert digest(OUT/'stack-converted.bc')==BC_SHA
        module=load(str(OUT/'stack-converted.bc'));function=module.functions[0]
        assert len(module.functions)==1 and len(function.inputs)==22 and len(function.outputs)==19
        shapes=[(1,2048),(1,128),(1,128),(1,512)]+[(2,512,128)]*18
        assert [tuple(x.type.shape) for x in function.inputs]==shapes
        assert [tuple(x.type.shape) for x in function.outputs]==[(1,2048)]+[(2,1,128)]*18
        report.update(status='compiling',serialized_graph_identity_checked=True);write(OUT/'status.json',report)
        hbo=compile(module,str(OUT/'stack.hbo'),march='nash-m',opt=0,jobs=1);link([hbo],str(OUT/'stack.hbm'))
        tool=BASE/'sdk448-isolated/python/hbdk4/compiler/_mlir_libs/hbrt4-disas'
        disas=json.loads(subprocess.check_output([str(tool),'--json',str(OUT/'stack.hbm')],text=True))
        assert len(disas['graphs'])==1
        devices=[n['device'] for g in disas['graphs'] for n in g['nodes']]
        assert devices and all(d=='DEVICE_CATEGORY_BPU' for d in devices)
        (OUT/'disas.json').write_text(json.dumps(disas,indent=2)+'\n')
        report.update(status='completed',bpu_only=True,devices=devices,hbm_sha256=digest(OUT/'stack.hbm'),
          hbm_bytes=(OUT/'stack.hbm').stat().st_size,finished=time.time())
    except BaseException:report.update(status='failed',error=traceback.format_exc(),finished=time.time());raise
    finally:write(OUT/'status.json',report)

def main():
    p=argparse.ArgumentParser();p.add_argument('--worker',action='store_true');a=p.parse_args()
    if a.worker:worker();return
    assert not GUARD.exists() and not LOG.exists() and not OUT.exists() and not live(OLD_AR)
    failed=json.loads((ROOT/'compact-affine-g32-control-group0-s1-v3-unlimited-v1.json').read_text())
    assert failed['status']=='failed' and 'MemoryError' in failed['error'] and failed['maximum_compile_seconds'] is None
    original_metadata();assert digest(ORIGINAL/'stack-converted.bc')==BC_SHA
    OUT.mkdir()
    r=dict(status='waiting_prefill_resource_release',started=time.time(),source_sha256=digest(__file__),
      guard_pid=os.getpid(),guard_start_ticks=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],
      prior_ar_compiler=OLD_AR,dependency_prefill=PREFILL,target=str(OUT),converted_bc_sha256=BC_SHA,
      maximum_compile_seconds=None,compile_jobs=1,ordinary_ram_floor_bytes=6*1024**3,
      recalibration_executed=False,graph_or_weight_changes=False,production_actions=False,whole_model_verified=False,release_approved=False)
    child=None;ticks=None;log=None
    def save():write(GUARD,r)
    def stop():
        if child is None or child.poll() is not None:return
        path=Path('/proc')/str(child.pid);parts=(path/'stat').read_text().rsplit(')',1)[1].split()
        assert parts[19]==ticks and os.getpgid(child.pid)==child.pid and str(Path(__file__).resolve()).encode() in (path/'cmdline').read_bytes().split(b'\0')
        os.killpg(child.pid,signal.SIGTERM)
        try:child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            parts=(path/'stat').read_text().rsplit(')',1)[1].split();assert parts[19]==ticks
            os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
    def interrupted(*_):raise RuntimeError('Owned saved-BC guard interrupted')
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted);signal.signal(signal.SIGINT,interrupted)
    try:
        save()
        while live(PREFILL):time.sleep(3)
        r.update(status='waiting_ordinary_memory_headroom',dependency_terminated=time.time());save()
        while available()<14*1024**3:time.sleep(3)
        assert not live(PREFILL) and not live(OLD_AR)
        log=LOG.open('xb');child=subprocess.Popen(['python3','-u',str(Path(__file__).resolve()),'--worker'],
          stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,env=dict(os.environ,CUDA_VISIBLE_DEVICES=''))
        ticks=Path(f'/proc/{child.pid}/stat').read_text().rsplit(')',1)[1].split()[19]
        r.update(status='running',child_pid=child.pid,child_start_ticks=ticks,minimum_available_bytes=available());save()
        while child.poll() is None:
            current=available();r['minimum_available_bytes']=min(r['minimum_available_bytes'],current)
            assert current>6*1024**3,'Compile ordinary RAM floor reached'
            time.sleep(3)
        r['child_returncode']=child.returncode
        result=json.loads((OUT/'status.json').read_text());r.update(result_status=result['status'],result_sha256=digest(OUT/'status.json'))
        assert child.returncode==0 and result['status']=='completed' and result['bpu_only']
        assert digest(OUT/'stack.hbm')==result['hbm_sha256'] and digest(OUT/'stack-converted.bc')==BC_SHA
        r.update(status='compiled_group',hbm_sha256=result['hbm_sha256'],hbm_bytes=result['hbm_bytes'])
    except BaseException:r.update(status='failed',error=traceback.format_exc())
    finally:
        stop()
        if log is not None:log.close()
        r['finished']=time.time();save()

if __name__=='__main__':main()
