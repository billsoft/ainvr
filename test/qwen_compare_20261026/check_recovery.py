from pathlib import Path
import json,time,urllib.request,urllib.error,subprocess
REPO=Path('/home/sunrise/ainvr');OUT=REPO/'test/results/qwen-compare-20261026'
base=json.loads((REPO/'deploy/s100p/runtime/ai-service.json').read_text())
overlay=json.loads((REPO/'data/ai/config_overlay.json').read_text())
key=overlay.get('server',{}).get('api_key') or base['server']['api_key']
def read(url,auth=False):
 request=urllib.request.Request(url,headers={'x-api-key':key} if auth else {})
 with urllib.request.urlopen(request,timeout=8) as response:return json.load(response)
def numbers(value):
 if isinstance(value,dict):return {k:numbers(v) for k,v in value.items() if not isinstance(v,str)}
 if isinstance(value,list):return [numbers(v) for v in value if not isinstance(v,str)]
 return value if isinstance(value,(int,float,bool,type(None))) else None
def snapshot():
 result={'at':time.time(),'services':{u:subprocess.run(['systemctl','is-active',u],text=True,capture_output=True).stdout.strip() for u in ['ainvr-ai','ainvr-llm','ainvr-locateanything-official-bpu','ainvr-review-reference','ainvr-recorder','ainvr-ingest','ainvr-alarm']}}
 for name,url in [('ai','http://127.0.0.1:8000/health'),('llm','http://127.0.0.1:8300/health'),('recorder','http://127.0.0.1:8100/v1/recorder/health')]:
  try:
   data=read(url);result[name]={**numbers(data),**{k:data[k] for k in ['status','model','state','version','licensePhase'] if k in data}}
  except Exception as e:result[name]={'error_type':type(e).__name__}
 try:
  data=read('http://127.0.0.1:1985/api/v1/streams');result['streams']=[{k:s.get(k) for k in ['name','frames','recv_bytes','send_bytes','kbps']}|{'publishing':s.get('publish',{}).get('active')} for s in data.get('streams',[])]
 except Exception as e:result['streams_error']=type(e).__name__
 try:
  channels=read('http://127.0.0.1:8000/api/v1/channels',True)['channels'];result['channels']=[]
  for c in channels:
   item={k:c.get(k) for k in ['id','name','state']};item['stats']=numbers(c.get('stats',{}));item['manually_stopped']=c.get('config',{}).get('manually_stopped')
   for part,path in [('latest','results/latest'),('archive','snapshots/overview')]:
    try:
     d=read(f"http://127.0.0.1:8000/api/v1/channels/{c['id']}/{path}",True)
     if part=='latest':item[part]={'has_result':d.get('has_result'),'timestamp':(d.get('result') or {}).get('timestamp')}
     else:item[part]={k:d.get(k) for k in ['enabled','connected','count','latest_timestamp']}|{'stats':numbers(d.get('archive_stats',{}))}
    except Exception as e:item[part]={'error_type':type(e).__name__}
   result['channels'].append(item)
 except Exception as e:result['channels_error']=type(e).__name__
 return result
values=[]
for i in range(3):
 values.append(snapshot());(OUT/'recovery-health.json').write_text(json.dumps(values,ensure_ascii=False,indent=2))
 if i<2:time.sleep(15)
for v in values:
 print(json.dumps({'at':v['at'],'services':v['services'],'ai_running':v.get('ai',{}).get('channels_running'),'llm_model':v.get('llm',{}).get('model'),'recorder_healthy':v.get('recorder',{}).get('storageHealthy'),'streams':v.get('streams'),'channels':[{k:c.get(k) for k in ['name','state','latest','archive']} for c in v.get('channels',[])]},ensure_ascii=False),flush=True)
