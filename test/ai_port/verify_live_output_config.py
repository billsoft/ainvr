#!/usr/bin/env python3
"""Bind an existing operator-created input/output pair through the original API."""
import json, time, urllib.request
from pathlib import Path
root=Path(__file__).resolve().parents[2]
channel_id='2baec0a3-9941-47dc-b1bd-d3d284488097'
store=json.loads((root/'data/console/channels.json').read_text())['data']['channels']
source=next(c for c in store if c['id']==channel_id)
output=next(c for c in store if c['name']=='大门AI输出')
assert source['upstreamProtocol']=='rtmp' and output['upstreamProtocol']=='rtmp'
source_path=source['app']+'/'+source['streamName']
output_path=output['app']+'/'+output['streamName']
assert source_path=='live/xm' and output_path=='live/ai-n2q08c'
assert source_path!=output_path
settings=json.loads((root/'deploy/s100p/runtime/ai-service.json').read_text())
headers={'x-api-key':settings['server']['api_key'],'Content-Type':'application/json'}
base='http://127.0.0.1:8000/api/v1/channels/'+channel_id
def request(suffix='',patch=None):
    req=urllib.request.Request(base+suffix,headers=headers,
      data=None if patch is None else json.dumps(patch).encode(),
      method='GET' if patch is None else 'PUT')
    with urllib.request.urlopen(req,timeout=30) as f:return json.load(f)
before=request()
assert before['config']['manually_stopped'], 'Preserve the operator-stopped channel'
url=before['config']['stream']['url']
assert url in ['http://127.0.0.1:8080/live/xm.flv','rtmp://127.0.0.1:1935/live/xm']
backup=Path('/mnt/ainvr-ssd/migration-backups')/('output-config-'+time.strftime('%Y%m%d-%H%M%S'))
backup.mkdir(mode=0o700)
(backup/'previous-view.json').write_text(json.dumps(before));(backup/'previous-view.json').chmod(0o600)
patch={'stream':{'url':'rtmp://127.0.0.1:1935/'+source_path,'protocol':'rtmp'},
       'publish':{'enabled':True,'target_url':'rtmp://127.0.0.1:1935/'+output_path}}
result=request('/config',patch)
assert result['applied']
after=request()
assert after['config']['stream']==result['channel']['config']['stream']
assert after['config']['publish']['target_url']==patch['publish']['target_url']
assert after['config']['publish']['effective_target_url']==patch['publish']['target_url']
assert after['config']['manually_stopped'] and after['state']=='idle'
assert after['config']['model']==before['config']['model'], 'Output edit must preserve model configuration'
assert after['stats']['inference_count']==0
report={'passed':True,'source_channel':source['id'],'output_channel':output['id'],
  'source_stream':source_path,'output_stream':output_path,'saved_via':'original_control_api',
  'manually_stopped':True,'runtime_available':False,'model_preserved':True,'backup':str(backup)}
(root/'test/results/live-output-config.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
