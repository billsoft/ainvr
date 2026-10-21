#!/usr/bin/env python3
"""Deploy a passed native candidate with unchanged channels and live SEI gates.
Never changes or enables observation configuration, recorder or SRS channels.
"""
import argparse,hashlib,json,pathlib,subprocess,time,urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[2]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()
def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--candidate',required=True,type=pathlib.Path);a=parser.parse_args()
 report={'started_at':time.time(),'phase':'preflight','recorder_restarted':False,'observation_enabled_by_this_run':False}
 result=ROOT/'test/results/alarm-ai-deployment-20261019.json';installed=None
 def save(phase,**fields):
  report.update(phase=phase,updated_at=time.time(),**fields);result.write_text(json.dumps(report,indent=2)+'\n')
 def system(name,field):return subprocess.check_output(['systemctl','show',name,'-p',field,'--value'],text=True).strip()
 def installer(binary):
  r=subprocess.run(['python3',str(ROOT/'deploy-package/install-ai-s100p.py'),'--binary',str(binary),'--start'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=100)
  if r.returncode:raise RuntimeError('Transactional installer failed (its rollback remains authoritative)')
  return json.loads(r.stdout.strip().splitlines()[-1])
 cfg=json.loads((ROOT/'deploy/s100p/runtime/ai-service.json').read_text());key=cfg['server']['api_key']
 def api(path):
  req=urllib.request.Request('http://127.0.0.1:8000'+path,headers={'x-api-key':key})
  with urllib.request.urlopen(req,timeout=5) as r:return json.load(r)
 def configs(data):return {c['id']:c['config'] for c in data['channels']}
 try:
  if a.candidate.resolve()!=a.candidate or not str(a.candidate).startswith('/mnt/ainvr-ssd/ainvr-alarm-native-'):raise RuntimeError('Canonical passed SSD candidate required')
  state=json.loads((a.candidate/'status.json').read_text());manifest=json.loads((a.candidate/'source-manifest.json').read_text())
  if state['phase']!='passed' or sha(pathlib.Path(state['binary']))!=state['binary_sha256']:raise RuntimeError('Native gates not passed')
  if any(sha(ROOT/rel)!=h for rel,h in manifest.items()):raise RuntimeError('Source changed since native verification')
  protected={str(f):sha(ROOT/f) for f in ['deploy/s100p/runtime/ai-service.json','deploy/s100p/runtime/ai-service.env','data/ai/config_overlay.json']}
  recorder_before={k:system('ainvr-recorder.service',k) for k in ['MainPID','ExecMainStartTimestampMonotonic','ActiveState']}
  if recorder_before['ActiveState']!='active':raise RuntimeError('Recorder must already be active')
  before=api('/api/v1/channels');running={c['id'] for c in before['channels'] if c['state']=='running'}
  if not running:raise RuntimeError('No running channel for live acceptance')
  report.update(candidate=str(a.candidate),candidate_sha256=state['binary_sha256'],configuration_sha256=digest(configs(before)),running_channels=sorted(running),recorder_before=recorder_before)
  save('installing')
  installed=installer(pathlib.Path(state['binary']));save('checking-live-results',installation=installed)
  deadline=time.monotonic()+90;first=None
  while time.monotonic()<deadline:
   current=api('/api/v1/channels')
   if configs(current)!=configs(before):raise RuntimeError('Channel configuration changed')
   selected={c['id']:c for c in current['channels'] if c['id'] in running}
   ready=len(selected)==len(running) and all(c['state']=='running' and c['stats']['inference_count']>=20 and c['stats']['publish']['running'] and c['stats']['publish']['sei_injected']>=c['stats']['inference_count']*.9 and c['stats']['consecutive_errors']==0 for c in selected.values())
   if ready:
    if first is None:first=(time.monotonic(),{i:c['stats']['inference_count'] for i,c in selected.items()})
    if time.monotonic()-first[0]>=8:
     warm={i:(c['stats']['inference_count']-first[1][i])/(time.monotonic()-first[0]) for i,c in selected.items()}
     if any(warm[i]<max(.05,min(b['stats']['inference_fps_target'],b['stats']['inference_fps_actual'])*.8) for b in before['channels'] if (i:=b['id']) in running):raise RuntimeError('Live throughput regressed')
     break
   time.sleep(1)
  else:raise RuntimeError('Inference/SEI acceptance timed out')
  h=api('/health')
  if not h.get('business',{}).get('ready') or h['business'].get('license_allowed') is not True:raise RuntimeError('Business readiness not restored')
  if {k:system('ainvr-recorder.service',k) for k in recorder_before}!=recorder_before:raise RuntimeError('Recorder identity changed externally')
  if any(sha(pathlib.Path(f))!=v for f,v in protected.items()):raise RuntimeError('Protected file changed')
  save('passed',warm_inference_fps=warm,channels=[{'id':i,'state':c['state'],'inference_count':c['stats']['inference_count'],'sei_injected':c['stats']['publish']['sei_injected'],'consecutive_errors':c['stats']['consecutive_errors']} for i,c in selected.items()],business_ready=True,recorder_unchanged=True,configuration_unchanged=True)
 except Exception as e:
  if installed:
   save('rolling-back',error_type=type(e).__name__)
   restored=installer(pathlib.Path(installed['rollback'])/'ainvr_ai_service');save('rolled-back',rollback_installation=restored)
  else:save('failed',error_type=type(e).__name__)
  raise
if __name__=='__main__':main()
