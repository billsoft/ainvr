"""Bounded same-process O0/O2 MoonViT27 board parity and A/B timing with production kept active.

Collect task-owned ION samples separately from RSS;never call these full-model peak.
"""
from pathlib import Path
import argparse,hashlib,json,os,re,signal,subprocess,time,traceback,urllib.request
ROOT=Path('/home/sunrise/ainvr');BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
WORKER=ROOT/'test/model_conversion/validate_locateanything_vision_o2_board_v283.py'
WORKER_SHA='511f91883415ba1fbe4f27f9f0f4f883103eeb9bb7c0d608a246c6013b8e7ccb'

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def active(name):return subprocess.run(['systemctl','is-active',name],capture_output=True,text=True,timeout=10).stdout.strip()
def allocations(pid):
    result={}
    for name in ['cma_reserved','carveout','ion_cma']:
        path=Path('/sys/kernel/debug/ion/heaps')/name
        if path.exists():
            total=0
            for line in path.read_text().split('allocations (',1)[0].splitlines():
                values=line.split()
                if len(values)==4 and values[0]==name and values[2].isdigit() and int(values[2])==pid:total+=int(values[3])
            result[name]=total
    return result

def main():
    p=argparse.ArgumentParser();p.add_argument('--package-root',type=Path,required=True);p.add_argument('--manifest-sha',required=True);a=p.parse_args()
    root=a.package_root.resolve();assert root.parent==BASE and not a.package_root.is_symlink() and os.getuid()==0
    assert re.fullmatch(r'[a-z0-9-]{1,90}',root.name) and re.fullmatch(r'[0-9a-f]{64}',a.manifest_sha)
    assert sha(WORKER)==WORKER_SHA and sha(root/'manifest.json')==a.manifest_sha
    report=ROOT/'test/results'/(root.name+'-guard-v283.json');logpath=report.with_suffix('.log')
    assert not report.exists() and not logpath.exists() and not (root/'board-proof-v283.json').exists()
    key=json.loads((ROOT/'data/ai/config_overlay.json').read_text())['server']['api_key']
    def snapshot():
        def get(path):
            req=urllib.request.Request('http://127.0.0.1:8000'+path,headers={'X-Api-Key':key})
            with urllib.request.urlopen(req,timeout=5) as response:return json.load(response)
        prefix='/api/v1/channels/2baec0a3-9941-47dc-b1bd-d3d284488097'
        state=get(prefix);latest=get(prefix+'/results/latest')
        return dict(inference_count=state['stats']['inference_count'],consecutive_errors=state['stats']['consecutive_errors'],latest_timestamp=latest.get('result',{}).get('timestamp'))
    def media():
        with urllib.request.urlopen('http://127.0.0.1:8100/v1/recorder/health',timeout=5) as response:health=json.load(response)
        with urllib.request.urlopen('http://127.0.0.1:1985/api/v1/streams',timeout=5) as response:streams=json.load(response)['streams']
        stream=next(s for s in streams if s['name']=='xm' and s['app']=='live')
        return dict(recorder={k:health.get(k) for k in ['ok','storageHealthy','droppedMsLastHour','writeDegradedChannels']},
          publish_active=stream['publish']['active'],frames=stream['frames'],recv_bytes=stream['recv_bytes'])
    r=dict(status='checking',scope=__doc__,started=time.time(),source_sha256=sha(__file__),worker_sha256=WORKER_SHA,
      manifest_sha256=a.manifest_sha,production_paused=False,service_changes=False,ion_samples=[],
      whole_model_verified=False,release_approved=False)
    child=None;ticks=None;original={}
    def persist():
        tmp=report.with_suffix('.json.tmp');tmp.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');tmp.replace(report)
    def stop():
        if child is None or child.poll() is not None:return
        proc=Path(f'/proc/{child.pid}');parts=(proc/'stat').read_text().rsplit(')',1)[1].split()
        assert parts[19]==ticks and os.getpgid(child.pid)==child.pid and str(WORKER).encode() in (proc/'cmdline').read_bytes().split(b'\0')
        os.killpg(child.pid,signal.SIGTERM)
        try:child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            parts=(proc/'stat').read_text().rsplit(')',1)[1].split();assert parts[19]==ticks
            os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
    def interrupted(*_):raise RuntimeError('Owned compact-profile guard interrupted')
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted)
    try:
        assert all(active(n)=='active' for n in ['ainvr-ai','ainvr-recorder','ainvr-ingest'])
        r['before']=snapshot();r['media_before']=media();assert r['before']['consecutive_errors']==0
        assert r['media_before']['recorder']['ok'] and r['media_before']['recorder']['storageHealthy'] and r['media_before']['publish_active']
        original={n:sha(ROOT/n) for n in ['deploy/s100p/bin/ainvr_ai_service','data/ai/config_overlay.json']};r['production_hashes_before']=original;persist()
        with logpath.open('xb') as log:
            command=['runuser','-u','sunrise','--',str(ROOT/'ai-service/runtime/.venv-locateanything/bin/python'),str(WORKER),
              '--package-root',str(root),'--manifest-sha',a.manifest_sha]
            child=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,
              env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'))
            ticks=Path(f'/proc/{child.pid}/stat').read_text().rsplit(')',1)[1].split()[19]
            r.update(child_pid=child.pid,child_start_ticks=ticks);persist();deadline=time.monotonic()+300
            while child.poll() is None:
                assert time.monotonic()<deadline,'Owned vision O2 proof300second bound'
                phase=root/'phase-v283.json'
                if phase.exists():
                    value=json.loads(phase.read_text());pid=value['pid'];proc=Path('/proc')/str(pid)
                    if proc.exists():
                        parts=(proc/'stat').read_text().rsplit(')',1)[1].split()
                        assert parts[19]==value['start_ticks'] and os.getpgid(pid)==child.pid and str(WORKER).encode() in (proc/'cmdline').read_bytes().split(b'\0')
                        r['ion_samples'].append(dict(stage=value['stage'],pid=pid,owned_heap_bytes=allocations(pid),checked=time.time()))
                time.sleep(.1)
        proof=json.loads((root/'board-proof-v283.json').read_text());r.update(worker_return=child.returncode,hardware=proof)
        assert child.returncode==0 and proof['status']=='completed' and proof['stage_byte_mismatches']==0 and proof['stage_comparisons']==18*2*27 and proof['o0_tail_matches_production_board'] and proof['repeats_bitwise_exact'] and proof['all_models_released']
        assert proof['board_calls']==18*2*27*2
        r.update(status='completed',hardware_report_sha256=sha(root/'board-proof-v283.json'))
    except BaseException:r.update(status='failed',error=traceback.format_exc())
    finally:
        try:stop()
        except BaseException:r.update(status='failed',owned_cleanup_error=traceback.format_exc())
        try:
            r['after']=snapshot();r['media_after']=media();r['services_after']={n:active(n) for n in ['ainvr-ai','ainvr-recorder','ainvr-ingest']}
            assert all(x=='active' for x in r['services_after'].values()) and r['after']['inference_count']>r['before']['inference_count']
            assert r['after']['consecutive_errors']==0 and r['after']['latest_timestamp'] is not None and time.time()-r['after']['latest_timestamp']<10
            assert r['media_after']['recorder']['ok'] and r['media_after']['recorder']['storageHealthy'] and r['media_after']['publish_active']
            assert r['media_after']['recorder']['droppedMsLastHour']==r['media_before']['recorder']['droppedMsLastHour'] and r['media_after']['recorder']['writeDegradedChannels']==0
            # SRS counters update on a periodic statistics interval;one short
            # BPU proof can finish before the next counter publication.
            observed=time.monotonic();r['media_counter_wait_seconds']=0.
            while not (r['media_after']['frames']>r['media_before']['frames'] and r['media_after']['recv_bytes']>r['media_before']['recv_bytes']):
                assert time.monotonic()-observed<15,'Media counters did not advance within bounded observation'
                time.sleep(.25);r['media_after']=media();r['media_counter_wait_seconds']=time.monotonic()-observed
            assert r['media_after']['recorder']['ok'] and r['media_after']['recorder']['storageHealthy'] and r['media_after']['publish_active']
            assert r['media_after']['recorder']['droppedMsLastHour']==r['media_before']['recorder']['droppedMsLastHour'] and r['media_after']['recorder']['writeDegradedChannels']==0
            r['production_hashes_after']={n:sha(ROOT/n) for n in original};assert r['production_hashes_after']==original
            r['production_unchanged_and_fresh']=True
        except BaseException:r.update(status='failed',postcheck_error=traceback.format_exc())
        r['finished']=time.time();persist()
    print(json.dumps({k:r.get(k) for k in ['status','production_unchanged_and_fresh','error','postcheck_error']}));assert r['status']=='completed'

if __name__=='__main__':main()
