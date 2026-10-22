"""One-hour isolated SDK and stability gate; uses lifecycle restoration harness.

No video coexistence claim: live-source testing is a separate release gate.
"""
import base64, json, os, socket, struct, time, subprocess
from pathlib import Path
import openai
import test_residency_hardware as harness

def snapshot(pid):
    root=Path(f'/proc/{pid}')
    rss=next(int(x.split()[1])*1024 for x in (root/'status').read_text().splitlines() if x.startswith('VmRSS:'))
    return {'rss_bytes':rss,'fd_count':len(list((root/'fd').iterdir()))}

def exercise(call,key,admin,process,report,save,request):
    client=openai.OpenAI(base_url='http://127.0.0.1:8300/v1',api_key=key,max_retries=0,timeout=75)
    def sdk():
        response=client.chat.completions.create(model='qwen3vl-4b-review-v3',messages=[],extra_body={'ainvr':{'decision':request}})
        value=response.model_extra['ainvr']
        assert value['logits']==report['requests'][-1]['logits']
        return value
    sdk(); report['openai_sdk']={'version':openai.__version__,'passed':True}
    node=subprocess.run(['/usr/local/bin/node',str(Path(__file__).with_name('test_sdk_node.cjs'))],input=json.dumps({'key':key,'request':request}),text=True,capture_output=True,timeout=80)
    assert node.returncode==0, node.stderr
    assert json.loads(node.stdout)['logits']==report['requests'][-1]['logits']
    report['node_sdk_passed']=True
    # A disconnected client must not leave an active request or queue forever.
    # This runtime drains it within its deadline; it does not promise instant cancellation.
    body=json.dumps(request).encode()
    sock=socket.create_connection(('127.0.0.1',8300),timeout=5)
    sock.sendall(b'POST /v1/ainvr/tasks/alarm-review-zh-v1 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer '+key.encode()+b'\r\nContent-Type: application/json\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body)
    time.sleep(.3);sock.setsockopt(socket.SOL_SOCKET,socket.SO_LINGER,struct.pack('ii',1,0));sock.close()
    deadline=time.monotonic()+65
    while time.monotonic()<deadline:
        h=call('/health')
        if not h['active_request'] and h['queue']['length']==0:break
        time.sleep(.2)
    else:raise AssertionError('disconnected request did not drain')
    sdk();report['disconnect_recovery']=True
    # A bounded burst covers queue rejection and queued-request deadlines.
    import concurrent.futures, threading, urllib.request, urllib.error
    gate=threading.Barrier(12)
    def burst(_):
        gate.wait(timeout=5)
        req=urllib.request.Request('http://127.0.0.1:8300/v1/ainvr/tasks/alarm-review-zh-v1',data=body,headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=75) as response:
                value=json.load(response)
                assert value['logits']==report['requests'][-1]['logits']
                return response.status
        except urllib.error.HTTPError as error:
            error.read();return error.code
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        statuses=list(pool.map(burst,range(12)))
    assert 200 in statuses and 429 in statuses and all(x in (200,429,504) for x in statuses), statuses
    report['bounded_burst_statuses']=statuses
    sdk();report['post_burst_recovery']=True

    report['stability']={'started_at':time.time(),'target_seconds':3600,'samples':[],'requests':0}
    start=time.monotonic();warm=None
    while time.monotonic()-start<3600:
        sdk();report['stability']['requests']+=1
        elapsed=time.monotonic()-start
        if report['stability']['requests']%10==0:
            m={'elapsed_s':elapsed,**snapshot(process.pid)}
            report['stability']['samples'].append(m)
            if warm is None and elapsed>=120:warm=m
            if warm:
                assert m['rss_bytes']-warm['rss_bytes']<64*1024*1024,'RSS growth exceeds 64 MiB after warmup'
                assert m['fd_count']-warm['fd_count']<=5,'descriptor growth'
            save()
    report['stability'].update(elapsed_s=time.monotonic()-start,passed=True)
    client.close();save()

if __name__=='__main__':
    os.environ['AINVR_LLM_TEST_CAP']='40'
    harness.UNITS=['ainvr-llm']  # Keep AI, LocateAnything, recording and streams running.
    harness.OUT=harness.ROOT/'test/results/llm-service-development/service-endurance.json'
    harness.main(exercise)
