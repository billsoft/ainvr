"""Read-only: record every result frame of the gate channel for a fixed window (no config change)."""
from pathlib import Path
import json,sys,time,urllib.request
ROOT=Path('/home/sunrise/ainvr');CH='2baec0a3-9941-47dc-b1bd-d3d284488097'
OUT=Path(sys.argv[1]);SECONDS=int(sys.argv[2]) if len(sys.argv)>2 else 180
KEY=json.loads((ROOT/'data/ai/config_overlay.json').read_text())['server']['api_key']
def get(p):
 with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8000'+p,headers={'X-Api-Key':KEY}),timeout=10) as f:return json.load(f)
assert not OUT.exists()
cfg=get(f'/api/v1/channels/{CH}')['config'];frames={};dl=time.monotonic()+SECONDS;polls=0;max_new=0
while time.monotonic()<dl:
 res=get(f'/api/v1/channels/{CH}/results?limit=30');items=res.get('results',res if isinstance(res,list) else [])
 new=0
 for r in items:
  pts=r.get('frame_pts_ns')
  if pts is None or pts in frames:continue
  new+=1
  frames[pts]=dict(pts=pts,ts=r.get('timestamp'),w=r.get('frame_width'),h=r.get('frame_height'),
    dets=[dict(t=d.get('track_id'),c=d.get('class_name'),p=d.get('confidence'),b=d.get('bbox')) for d in r.get('detections',[])],
    tracks=[dict(t=t.get('track_id'),o=t.get('observation'),s=t.get('state'),age=t.get('observation_age_ms'),b=t.get('bbox'),v=t.get('velocity'),p=t.get('predicted_bbox'))
            for t in ((r.get('model_extra') or {}).get('analytics') or {}).get('tracks',[])],
    session=((r.get('model_extra') or {}).get('analytics') or {}).get('stream_session_id'))
 polls+=1;max_new=max(max_new,new);time.sleep(1)
seq=[frames[k] for k in sorted(frames)]
OUT.write_text(json.dumps(dict(channel=CH,model=cfg['model']['name'],inference_fps=cfg['inference_fps'],
  analytics=cfg.get('analytics'),seconds=SECONDS,polls=polls,max_new_per_poll=max_new,frames=seq),ensure_ascii=False)+'\n')
print(json.dumps(dict(frames=len(seq),polls=polls,max_new_per_poll=max_new)))
