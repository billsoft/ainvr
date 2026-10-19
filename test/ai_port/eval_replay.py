"""Evaluate tracking replays. usage: eval_replay.py <replay_dir> <suffix>"""
import json,math,sys,collections,statistics
D=sys.argv[1];S=sys.argv[2]
def load(n):return json.load(open(f'{D}/{n}-input.json')),json.load(open(f'{D}/{n}-{S}.json'))
def c(b):return (b['x']+b['w']/2,b['y']+b['h']/2)
def fragments(inp,out,cls='person'):
  F=inp['frames'];O=out['frames'];tracks=collections.OrderedDict();n=t=0
  for i,(f,o) in enumerate(zip(F,O)):
    for d,tid in zip(f['dets'],o['ids']):
      if d['c']!=cls:continue
      n+=1
      if tid:t+=1;tracks.setdefault(tid,[]).append((i,d['b']))
  ends={k:v[-1] for k,v in tracks.items()};frag=0
  for k,(bi,bb) in ((k,v[0]) for k,v in tracks.items()):
    for a,(ai,ab) in ends.items():
      if a!=k and ai<bi and F[bi]['pts']-F[ai]['pts']<=2e9 and math.dist(c(ab),c(bb))<=1.5*math.hypot(ab['w'],ab['h']):frag+=1;break
  life=[len(v) for v in tracks.values()]
  return dict(person_dets=n,with_id=t,id_ratio=round(t/max(n,1),3),tracks=len(tracks),frag_candidates=frag,
              track_frames_median=statistics.median(life) if life else 0)
def corridor(name,run,ann_path):
  inp,out=load(name);ann=json.load(open(ann_path))
  rep=json.load(open({'stride5':f'{D}/../corridor-bpu-tracking-full-v2.json','stride1':f'{D}/../corridor-bpu-tracking-full-stride1-v3.json'}[run]))['results']
  rep=sorted(rep,key=lambda x:x['frame']['frame_index'])
  person_of={i:p['person'].split()[0] for p in ann['people'] for i in p[run]}
  per=collections.defaultdict(set);owner=collections.defaultdict(set)
  for f,o,x in zip(inp['frames'],out['frames'],rep):
    for d,tid,old in zip(f['dets'],o['ids'],x['frame']['detections']):
      if d['c']!='person':continue
      p=person_of.get((old.get('track_id') or '').split(':')[-1]) if old.get('track_id') else None
      if p and tid:per[p].add(tid);owner[tid].add(p)
  return dict(ids_per_person={p:len(v) for p,v in sorted(per.items())},fragmented=sum(len(v)>1 for v in per.values()),
              swaps=sum(len(v)>1 for v in owner.values()),people_covered=len(per),**fragments(inp,out))
ann=f'{D}/../corridor-identity-annotation-v1.json'
res=dict(gate_10fps=fragments(*load('gate-10fps')),corridor_stride5=corridor('corridor-stride5','stride5',ann),
         corridor_stride1=corridor('corridor-stride1','stride1',ann))
print(json.dumps(res,indent=1));json.dump(res,open(f'{D}/eval-{S}.json','w'),indent=1)
