#!/usr/bin/env python3
"""Read-only live AINVR alarm/video acceptance. Never print credentials or change config."""
import hashlib,json,pathlib,subprocess,time,urllib.request
ROOT=pathlib.Path('/home/sunrise/ainvr')
def get(url,headers=None):
 with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=8) as r:return json.load(r)
def service(s):return subprocess.check_output(['systemctl','show',s,'-p','MainPID','-p','ExecMainStartTimestampMonotonic']).decode()
def main():
 report={'phase':'sampling','started_at':time.time()};path=ROOT/'test/results/alarm-submit-live-20261019.json'
 try:
  bootstrap=json.loads((ROOT/'deploy/s100p/runtime/alarm-service-bootstrap.json').read_text());headers={'x-service-token':bootstrap['service_token']}
  state=get('http://127.0.0.1:3001/api/v1/config/service-states/alarm-service',headers)['data']
  docs=get('http://127.0.0.1:3001/api/v1/config/versions/'+str(state['appliedVersion'])+'/snapshot?service=alarm-service',headers)['data'];cfg=docs[0]['config']
  alarm=get('http://127.0.0.1:'+str(cfg['port'])+'/v1/status',{'authorization':'Bearer '+cfg['api_token']})
  ai=json.loads((ROOT/'deploy/s100p/runtime/ai-service.json').read_text());key=ai['server']['api_key']
  def channels():return get('http://127.0.0.1:8000/api/v1/channels',{'x-api-key':key})['channels']
  baseline={s:service(s) for s in ['ainvr-ai.service','ainvr-recorder.service']};before=channels();start=time.monotonic();time.sleep(10);after=channels();elapsed=time.monotonic()-start
  assert {c['id']:c['config'] for c in before}=={c['id']:c['config'] for c in after}
  assert all(service(s)==v for s,v in baseline.items());rows=[]
  for b in before:
   if b['state']!='running':continue
   c=next(c for c in after if c['id']==b['id']);stats=c['stats'];old=b['stats'];inferred=stats['inference_count']-old['inference_count'];sei=stats['publish']['sei_injected']-old['publish']['sei_injected']
   assert c['state']=='running' and inferred>0 and sei>=inferred*.9 and stats['consecutive_errors']==0
   latest=get('http://127.0.0.1:8000/api/v1/channels/'+c['id']+'/results/latest',{'x-api-key':key})
   delivery=latest.get('result',{}).get('model_extra',{}).get('observation_delivery',{})
   assert delivery.get('stage_failures',0)==0
   rows.append({'id':c['id'],'inference_delta':inferred,'sei_delta':sei,'warm_fps':inferred/elapsed,'stage_failures':delivery.get('stage_failures'),'state':c['state']})
  assert rows and alarm['status']=='ready' and alarm['storage']['writable'] and alarm['observation_journal']['failed']==0
  js="""import {MongoClient} from '/home/sunrise/ainvr/alarm-service/node_modules/mongodb/lib/index.js';
let raw='';for await(const chunk of process.stdin)raw+=chunk;const cfg=JSON.parse(raw);const client=new MongoClient(cfg.mongo_uri,{serverSelectionTimeoutMS:5000});
try{await client.connect();const db=client.db(cfg.database);process.stdout.write(JSON.stringify({alarms:await db.collection('alarms').countDocuments(),active_alarms:await db.collection('alarms').countDocuments({'lifecycle.state':'active'}),behavior_facts:await db.collection('behavior_events').countDocuments(),confirmed:await db.collection('alarms').countDocuments({'handling.state':'acknowledged'})}));}catch{process.stderr.write('Read-only database validation failed');process.exitCode=1;}finally{await client.close();}"""
  result=subprocess.run(['/opt/ainvr/node-v24.20.0-linux-arm64/bin/node','--input-type=module','--eval',js],input=json.dumps({'mongo_uri':cfg['mongo_uri'],'database':cfg['database']}).encode(),capture_output=True,check=True,timeout=15)
  report.update(phase='passed',sample_seconds=elapsed,channels=rows,configuration_unchanged=True,video_services_unchanged=True,baseline=baseline,applied_version=state['appliedVersion'],rule_configuration=alarm['rule_configuration'],observation_journal=alarm['observation_journal'],evidence_vault=alarm['evidence_vault'],persisted=json.loads(result.stdout))
 except Exception as error:report.update(phase='failed',error_type=type(error).__name__);raise
 finally:report['updated_at']=time.time();path.write_text(json.dumps(report,indent=2)+'\n')
if __name__=='__main__':main()
