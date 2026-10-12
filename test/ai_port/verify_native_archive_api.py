#!/usr/bin/env python3
"""AINVR real licensed control API integration, using an isolated publisher.

Uses the board's existing license consumer key; never changes its license.
Creates/deletes only its own temporary AI channel and configuration.
"""
from pathlib import Path
import datetime
import json
import os
import secrets
import socket
import pwd
import subprocess
import time
import urllib.request
import urllib.error
import urllib.parse

ROOT=Path(__file__).resolve().parents[2]
stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
out=ROOT/'test/results'/('native-archive-api-'+stamp);out.mkdir(mode=0o700)
work=ROOT/'test/runtime'/('native-archive-api-'+stamp);work.mkdir(mode=0o700)
key=secrets.token_hex(32)
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
base=work/'config.json';overlay=work/'overlay.json'
password=(ROOT/'deploy/infra/secrets/mongo_app_password').read_text().strip()
mongo_uri='mongodb://ainvr_ai:'+urllib.parse.quote(password,safe='')+'@127.0.0.1:27017/ainvr_snapshots?authSource=ainvr_snapshots'
base.write_text(json.dumps({'server':{'host':'127.0.0.1','port':port,'api_key':key},'channels':[],'snapshot_store':{'mongo_uri':mongo_uri,'db_name':'ainvr_snapshots'}}));base.chmod(0o600)
account=pwd.getpwnam('sunrise')
for path in (work,base):os.chown(path,account.pw_uid,account.pw_gid)
env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib:'+str(ROOT/'out/deps/onnxruntime-1.23.2/lib'))
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
service=publisher=None
summary={'passed':False,'scope':'Native HTTP lifecycle with real device license, VPU and CPU ONNX; durable archive write/read enabled; SEI/BPU not covered'}

def stop(p):
    if p and p.poll() is None:
        p.terminate()
        try:p.wait(timeout=15)
        except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5);raise

def request(path,method='GET',body=None,auth=True,expected=200):
    headers={'Content-Type':'application/json', 'Accept-Encoding':'gzip, br'}
    if auth:headers['x-api-key']=key
    req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,
        data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
    try:
        with opener.open(req,timeout=20) as r:
            assert not r.headers.get('Content-Encoding'), 'AI response must remain uncompressed through console proxy'
            code=r.status;data=json.load(r)
    except urllib.error.HTTPError as e:code=e.code;data=json.load(e)
    assert code==expected,(path,code,data)
    return data

def wait(predicate,seconds=25):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        assert service.poll() is None,'API service exited'
        try:
            value=predicate()
            if value:return value
        except urllib.error.URLError:pass
        time.sleep(.25)
    raise AssertionError('Timed out waiting for API state')

