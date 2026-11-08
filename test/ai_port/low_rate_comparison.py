"""Known synthetic trajectories at 2/3 FPS; not an annotated camera accuracy claim."""
from pathlib import Path
import tempfile,subprocess,json,sys
reports=[]
with tempfile.TemporaryDirectory(prefix='low-rate-',dir=sys.argv[3]) as folder:
 for fps in (2,3):
  root=Path(folder);source=root/f'{fps}.jsonl';output=root/f'{fps}-out.jsonl'
  with source.open('w') as file:
   for channel in range(16):
    at=0
    for i in range(30*fps):
     at+=(1.4,.6,1,1)[i%4]/fps;detections=[]
     for target in range(4):
      if i==2*fps and target==0:continue
      x=100+25*at if target%2==0 else 850-25*at
      detections.append({'truth_id':target,'class_id':0,'class_name':'person','confidence':.95,'bbox':{'x':x,'y':100+target*200,'w':50,'h':100}})
     row={'channel_id':f'synthetic-{channel}','frame_pts_ns':round(at*1e9),'frame_index':i,'frame_width':1000,'frame_height':1000,'timestamp':1794130000+at+(i%2)*.04,'detections':detections}
     file.write(json.dumps(row)+'\n')
  subprocess.run([sys.argv[1],str(source),str(output)],check=True,capture_output=True,timeout=20)
  counts=subprocess.run([sys.argv[2],str(Path(__file__).with_name('low_rate_business_replay.mjs')),str(output)],check=True,capture_output=True,text=True,timeout=20)
  identities={};switches=0;fragmentations=0;low_quality=0;gaps=0;missing=set()
  for line in output.read_text().splitlines():
   frame=json.loads(line);a=frame['model_extra']['analytics'];low_quality+=not a['cadence']['meets_target'];gaps+=a['continuity_gap']
   for d,id in zip(frame['detections'],frame['assigned_ids']):
    key=(frame['channel_id'],d['truth_id'])
    if not id:
     if key in identities:missing.add(key)
     continue
    if key in identities and id!=identities[key]:switches+=1
    if key in missing:fragmentations+=1;missing.remove(key)
    identities[key]=id
  assert switches==fragmentations==gaps==0
  assert low_quality>0 # diagnostic failure must not suppress valid observed events
  reports.append({'fps':fps,'ids':len(identities),'id_switches':switches,'observed_track_fragmentations':fragmentations,'gap_frames':gaps,'cadence_below_target_frames':low_quality,'business':json.loads(counts.stdout)})
report={'basis':'Known synthetic truth, including scheduling jitter and a brief occlusion; not real-camera ground truth','results':reports}
Path(sys.argv[3],'low-rate-comparison.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
