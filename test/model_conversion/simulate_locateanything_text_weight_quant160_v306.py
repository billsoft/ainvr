"""v306:PC simulation of text-decoder weight quantization on independent160 with actual BPU vision features.

Original LocateAnything language model in native BF16 on CUDA (v305 FP32 was too slow/memory-bound);
quantized weights are stored back in BF16 (<=0.4% relative rounding, identical for all variants); the deployed BPU29 vision features (v302) are
injected. Variant 'none' (no weight quantization), 'row8' (per-output-row symmetric INT8, like the deployed
official FakeQuantLinear) or 'g32' (symmetric INT8 with one scale per 32 input channels). All 36 layers'
linears and lm_head are quantized; activations are not simulated. Research attribution only.
"""
import os,sys
os.environ['OPENBLAS_NUM_THREADS']='1';os.environ['OMP_NUM_THREADS']='2'
sys.path.insert(0,'/opt/locate-reference-deps')
from pathlib import Path
import json,hashlib,time,traceback,ast,re,math,gc
import numpy as np
import torch
from transformers import AutoModel,AutoConfig,AutoProcessor
VARIANT=sys.argv[1];assert VARIANT in ('none','row8','g32')
BASE=Path('/work/official-llm-v1');D=BASE/'ref160-v303';REF=D/'independent-final-native-reference-v2-head-o2';FEAT=D/'vision-all27-qk16sv16-o0-v296-board-package-features160-v302'
SOURCE=Path('/opt/locate-original-weights');HELPER=BASE/'validate_locateanything_official_heldout_bpu_v2.py';OUT=BASE/('text-weight-quant160-v306-'+VARIANT)
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
assert not OUT.exists() and sha(REF/'reference-index-v3.json')=='8b16861bd8f5c78e050dfae3a41a18597ca887105fbac636469e8ffb2e8ef253' and sha(HELPER)=='616e0504988c3ff480922717f9c18a0538ce3395752d42f4bc554fdfd01cef1b'
cases=json.loads((REF/'reference-index-v3.json').read_text())['cases'];fm=json.loads((FEAT/'status.json').read_text())
OUT.mkdir();r=dict(status='loading',started=time.time(),source_sha256=sha(Path(__file__)),variant=VARIANT,scope=__doc__,cases=[])
def save():
 p=OUT/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+'\n');p.replace(OUT/'status.json')
tree=ast.parse(HELPER.read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'parse_response','iou','maximum_matches'}];f=dict(re=re);exec(compile(ast.Module(body=nodes,type_ignores=[]),str(HELPER),'exec'),f);parse,iou,match=f['parse_response'],f['iou'],f['maximum_matches']
def score(ans,t):
 m=p=q=0
 for c,a in zip(cases,ans):
  if str(c['reference_eligible'])!='True' or c['kind']!='box':continue
  R=parse(c['response'])['boxes'];C=parse(a)['boxes'];m+=len(match(R,C,lambda x,y:iou(x,y)>=t));p+=len(C);q+=len(R)
 return dict(matched=m,predicted=p,reference=q,P=m/p if p else None,R=m/q if q else None)
@torch.no_grad()
def quantize(w):
 w=w.float()
 if VARIANT=='row8':s=w.abs().amax(1,keepdim=True).clamp_min(1e-12)/127;return (torch.round(w/s).clamp(-127,127)*s)
 o,i=w.shape;assert i%32==0;g=w.reshape(o,i//32,32);s=g.abs().amax(2,keepdim=True).clamp_min(1e-12)/127;return (torch.round(g/s).clamp(-127,127)*s).reshape(o,i)
model=None
try:
 save();torch.backends.cuda.matmul.allow_tf32=False;torch.backends.cudnn.allow_tf32=False
 config=AutoConfig.from_pretrained(str(SOURCE),trust_remote_code=True);config._attn_implementation='sdpa';config.text_config._attn_implementation='sdpa';config.vision_config._attn_implementation='sdpa'
 model=AutoModel.from_pretrained(str(SOURCE),config=config,torch_dtype=torch.bfloat16,device_map={'':'cuda:0'},trust_remote_code=True,attn_implementation='sdpa').eval();processor=AutoProcessor.from_pretrained(str(SOURCE),trust_remote_code=True,use_fast=False)
 lm=model.language_model;n=0
 if VARIANT!='none':
  head=lm.lm_head;tied=lm.model.embed_tokens.weight.data_ptr()==head.weight.data_ptr()
  if tied:head.weight=torch.nn.Parameter(head.weight.detach().clone())  # quantize the head without changing embeddings
  for layer in lm.model.layers:
   for mod in layer.modules():
    if isinstance(mod,torch.nn.Linear):mod.weight.data.copy_(quantize(mod.weight.data));n+=1
  head.weight.data.copy_(quantize(head.weight.data));n+=1
 r['quantized_linears']=n;r['status']='generating';save()
 feats={e['image_id']:np.load(FEAT/e['deployed']['feature_file'],allow_pickle=False) for e in fm['cases']}
 answers=[]
 with torch.inference_mode():
  for c in cases:
   pixels=torch.from_numpy(np.load(REF/c['pixels'],allow_pickle=False)).to('cuda:0',torch.bfloat16);ids=np.load(REF/c['ids'],allow_pickle=False)
   feat=torch.from_numpy(feats[c['image_id']]).to('cuda:0',torch.bfloat16)
   a=model.generate(pixel_values=pixels,input_ids=torch.from_numpy(ids[None]).to('cuda:0'),attention_mask=torch.ones((1,len(ids)),dtype=torch.int64,device='cuda:0'),visual_features=feat,image_grid_hws=None,tokenizer=processor.tokenizer,max_new_tokens=256,use_cache=True,generation_mode='slow',temperature=0.,do_sample=False,verbose=False)
   a=a[0] if isinstance(a,tuple) else a;answers.append(a);r['cases'].append(dict(index=c['index'],response=a,terminal='<|im_end|>' in a));save()
 r['scores']={str(t):score(answers,t) for t in [0.5,0.75,0.9]};r['terminal']=sum(x['terminal'] for x in r['cases']);r['status']='completed'
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:
 model=None;gc.collect();torch.cuda.empty_cache();r['finished']=time.time();save()
print(json.dumps({k:r.get(k) for k in ['status','variant','quantized_linears','scores','terminal','error']}))
