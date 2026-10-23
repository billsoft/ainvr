"""Finite production-path target-crop acceptance. No channel/configuration writes.

Ground truth is target-bbox class, not whole-image presence. Wrong-class COCO
negatives do not establish field accuracy for posters, reflections or fire.
Never installs an automatic-review qualification or reads ION debugfs.
"""
import argparse,base64,hashlib,importlib.util,json,os,signal,statistics,subprocess,time,urllib.request,urllib.error
from pathlib import Path
R=Path('/home/sunrise/ainvr')
DATA=Path('/mnt/ainvr-ssd/llm-eval/v1')
def get(url,headers=None,body=None,timeout=10):
 req=urllib.request.Request(url,headers=headers or {},data=None if body is None else json.dumps(body).encode())
 with urllib.request.urlopen(req,timeout=timeout) as f:return json.load(f)
def main():
 p=argparse.ArgumentParser();p.add_argument('--seconds',type=int,default=3600);p.add_argument('--manifest',default=str(R/'test/results/review-v2-targets.jsonl'));args=p.parse_args()
 assert 60<=args.seconds<=7200
 spec=importlib.util.spec_from_file_location('deploy',R/'deploy-package/deploy-alarm-review.py');deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)
 cfg=deploy.config('llm-service');key=next(k['key'] for k in cfg['api_keys'] if k['name']=='alarm-review')
 ac=json.loads((R/'deploy/s100p/runtime/ai-service.json').read_text())['server'];aiurl='http://127.0.0.1:'+str(ac['port'])+'/api/v1/channels';aih={'x-api-key':ac['api_key']}
 output=R/'test/results/review-v2-acceptance';output.mkdir(exist_ok=True);(output/'images').mkdir(exist_ok=True)
 report={'started_at':time.time(),'target_seconds':args.seconds,'samples':[],'requests':[],'errors':[],'phase':'baseline','automatic_review_enabled':False}
 def save():
  dest=output/'report.json';temp=dest.with_suffix('.next');temp.write_text(json.dumps(report,ensure_ascii=False,indent=2));temp.replace(dest)
 def pid(unit):return subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],text=True,timeout=10).strip()
 units=['ainvr-ai','ainvr-recorder','ainvr-ingest','ainvr-llm'];before={s:pid(s) for s in units}
 channels=get(aiurl,aih)['channels'];original={v['id']:v['config'] for v in channels};running={v['id'] for v in channels if v['state']=='running'}
 report['running_channels']=sorted(running);report['before_pids']=before
 llmpid=before['ainvr-llm'];warm=None
 def snapshot():
  nonlocal warm
  values=get(aiurl,aih)['channels'];assert original=={v['id']:v['config'] for v in values},'Channel configuration changed'
  selected=[v for v in values if v['id'] in running]
  assert all(v['state']=='running' and v['stats']['consecutive_errors']<3 for v in selected),'Production AI unhealthy'
  h=get('http://127.0.0.1:8300/health');assert h['ready'],'Model no longer ready'
  rss=next(int(v.split()[1])*1024 for v in Path('/proc/'+llmpid+'/status').read_text().splitlines() if v.startswith('VmRSS:'))
  fds=len(list(Path('/proc/'+llmpid+'/fd').iterdir()));elapsed=time.monotonic()-started
  row={'elapsed_s':elapsed,'phase':report['phase'],'rss_bytes':rss,'fds':fds,'llm_requests':h['requests'],'channels':[{'id':v['id'],'fps':v['stats']['inference_fps_actual'],'target_fps':v['stats']['inference_fps_target'],'inference':v['stats']['inference_count'],'sei':v['stats'].get('publish',{}).get('sei_injected'),'errors':v['stats']['consecutive_errors']} for v in selected]}
  report['samples'].append(row)
  if elapsed>=180 and warm is None:warm=row
  if warm:assert rss-warm['rss_bytes']<64*1024**2 and fds-warm['fds']<=5,'Memory or FD growth exceeds stability limit'
  assert before=={s:pid(s) for s in units},'Production service restarted'
  save()
 def stop(*_):raise InterruptedError('Bounded test interrupted')
 for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,stop)
 started=time.monotonic();save()
 try:
  for _ in range(4):snapshot();time.sleep(15)
  items=[json.loads(l) for l in Path(args.manifest).read_text().splitlines() if l.strip()]
  baseline_scores={};i=0;report['phase']='target_quality_and_endurance';test_start=time.monotonic()
  while time.monotonic()-test_start<args.seconds:
   item=items[i%len(items)];data=(DATA/item['image']).read_bytes();label=item['kind'];description='核对图像中心指定目标是否为「'+label+'」，不要用其他目标代替。'
   body={'request_id':'validation-'+str(i)+'-'+item['id'],'image':{'jpeg_base64':base64.b64encode(data).decode(),'fit':'letterbox'},'preparation':{'version':1,'layout':'target-crop-v1','target':item['target'],'region':[[.3,.3],[.7,.3],[.7,.7],[.3,.7]],'approach_width_fraction':.05},'alarm':{'kind':label,'description':description}}
   began=time.monotonic()
   result=get('http://127.0.0.1:8300/v1/ainvr/tasks/alarm-review-zh-v1',{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body,90)
   row={'id':item['id'],'split':item['split'],'label':item['label'],'kind':label,'target':item['target'],'ground_truth_class':item['ground_truth_class'],'source_image':item['image'],'source_sha256':hashlib.sha256(data).hexdigest(),'real_score':result['real_score'],'model':result['model'],'template':result['template'],'duration_ms':(time.monotonic()-began)*1000}
   assert result['prepared_image']['layout']=='target-crop-v1'
   for name in ['prepared_image','context_image']:
    image=result[name];jpeg=base64.b64decode(image['jpeg_base64']);row[name]={k:v for k,v in image.items() if k!='jpeg_base64'};row[name]['sha256']=hashlib.sha256(jpeg).hexdigest()
    if i<len(items):(output/'images'/(item['id']+'-'+name+'.jpg')).write_bytes(jpeg)
   if item['id'] in baseline_scores:assert baseline_scores[item['id']]==row['real_score'],'Repeated target decision changed'
   else:baseline_scores[item['id']]=row['real_score']
   report['requests'].append(row);i+=1;snapshot()
  report.update(phase='complete',elapsed_s=time.monotonic()-test_start,passed=True)
 except BaseException as e:
  report.update(phase='failed',passed=False);report['errors'].append({'type':type(e).__name__,'message':str(e)[:200]});raise
 finally:
  report['ended_at']=time.time();report['after_pids']={s:pid(s) for s in units};save()
 if len(baseline_scores)<len(items):report['quality_incomplete']=True;save()
 print(json.dumps({'passed':report['passed'],'requests':len(report['requests']),'unique':len(baseline_scores),'report':str(output/'report.json')}))
if __name__=='__main__':main()
