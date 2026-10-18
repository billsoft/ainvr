"""Serialize the remaining ORIGINAL27 decoder layers after actual AR9 BPU proof.

No model preparation starts from a filename or a compiling status. A receipt
must bind the terminal CPU artifact and actual nine-layer board parity report.
Wait for existing S12 work to release resources; no compile elapsed-time cap.
"""
from pathlib import Path
import hashlib,json,os,signal,subprocess,time,traceback
from locateanything_compact_compiler_origin_v1 import verify_compiler_origin

ROOT=Path('/work/official-llm-v1');BASE=Path('/opt/locate-oellm-research-v1')
GUARD=ROOT/'guard_locateanything_compact_affine_decoder_job_v5.py'
GUARD_SHA='37f0ef2b5154bce629c08e38892d73e0363783e52d55cc3ca433ac5ac3f6b5d3'
BUILDER=ROOT/'official_build_compact_affine_decoder_group_v2_sdk448.py'
BUILDER_SHA='dc65fb759764d89a9c026ae05a3171c0931888343cf1dca3124f9439e3f4067d'
RECEIPT=ROOT/'locateanything-compact-ar9-board-qualification-v1.json'
BOARD=ROOT/'compact-profile-ar9-saved-bc-v1-guard-v5.json'
AR9=BASE/'compact-affine-g32-control-decoder-group-0-8-s1-resume-v1-sdk448'
S12=ROOT/'compact-affine-g32-control-block0-s12-serial-v1-guard.json'
S12_ID=(352628,'10876505')
OUT=ROOT/'locateanything-compact-remaining-ar-queue-v1.json'
LOG=ROOT/'locateanything-compact-remaining-ar-queue-v1.log'


def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(4*1024**2),b''):h.update(block)
    return h.hexdigest()


def identity(pid):
    try:parts=Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()
    except FileNotFoundError:return None
    return parts[19],parts[0]


def actual_qualification():
    receipt=json.loads(RECEIPT.read_text())
    assert receipt['status']=='actual_ar9_board_qualification_verified'
    assert receipt['board_report_file']==BOARD.name and sha(BOARD)==receipt['board_report_sha256']
    report=json.loads(BOARD.read_text())
    assert report['source_sha256']=='112f78ee3138c658c4eab762ab27783548c182467bf027b816ae887622995519'
    assert report['worker_sha256']=='bd894bd40e00c310e4a4ea89ddc75eea50b3bbcc863cb3989df73922ac4444a6'
    assert report['status']=='completed' and report['production_unchanged_and_fresh']
    proof=report['hardware']
    assert proof['status']=='completed' and proof['layer_indices']==list(range(9))
    assert proof['sequence']==1 and proof['board_calls']==12 and len(proof['runs'])==12
    assert proof['all_outputs_compiler_bitwise_exact'] and proof['all_models_released']
    assert all(len(run['outputs'])==19 and all(v['array_equal'] for v in run['outputs']) for run in proof['runs'])
    assert sha(AR9/'status.json')==receipt['compiler_status_sha256']
    compiler=json.loads((AR9/'status.json').read_text());verify_compiler_origin(compiler)
    assert compiler['status']=='completed' and compiler['start_layer']==0 and compiler['end_layer']==8 and compiler['sequence_capacity']==1
    assert compiler['converted_bc_sha256']=='106e5e0006e45ff88cac9eb9d03519e4696ad6cc151d0c2989fddaee7fe835be'
    assert compiler['hbm_sha256']==proof['hbm_sha256']==receipt['hbm_sha256']==sha(AR9/'stack.hbm')
    assert len(compiler['selected_modules'])==63 and compiler['bpu_only']
    return dict(receipt_sha256=sha(RECEIPT),board_report_sha256=sha(BOARD),hbm_sha256=compiler['hbm_sha256'])


