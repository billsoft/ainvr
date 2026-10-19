"""v303:independent160 attribution - actual BPU29 vision features + unchanged original BF16 language.

Variant 'deployed' or 'candidate' features (board capture v302). Two native-vision interface positive
controls must reproduce the frozen native responses exactly. The same parser/IoU>=0.9 matcher also
re-scores the stored full-BPU v285 answers so all numbers share one ruler. Research attribution only.
"""
import os,sys
os.environ['OPENBLAS_NUM_THREADS']='1';os.environ['OMP_NUM_THREADS']='2'
sys.path.insert(0,'/opt/locate-reference-deps')
from pathlib import Path
from collections import Counter
import json,hashlib,time,traceback,ast,re,math,gc
import numpy as np
import torch,transformers
from transformers import AutoModel,AutoConfig,AutoProcessor
VARIANT=sys.argv[1];assert VARIANT in ('deployed','candidate')
BASE=Path('/work/official-llm-v1');D=BASE/'ref160-v303';REF=D/'independent-final-native-reference-v2-head-o2';FEAT=D/'vision-all27-qk16sv16-o0-v296-board-package-features160-v302'
FULL=D/'vision-o2-frozen160-v285/status.json';SOURCE=Path('/opt/locate-original-weights');HELPER=BASE/'validate_locateanything_official_heldout_bpu_v2.py'
OUT=BASE/('vision-text-attribution160-v303-'+VARIANT)
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
assert not OUT.exists() and sha(REF/'reference-index-v3.json')=='8b16861bd8f5c78e050dfae3a41a18597ca887105fbac636469e8ffb2e8ef253'
assert sha(HELPER)=='616e0504988c3ff480922717f9c18a0538ce3395752d42f4bc554fdfd01cef1b'
ref=json.loads((REF/'reference-index-v3.json').read_text());cases=ref['cases'];assert len(cases)==160
fm=json.loads((FEAT/'status.json').read_text());assert fm['status']=='completed' and len(fm['cases'])==32
full=json.loads(FULL.read_text());assert len(full['cases'])==160
OUT.mkdir();r=dict(status='loading',started=time.time(),source_sha256=sha(Path(__file__)),variant=VARIANT,feature_manifest_sha256=sha(FEAT/'status.json'),scope=__doc__,controls=[],cases=[])
def save():
 p=OUT/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+'\n');p.replace(OUT/'status.json')
tree=ast.parse(HELPER.read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'parse_response','iou','maximum_matches'}];funcs=dict(re=re);exec(compile(ast.Module(body=nodes,type_ignores=[]),str(HELPER),'exec'),funcs);parse,iou,match=funcs['parse_response'],funcs['iou'],funcs['maximum_matches']
def score(responses):
 m=p=q=0;pm=pr=0;term=0
 for c,resp in zip(cases,responses):
  if resp is None:continue
  term+=int('<|im_end|>' in resp)
  if not (str(c['reference_eligible'])=='True'):continue
  refp=parse(c['response']);cand=parse(resp)
  if c['kind']=='box':m+=len(match(refp['boxes'],cand['boxes'],lambda x,y:iou(x,y)>=.9));p+=len(cand['boxes']);q+=len(refp['boxes'])
  else:pm+=len(match(refp['points'],cand['points'],lambda x,y:math.hypot(x[0]-y[0],x[1]-y[1])<=10));pr+=len(refp['points'])
 return dict(matched=m,predicted=p,reference=q,precision=m/p if p else None,recall=m/q if q else None,point_matches=pm,point_reference=pr,terminal=term)
model=None
try:
 save();torch.set_num_threads(2);torch.backends.cuda.matmul.allow_tf32=False;torch.backends.cudnn.allow_tf32=False
 config=AutoConfig.from_pretrained(str(SOURCE),trust_remote_code=True);config._attn_implementation='sdpa';config.text_config._attn_implementation='sdpa';config.vision_config._attn_implementation='sdpa'
 model=AutoModel.from_pretrained(str(SOURCE),config=config,torch_dtype=torch.bfloat16,device_map={'':'cuda:0'},trust_remote_code=True,attn_implementation='sdpa').eval();processor=AutoProcessor.from_pretrained(str(SOURCE),trust_remote_code=True,use_fast=False)
 assert sum(p.numel() for p in model.parameters())==3517975280
 feats={}
 for e in fm['cases']:
  f=FEAT/e[VARIANT]['feature_file'];assert sha(f)==e[VARIANT]['feature_sha256'];feats[e['image_id']]=np.load(f,allow_pickle=False)
 r['full_bpu_v285_rescored']=score([c['answer']['response'] if c.get('rpc_ok') else None for c in full['cases']]);r['status']='controls';save()
 def gen(c,feat=None):
  pixels=torch.from_numpy(np.load(REF/c['pixels'],allow_pickle=False)).to('cuda:0',torch.bfloat16);ids=np.load(REF/c['ids'],allow_pickle=False);grid=np.load(REF/c['grid'],allow_pickle=False)
  if feat is None:feat=model.mlp1(torch.cat(model.extract_feature(pixels,torch.from_numpy(grid).to('cuda:0')),dim=0))
  else:feat=torch.from_numpy(feat).to('cuda:0',torch.bfloat16)
  a=model.generate(pixel_values=pixels,input_ids=torch.from_numpy(ids[None]).to('cuda:0'),attention_mask=torch.ones((1,len(ids)),dtype=torch.int64,device='cuda:0'),visual_features=feat,image_grid_hws=None,tokenizer=processor.tokenizer,max_new_tokens=256,use_cache=True,generation_mode='slow',temperature=0.,do_sample=False,verbose=False)
  return a[0] if isinstance(a,tuple) else a
 with torch.inference_mode():
  for c in [cases[0],cases[1]]:
   a=gen(c);r['controls'].append(dict(index=c['index'],exact=a==c['response']));save()
  r['controls_all_exact']=all(x['exact'] for x in r['controls']);r['status']='generating';save()
  answers=[]
  for c in cases:
   a=gen(c,feats[c['image_id']]);answers.append(a);r['cases'].append(dict(index=c['index'],image_id=c['image_id'],query=c['query'],kind=c['kind'],response=a,terminal='<|im_end|>' in a));save()
 r['bpu_vision_native_text']=score(answers);r['status']='completed'
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:
 model=None;gc.collect();torch.cuda.empty_cache();r['finished']=time.time();save()
print(json.dumps({k:r.get(k) for k in ['status','controls_all_exact','full_bpu_v285_rescored','bpu_vision_native_text','error']}))
