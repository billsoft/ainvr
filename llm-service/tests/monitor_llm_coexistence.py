"""Read-only, finite coexistence observations; never changes channel settings."""
import json, time, urllib.request, subprocess
from pathlib import Path
R=Path('/home/sunrise/ainvr')
O=R/'test/results/llm-service-development/live-coexistence.json'
server=json.loads((R/'deploy/s100p/runtime/ai-service.json').read_text())['server']
def get(url,headers=None):
    with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=5) as f:return json.load(f)
report={'samples':[],'duration_s':4000,'changes_to_channels':False}
start=time.monotonic()
while time.monotonic()-start<4000:
    sample={'elapsed_s':time.monotonic()-start,'time':time.time()}
    try:
        channels=get('http://127.0.0.1:'+str(server['port'])+'/api/v1/channels',{'x-api-key':server['api_key']})['channels']
        sample['channels']=[{'id':x['id'],'name':x['name'],'state':x['state'],'model':x['config']['model']['name'],'archive_enabled':x['config']['snapshot']['enabled'],'stats':x['stats']} for x in channels]
        sample['ai_health']=get('http://127.0.0.1:'+str(server['port'])+'/health')
        sample['llm']=get('http://127.0.0.1:8300/health')
        streams=get('http://127.0.0.1:1985/api/v1/streams')['streams']
        sample['streams']=[{'name':x['name'],'video':x.get('video')} for x in streams]
        sample['pids']={u:subprocess.check_output(['systemctl','show',u,'-p','MainPID','--value'],text=True,timeout=5).strip() for u in ['ainvr-ai','ainvr-recorder','ainvr-ingest']}
    except Exception as e:sample['error']=type(e).__name__
    report['samples'].append(sample)
    tmp=O.with_suffix('.next');tmp.write_text(json.dumps(report));tmp.replace(O)
    time.sleep(15)
report['finished']=True;O.write_text(json.dumps(report))
