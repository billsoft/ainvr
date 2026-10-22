"""Finite hardware acceptance; restore service states even on a failed request.

Never reads debugfs. Stops AI and both large-model services for exclusive tests.
Uses the production lock path so cooperating loaders cannot bypass the test.
"""
import base64,json,os,secrets,signal,subprocess,tempfile,time,urllib.request,urllib.error,pwd
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
FINAL=os.environ.get('AINVR_LLM_FINAL_SET')=='1'
OUT=ROOT/('test/results/llm-service-development/residency-final-559.json' if FINAL else 'test/results/llm-service-development/residency-hardware.json')
UNITS=['ainvr-ai','ainvr-locateanything-official-bpu','ainvr-llm']
def state(u):return subprocess.run(['systemctl','is-active',u],capture_output=True,text=True).stdout.strip()
def main(extra=None):
    was={u:state(u) for u in UNITS};report=dict(was=was,requests=[],passed=False)
    def save():OUT.write_text(json.dumps(report,indent=2)+'\n')
    def interrupted(*_):raise InterruptedError('test interrupted')
    for sig in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]:signal.signal(sig,interrupted)
    process=None
    try:
        for u in UNITS:
            if was[u]=='active':subprocess.run(['systemctl','stop',u],check=True,timeout=120)
        with tempfile.TemporaryDirectory(prefix='ainvr-llm-test-') as tmp:
            key,admin=secrets.token_hex(32),secrets.token_hex(32)
            path=Path(tmp)/'config.json'
            path.write_text(json.dumps(dict(inference_key=key,admin_key=admin,package_root='/mnt/ainvr-ssd/llm-packages/qwen3vl-4b-review-v3',reservation_root='/run/ainvr',exec_timeout_s=30,submit_time_share_cap_percent=int(os.environ.get('AINVR_LLM_TEST_CAP','90')))))
            path.chmod(0o600)
            def call(endpoint,body=None,token=None):
                request=urllib.request.Request('http://127.0.0.1:8300'+endpoint,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+token} if token else {})})
                for attempt in range(30):
                    try:
                        with urllib.request.urlopen(request,timeout=75) as response:return json.load(response)
                    except urllib.error.HTTPError as e:
                        detail=e.read().decode()
                        if e.code==409 and endpoint.startswith('/v1/admin/') and 'busy' in detail and attempt<29:
                            time.sleep(.2);continue
                        raise RuntimeError(endpoint+': '+detail) from e
            with (OUT.with_suffix('.log')).open('w') as log:
                process=subprocess.Popen(['/mnt/ainvr-ssd/llm-build/ainvr/ainvr_llm_service',str(path)],stdout=log,stderr=subprocess.STDOUT,env={**os.environ,'MALLOC_ARENA_MAX':'2'})
                for _ in range(100):
                    assert process.poll() is None
                    try:call('/health');break
                    except OSError:time.sleep(.1)
                def wait_model(expected,seconds=120):
                    end=time.monotonic()+seconds
                    while time.monotonic()<end:
                        health=call('/health')
                        if health['model']==expected:return
                        if health['model']=='fault':raise RuntimeError(health['last_error'])
                        time.sleep(.2)
                    raise TimeoutError(expected)
                call('/v1/admin/load',{},admin);wait_model('ready')
                report['loaded']=True;save()
                # Python peer must reject before any hardware allocation.
                import sys
                sys.path.insert(0,str(ROOT/'ai-service/runtime'))
                from large_model_reservation import LargeModelReservation
                try:LargeModelReservation()
                except RuntimeError as e:assert str(e)=='large_model_busy'
                else:raise AssertionError('peer admitted while resident')
                report['peer_rejected']=True
                items=[json.loads(s) for s in Path('/mnt/ainvr-ssd/llm-eval/v1/'+('items-final-v2.jsonl' if FINAL else 'items-dev-v2.jsonl')).read_text().splitlines()]
                if not FINAL:items=items[:5]
                for item in items:
                    image=Path('/mnt/ainvr-ssd/llm-eval/v1')/item['image']
                    request=dict(request_id=item['id'],image={'jpeg_base64':base64.b64encode(image.read_bytes()).decode()},alarm=dict(kind=item['kind'],description=item['desc']))
                    result=call('/v1/ainvr/tasks/alarm-review-zh-v1',request,key)
                    assert result['request_id']==item['id'] and 0<=result['real_score']<=1
                    report['requests'].append(result);save()
                compatible=call('/v1/chat/completions',dict(model='qwen3vl-4b-review-v3',ainvr={'decision':request}),key)
                assert compatible['ainvr']['logits']==report['requests'][-1]['logits']
                report['compatibility_equal']=True
                if extra:extra(call,key,admin,process,report,save,request)
                call('/v1/admin/unload',{},admin);wait_model('unloaded')
                peer=LargeModelReservation();peer.close()
                call('/v1/admin/load',{},admin);wait_model('ready')
                repeated=call('/v1/ainvr/tasks/alarm-review-zh-v1',request,key)
                assert repeated['logits']==report['requests'][-1]['logits']
                report['reload_equal']=True
                call('/v1/admin/unload',{},admin);wait_model('unloaded')
                report['passed']=True
    except BaseException as e:report['error']=str(e)
    finally:
        if process:
            process.terminate()
            try:process.wait(timeout=45)
            except subprocess.TimeoutExpired:report['forced_stop']=True;process.kill();process.wait()
        report['restore']={}
        owner=pwd.getpwnam('sunrise')
        for name in ['bpu-reservation.lock','bpu-reservations.json']:
            p=Path('/run/ainvr')/name
            if p.exists():os.chown(p,owner.pw_uid,owner.pw_gid)
        for u in reversed(UNITS):
            if was[u]=='active':
                try:report['restore'][u]=subprocess.run(['systemctl','start',u],timeout=180).returncode
                except Exception as e:report['restore'][u]=str(e)
        report['now']={u:state(u) for u in UNITS+['ainvr-recorder','ainvr-ingest']};save()
    print(json.dumps({k:v for k,v in report.items() if k!='requests'}))
    if not report['passed'] or any(v!=0 for v in report['restore'].values()):raise SystemExit(1)
if __name__=='__main__':main()
