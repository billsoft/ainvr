#!/usr/bin/env python3
"""Read-only AINVR deployed-channel check. Never creates or changes channels."""
import argparse,json,time,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser(description=__doc__);p.add_argument('channel_id');args=p.parse_args()
from urllib.parse import quote
key=json.loads((root/'deploy/s100p/runtime/ai-service.json').read_text())['server']['api_key']
base='http://127.0.0.1:8000/api/v1/channels/'+quote(args.channel_id,safe='')
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url,headers={'x-api-key':key}),timeout=5) as r:return json.load(r)
a=get(base);start=time.monotonic();time.sleep(10);b=get(base);elapsed=time.monotonic()-start
latest=get(base+'/results/latest');frame=latest.get('result') or {};s=b['stats']
evidence={'channel_id':args.channel_id,'state':b['state'],'sample_seconds':elapsed,
 'decode_fps':(s['decoded']-a['stats']['decoded'])/elapsed,
 'inference_fps':(s['completed']-a['stats']['completed'])/elapsed,
 'source_failures':s['source_failures'],'has_result':latest['has_result'],
 'frame_size':[frame.get('frame_width'),frame.get('frame_height')],
 'model_provider':frame.get('model',{}).get('provider'),'last_error':s.get('last_error','')}
evidence['passed']=b['state']=='running' and s['decoded']>a['stats']['decoded'] and s['completed']>a['stats']['completed'] and latest['has_result']
(root/'test/results/production-channel-check.json').write_text(json.dumps(evidence,indent=2));print(json.dumps(evidence))
raise SystemExit(0 if evidence['passed'] else 1)
