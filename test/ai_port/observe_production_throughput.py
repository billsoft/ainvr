#!/usr/bin/env python3
"""Read-only 120-second production throughput audit. Never persists credentials."""
import argparse
import hashlib,json,statistics,subprocess,time,urllib.request
from pathlib import Path
R=Path('/home/sunrise/ainvr')
B=Path('/mnt/ainvr-ssd/migration-backups/inference-throughput-20261013')
def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--channel-id',required=True)
 parser.add_argument('--output',type=Path,required=True)
 parser.add_argument('--min-fps',type=float,default=29)
 args=parser.parse_args()
 if args.output.exists():parser.error('output already exists; preserve previous evidence')
 c=json.loads((R/'deploy/s100p/runtime/ai-service.json').read_text())
 def read():
  q=urllib.request.Request('http://127.0.0.1:8000/api/v1/channels',headers={'x-api-key':c['server']['api_key']})
  channels=json.load(urllib.request.urlopen(q,timeout=5))['channels']
  return next(ch for ch in channels if ch['id']==args.channel_id)
 a=read();samples=[]
 for i in range(25):
  if i:time.sleep(5)
  ch=read();s=ch['stats'];pid=subprocess.check_output(['systemctl','show','ainvr-ai','-p','MainPID','--value'],text=True).strip()
  rss=int(next(x.split()[1] for x in Path('/proc/'+pid+'/status').read_text().splitlines() if x.startswith('VmRSS:')))
  samples.append({'pid':pid,'time':time.monotonic(),'inferences':s['inference_count'],'frames':s['frame_count'],'bpu':float(Path('/sys/devices/system/bpu/ratio').read_text().strip().replace('%','')),'rss_kib':rss,'sei':s['publish']['sei_injected'],'late':s['publish']['buffer']['too_late'],'reconnects':s['publish']['reconnect_count'],'errors':s['consecutive_errors'],'last_error':s['last_error']})
 x,y=samples[0],samples[-1];dt=y['time']-x['time']
 original=a['config']
 changed=[k for k in set(original)|set(ch['config']) if original.get(k)!=ch['config'].get(k)]
 report={'measured_seconds':dt,'fps':(y['inferences']-x['inferences'])/dt,'source_fps':(y['frames']-x['frames'])/dt,'mean_bpu_percent':statistics.mean(v['bpu'] for v in samples),'peak_rss_kib':max(v['rss_kib'] for v in samples),'sei_injected':y['sei']-x['sei'],'sei_late':y['late']-x['late'],'publisher_reconnects':y['reconnects']-x['reconnects'],'config_changed_fields':changed,'target_fps':ch['config']['inference_fps'],'timing':ch['stats']['timing'],'samples':samples,'health':json.load(urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=5)),'binary_sha256':hashlib.sha256((R/'deploy/s100p/bin/ainvr_ai_service').read_bytes()).hexdigest(),'services':{u:subprocess.check_output(['systemctl','is-active',u],text=True).strip() for u in ['ainvr-ai','ainvr-recorder','ainvr-web']}}
 report['passed']=report['fps']>=args.min_fps and not changed and len({v['pid'] for v in samples})==1 and all(samples[i]['inferences']>=samples[i-1]['inferences'] for i in range(1,len(samples))) and report['sei_late']==0 and report['publisher_reconnects']==0 and all(v['last_error'] is None and v['errors']==0 for v in samples)
 with args.output.open('x') as output:
  output.write(json.dumps(report,indent=2)+'\n')
 print(json.dumps({k:v for k,v in report.items() if k not in ['samples','timing']}))

if __name__ == '__main__':
 main()