def main():
    assert not OUT.exists() and not LOG.exists() and sha(GUARD)==GUARD_SHA and sha(BUILDER)==BUILDER_SHA
    jobs=[]
    for start in [9,18,27]:
        name=f'compact-affine-g32-control-group{start//9}-s1-serial-v1'
        target=BASE/f'compact-affine-g32-control-decoder-group-{start}-{start+8}-s1-v2-sdk448'
        assert not target.exists() and not (ROOT/(name+'-guard.json')).exists() and not (ROOT/(name+'.log')).exists()
        jobs.append(dict(start=start,end=start+8,name=name,target=str(target)))
    r=dict(status='waiting_actual_ar9_board_qualification',started=time.time(),scope=__doc__,source_sha256=sha(__file__),
      pid=os.getpid(),start_ticks=identity(os.getpid())[0],jobs=jobs,maximum_compile_seconds=None,compile_jobs=1,
      production_actions=False,gpu_jobs_started=0,whole_model_verified=False,release_approved=False)
    child=None;ticks=None;log=None
    def save():
        p=OUT.with_suffix('.json.tmp');p.write_text(json.dumps(r,indent=2)+'\n');p.replace(OUT)
    def stop():
        if child is None or child.poll() is not None:return
        current=identity(child.pid);assert current and current[0]==ticks and os.getpgid(child.pid)==child.pid
        assert str(GUARD).encode() in Path(f'/proc/{child.pid}/cmdline').read_bytes().split(b'\0')
        os.killpg(child.pid,signal.SIGTERM)
        # The audited child guard owns compiler shutdown; do not bypass its
        # cleanup with an unverified broad kill of native compiler processes.
        child.wait(timeout=45)
    def interrupted(*_):raise RuntimeError('Owned remaining-group queue interrupted')
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted);signal.signal(signal.SIGHUP,interrupted)
    try:
        save()
        while not RECEIPT.exists():time.sleep(5)
        r.update(status='waiting_existing_s12_resource_release',qualification=actual_qualification());save()
        while True:
            current=identity(S12_ID[0])
            if current is not None:assert current[0]==S12_ID[1],'S12 guard PID reused'
            if current is None or current[1] in ['Z','X']:break
            time.sleep(3)
        previous=json.loads(S12.read_text())
        assert previous['source_sha256']==GUARD_SHA and previous['guard_pid']==S12_ID[0] and previous['guard_start_ticks']==S12_ID[1]
        assert previous['status'] in ['compiled_group','failed']
        if 'child_pid' in previous:
            current=identity(previous['child_pid'])
            if current is not None:assert current[0]==previous['child_start_ticks'] and current[1] in ['Z','X']
        r['s12_terminal_report_sha256']=sha(S12)
        log=LOG.open('xb')
        for item in jobs:
            assert sha(GUARD)==GUARD_SHA and sha(BUILDER)==BUILDER_SHA
            name=item['name'];target=Path(item['target']);assert not target.exists()
            command=['python3','-u',str(GUARD),'--name',name,'--layers','9','--start-layer',str(item['start']),
                     '--seq','1','--label','g32-control','--jobs','1']
            child=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,
              start_new_session=True,env=dict(os.environ,CUDA_VISIBLE_DEVICES=''))
            ticks=identity(child.pid)[0]
            item.update(status='running_guard',guard_pid=child.pid,guard_start_ticks=ticks,started=time.time())
            r.update(status='running_serial_compilation',current_group_start=item['start']);save()
            while child.poll() is None:time.sleep(3)
            entry=ROOT/(name+'-guard.json');result=json.loads(entry.read_text())
            item.update(guard_returncode=child.returncode,guard_report_sha256=sha(entry))
            assert child.returncode==0 and result['status']=='compiled_group','Stop queue after any failed group;do not launch the next'
            compiler=json.loads((target/'status.json').read_text());verify_compiler_origin(compiler)
            assert compiler['status']=='completed' and compiler['bpu_only'] and len(compiler['selected_modules'])==63
            assert (compiler['start_layer'],compiler['end_layer'],compiler['sequence_capacity'])==(item['start'],item['end'],1)
            assert compiler['hbm_sha256']==result['hbm_sha256']==sha(target/'stack.hbm')
            item.update(status='compiled_bpu_only',hbm_sha256=compiler['hbm_sha256'],hbm_bytes=compiler['hbm_bytes'],finished=time.time());save()
            child=None
        r.update(status='remaining27_layers_compiled_pending_board_tests',compiled_groups=3)
    except BaseException:r.update(status='failed',error=traceback.format_exc())
    finally:
        try:stop()
        except BaseException:r.update(status='failed',owned_cleanup_error=traceback.format_exc())
        if log is not None:log.close()
        r['finished']=time.time();save()
if __name__=='__main__':main()