try:
    name='ainvr_api_'+secrets.token_hex(6)
    fixture=ROOT/'test/results/live-xm-20261011-183933-507829/capture.mkv'
    with (out/'publisher.log').open('w') as log:
        publisher=subprocess.Popen(['/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg','-nostdin','-v','error',
            '-re','-stream_loop','-1','-i',str(fixture),'-map','0:v:0','-c','copy','-f','flv',
            'rtmp://127.0.0.1:1935/live/'+name],stdout=log,stderr=log)
    def start_service():
        with (out/'service.log').open('a') as log:
            return subprocess.Popen(['runuser','-u','sunrise','--',os.environ.get('AINVR_TEST_AI_BINARY', str(ROOT/'out/build/ai-api-compat/ainvr_ai_service')),str(base),str(overlay),
                str(ROOT/'ai-service'),str(ROOT/'deploy/s100p/runtime/ai-service.env')],env=env,stdout=log,stderr=log)
    service=start_service()
    wait(lambda:request('/health',auth=False)['business']['ready'])
    request('/api/v1/channels',auth=False,expected=401)
    config_view=request('/api/v1/config')
    assert config_view['server']['api_key_set'] and 'api_key' not in config_view['server']
    request('/api/v1/config','PUT',{'server':{'port':9999}},expected=409)
    request('/api/v1/config','PUT',{'channels':[]},expected=422)

    request('/api/v1/channels/missing',expected=404)
    channel={'id':'api-history-'+stamp,'name':'AINVR API integration','enabled':False,
             'stream':{'url':'http://127.0.0.1:8080/live/'+name+'.flv','protocol':'flv'},
             'model':{'provider':'cpu','adapter':'yolo26_end2end','path':'models/yolo26m.onnx'}}
    unsupported=dict(channel,model={'provider':'bpu','adapter':'yolo26_bpu','path':'models/yolo26m.hbm'})
    request('/api/v1/channels','POST',unsupported,expected=422)
    created=request('/api/v1/channels','POST',channel,expected=201);assert created['state']=='idle'
    config_view=request('/api/v1/config')
    assert len(config_view['channels'])==1
    assert config_view['channels'][0]['stream']==created['config']['stream']
    assert 'stats' not in config_view['channels'][0] and 'config' not in config_view['channels'][0]
    endpoint='/api/v1/channels/api-history-'+stamp
    history=endpoint+'/snapshots'
    overview=request(history+'/overview')
    assert overview['enabled'] is False and overview['connected'] is True
    assert overview['count']==0 and overview['max_count']==10000
    assert overview['earliest_timestamp'] is None and overview['latest_timestamp'] is None
    request(history+'/overview',auth=False,expected=401)
    request('/api/v1/channels/missing/snapshots/overview',expected=404)
    summary['overview_routes']={'passed':True,'scope':'Real Mongo empty channel, disabled capture state and authentication'}

    heatmap=history+'/heatmap'
    assert request(heatmap)=={'enabled':True,'bucket_s':300,'count':0,'buckets':[]}
    request(heatmap,auth=False,expected=401)
    assert request(heatmap+'?bucket_s=1')['bucket_s']==30
    request(heatmap+'?bucket_s=bad',expected=422)
    request(heatmap+'?from_ts=nan',expected=422)
    summary['heatmap_routes']={'passed':True,'scope':'Authenticated real Mongo empty collection, interval clamp and validation'}

    assert request(history)=={'items':[],'next_cursor':None}
    request(history,auth=False,expected=401)
    request('/api/v1/channels/missing/snapshots',expected=404)
    request(history+'?limit=bad',expected=422)
    request(history+'?min_confidence=nan',expected=422)
    assert request(history+'?cursor=bad')['items']==[]
    request(history+'/507f1f77bcf86cd799439011/image',expected=404)
    request(history+'/507f1f77bcf86cd799439011/image?variant=invalid',expected=400)
    request(history+'/507f1f77bcf86cd799439011/image?variant=original',auth=False,expected=401)
    summary['history_read_routes']={'passed':True,'scope':'Real Mongo empty isolated channel, auth, validation, missing-image semantics'}
    request(endpoint+'/config','PUT',{'snapshot':{'enabled':True,'max_count':3}})
    request(endpoint+'/start','POST',{})
    frame=wait(lambda:request(endpoint+'/results/latest').get('result'))
    assert frame['frame_width']==3840 and frame['frame_height']==1920
    assert frame['model']['provider']=='cpu'
    wait(lambda:request(history)['items'])
    request(endpoint+'/stop','POST',{})
    archived=request(history)['items'];assert 1<=len(archived)<=3
    overview=request(history+'/overview');assert overview['enabled'] and overview['connected'] and overview['count']==len(archived)
    stored_ids=[item['image_id'] for item in archived]
    for variant in ('processed','original'):
        req=urllib.request.Request(f'http://127.0.0.1:{port}'+history+'/'+stored_ids[0]+'/image?variant='+variant,headers={'x-api-key':key})
        with opener.open(req,timeout=20) as response:
            assert response.headers.get_content_type()=='image/jpeg'
            data=response.read();assert data[:2]==b'\xff\xd8'
        image=out/(variant+'.jpg');image.write_bytes(data)
        subprocess.run(['/usr/bin/ffmpeg','-v','error','-i',str(image),'-frames:v','1','-f','null','-'],check=True,timeout=15)
    summary['archive_write_read']={'passed':True,'images':len(archived),'limit':3,'variants_decoded':['processed','original']}

    stopped=request(endpoint);assert stopped['state']=='idle'
    assert json.loads(overlay.read_text())['channels'][0]['manually_stopped']
    stop(service);service=start_service()
    wait(lambda:request('/health',auth=False)['business']['ready'])
    time.sleep(1)
    assert request(endpoint)['state']=='idle'
    assert [item['image_id'] for item in request(history)['items']]==stored_ids
    summary['history_preserved_after_restart']=True
    assert not request(endpoint+'/results/latest')['has_result']
    request(endpoint+'/start','POST',{})
    wait(lambda:request(endpoint+'/results/latest')['has_result'])
    changed=request(endpoint+'/config','PUT',{'postprocess':{'conf_threshold':.65}})
    assert changed['applied'] and changed['channel']['config']['postprocess']['conf_threshold']==.65
    wait(lambda:request(endpoint+'/results/latest')['has_result'])
    request(endpoint,'DELETE')
    request(endpoint,expected=404)
    assert request('/api/v1/channels')['channels']==[]
    request('/api/v1/channels','POST',channel,expected=201)
    assert request(history)['items']==[]
    request(endpoint,'DELETE')
    assert not list((work/'archive').rglob('*.pending'))
    summary['channel_delete_clears_history']=True

    summary.update(passed=True,frame_size=[frame['frame_width'],frame['frame_height']],
                   verified=['authentication','capability_rejection','create','start','real_inference',
                             'stop','durable_manual_stop_after_process_restart','restart','update','delete'])
finally:
    stop(service);stop(publisher)
    (out/'summary.json').write_text(json.dumps(summary,indent=2))
    print(out/'summary.json',flush=True)
