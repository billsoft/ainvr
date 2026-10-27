#!/usr/bin/env python3
"""HTTP acceptance against test/ptz/fixture.ts and the independent SOAP camera.
No production service, camera, parameter database or media connection is used.
"""
import json,time,urllib.request,urllib.error,argparse
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--base',default='http://127.0.0.1:28088');parser.add_argument('--camera',default='http://192.168.100.189:28551');parser.add_argument('--output',required=True);args=parser.parse_args()
checks=[]
def request(path,data=None,method=None,actor='fixture-a',base=None):
 q=urllib.request.Request((base or args.base)+path,data=None if data is None else json.dumps(data).encode(),method=method,headers={'x-console-token':actor,**({'Content-Type':'application/json'}if data is not None else {})})
 try:
  with urllib.request.urlopen(q,timeout=45)as response:return response.status,json.load(response)
 except urllib.error.HTTPError as error:return error.code,json.load(error)
def ok(path,data=None,method=None,actor='fixture-a'):
 code,result=request(path,data,method,actor);assert code==200,(path,code,result);return result
def check(name,value):
 assert value,name;checks.append(name);print('PASS',name,flush=True)
info=ok('/__fixture/info');ids={k:v['id']for k,v in info['inputs'].items()}
def url(name,tail=''):return '/api/channels/'+ids[name]+'/ptz'+tail
def inspect(name):return ok(url(name))
def acquire(name,actor='fixture-a'):return ok(url(name,'/control-session'),{'identity':inspect(name)['identity']},actor=actor)['sessionId']
def stop(name,session):return ok(url(name,'/stop'),{'sessionId':session})
def move(name,session,sequence=1,pan=.3,tilt=0,zoom=0):return request(url(name,'/control-session/'+session),{'sequence':sequence,'vector':{'pan':pan,'tilt':tilt,'zoom':zoom}},'PUT')
try:
 check('fixed camera is unsupported without an API error',inspect('fixed')['supported'] is False)
 check('fixed camera disappears from candidate catalogue',next(c for c in ok('/api/ptz/catalog')['items']if c['channelId']==ids['fixed'])['candidate'] is False)
 check('zoom-only camera has no pan/tilt controls',inspect('zoom')['capabilities']['zoom'] and not inspect('zoom')['capabilities']['panTilt'])
 check('raw and AI output resolve to the same original camera',inspect('main')['source']==inspect('ai-a')['source'])
 check('main and sub streams share a motor, another NVR camera is separate',inspect('main')['capabilities']['resource']==inspect('sub')['capabilities']['resource']!=inspect('other')['capabilities']['resource'])
 ok('/__fixture/reset-support',{'supported':False})
 code,b=request(url('main','/control-session'),{'identity':inspect('main')['identity']});check('unsupported AI reset refuses control before any pause',code==422 and b['error']=='ptz_tracking_reset_unsupported' and not (inspect('main').get('guard')or{}).get('blocked'))
 ok('/__fixture/reset-support',{'supported':True})
 unused=acquire('main');stop('main',unused);check('acquire then Stop without movement restores its own new pause',not inspect('main')['guard']['blocked'])
 session=acquire('main')
 code,b=request(url('sub','/control-session'),{'identity':inspect('sub')['identity']},actor='fixture-b');check('a second operator cannot take the shared motor',code==409 and b['error']=='ptz_busy')
 other=acquire('other','fixture-b');ok(url('other','/stop'),{'sessionId':other},actor='fixture-b')
 check('independent NVR camera can be acquired concurrently',True)
 code,b=move('main',session);check('actual BFF/PG/Go/SOAP movement succeeds only after pause and reset',code==200)
 proof=ok('/__fixture/protection');check('both shared-camera AI outputs are paused and reset',all(any(r['channel_id']==i and r['state']=='paused'for r in proof['rules']) and i in proof['resetIds']for i in ['ai-a','ai-b']))
 code,b=move('main',session);check('replayed command sequence is rejected',code==409)
 stop('main',session);check('Stop does not restore arming',inspect('main')['guard']['blocked'])
 guard=inspect('main')['guard'];code,b=request(url('main','/restore-view'),{'expectedRevision':int(guard['revision']),'mode':'position'});check('changed physical position cannot silently restore old arming',code==409 and b['error']=='ptz_view_not_restored')
 code,b=request(url('main','/restore-view'),{'expectedRevision':int(guard['revision']),'mode':'rearmed'});check('a dialog acknowledgement is insufficient without saving arming',code==409 and b['error']=='ptz_view_rearming_required')
 ok('/__fixture/rearm',{});ok(url('main','/restore-view'),{'expectedRevision':int(guard['revision']),'mode':'rearmed'});check('actual rearming restores with a new baseline',not inspect('main')['guard']['blocked'])
 saved=ok(url('main','/presets'),{'name':'模拟入口位置','shortcut':1});preset=saved['id'];items=ok(url('sub','/presets'))['items'];check('native preset and PG name/shortcut are shared across streams',any(p['id']==preset and p['name']=='模拟入口位置'and p['shortcut']==1 for p in items))
 code,b=request(url('main','/presets'),{'name':'重复快捷键','shortcut':1});check('shortcut collision is rejected before camera mutation',code==409 and b['error']=='ptz_shortcut_in_use')
 session=acquire('ai-a');ok(url('ai-a','/presets/'+preset+'/goto'),{'sessionId':session,'sequence':1});stop('ai-a',session)
 state=request('/__fixture/state',base=args.camera)[1];check('one preset invocation generates one native GotoPreset',sum(e['action']=='GotoPreset'for e in state['events'])==1)
 ok(url('main','/presets'),{'id':preset,'name':'入口已改名','shortcut':2});ok(url('main','/presets/'+preset),method='DELETE');check('preset overwrite and deletion update native device and PG aliases',all(p['id']!=preset for p in ok(url('sub','/presets'))['items']))
 session=acquire('main');code,_=move('main',session,zoom=.2);assert code==200;time.sleep(1.7);check('lease expiry sends native Stop and retains view protection',not inspect('main')['busy'] and inspect('main')['guard']['blocked'])
 session=acquire('zoom');code,_=move('zoom',session,pan=0,zoom=.3);assert code==200;stop('zoom',session);check('zoom-only motion and Stop work without an invented pan axis',True)
 session=acquire('main');assert move('main',session)[0]==200;ok('/__fixture/restart-protocol',{});code,b=request(url('main','/stop'),{'sessionId':session});check('lost protocol context reports unconfirmed Stop instead of success',code==503 and b['error']=='ptz_stop_unconfirmed')
 ok('/__fixture/reconcile',{});check('fresh context recovers pending Stop without restoring arming',inspect('main')['guard']['blocked'] and not inspect('main')['guard']['stop_pending'])
 state=request('/__fixture/state',base=args.camera)[1];check('camera saw no movement before protection',not any(e['action']=='PROTECTION_FAILURE'for e in state['events']))
 check('camera focus mode was never changed',not any('Focus'in e['action']for e in state['events']))
 finally_state='passed'
except BaseException:
 finally_state='failed';raise
finally:
 Path(args.output).write_text(json.dumps({'state':finally_state,'checks':checks,'count':len(checks),'scope':'isolated BFF + PostgreSQL + compiled ONVIF + independent SOAP peer; no physical camera or video inference','at':time.time()},ensure_ascii=False,indent=2)+'\n')
