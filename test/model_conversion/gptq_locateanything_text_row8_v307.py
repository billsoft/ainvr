"""v307:sequential row-wise INT8 GPTQ of the 252 text-decoder linears, then independent160 evaluation.

Algorithm reference: https://github.com/IST-DASLab/gptq (act-order, damping .01, block 128).
Weights stay on the official per-row INT8 grid (scale=absmax/127, codes in [-127,127]) so the result
can later be compiled by the official FakeQuantLinear(w_bits=8) path with absmax fixed to 127*scale.
Calibration:old regression72 development prompts + native reference answers (teacher forcing),
deployed actual-BPU vision features (v297). The independent160 images are never used for calibration.
lm_head uses plain per-row INT8 rounding. Research only;no deployment.
"""
import os,sys
os.environ['OPENBLAS_NUM_THREADS']='1';os.environ['OMP_NUM_THREADS']='2'
sys.path.insert(0,'/opt/locate-reference-deps')
from pathlib import Path
import json,hashlib,time,traceback,ast,re,math,gc
import numpy as np
import torch
from transformers import AutoModel,AutoConfig,AutoProcessor
BASE=Path('/work/official-llm-v1');D=BASE/'ref160-v303';REF=D/'independent-final-native-reference-v2-head-o2';FEAT160=D/'vision-all27-qk16sv16-o0-v296-board-package-features160-v302'
OLD=Path('/opt/locate-official-grouped-heldout-native-v1/status.json');FEAT72=BASE/'vision-recipe-features-v297'
SOURCE=Path('/opt/locate-original-weights');HELPER=BASE/'validate_locateanything_official_heldout_bpu_v2.py'
OUT=BASE/'text-gptq-row8-v307';CODES=Path('/opt/locate-text-gptq-row8-v307')
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
assert not OUT.exists() and not CODES.exists()
assert sha(REF/'reference-index-v3.json')=='8b16861bd8f5c78e050dfae3a41a18597ca887105fbac636469e8ffb2e8ef253' and sha(HELPER)=='616e0504988c3ff480922717f9c18a0538ce3395752d42f4bc554fdfd01cef1b'
assert sha(OLD)=='c30d9baf8668d45b442168e71c3eeb98ce550f69ac16486413ba734f222b0690'
cases=json.loads((REF/'reference-index-v3.json').read_text())['cases'];old=json.loads(OLD.read_text())['cases'];assert len(old)==72
assert not {str(c['image_id']) for c in old}&{str(c['image_id']) for c in cases},'calibration must be disjoint from independent160'
OUT.mkdir();CODES.mkdir();r=dict(status='loading',started=time.time(),source_sha256=sha(Path(__file__)),scope=__doc__,modules=[],cases=[])
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
def gptq(name,mod,H):
 W=mod.weight.data.float().clone();rows,cols=W.shape;s=(W.abs().amax(1,keepdim=True)/127).clamp_min(1e-12)
 dead=torch.diag(H)==0;H[dead,dead]=1;W[:,dead]=0
 perm=torch.argsort(torch.diag(H),descending=True);W=W[:,perm];H=H[perm][:,perm]
 H[torch.arange(cols),torch.arange(cols)]+=.01*torch.mean(torch.diag(H))
 Hinv=torch.linalg.cholesky(torch.cholesky_inverse(torch.linalg.cholesky(H)),upper=True);Q=torch.zeros_like(W);err=0.
 for i1 in range(0,cols,128):
  i2=min(i1+128,cols);W1=W[:,i1:i2].clone();Q1=torch.zeros_like(W1);E1=torch.zeros_like(W1);Hi=Hinv[i1:i2,i1:i2]
  for i in range(i2-i1):
   w=W1[:,i];d=Hi[i,i];q=torch.round(w/s[:,0]).clamp(-127,127)*s[:,0];Q1[:,i]=q;e=(w-q)/d;W1[:,i:]-=e[:,None]*Hi[i,i:][None,:];E1[:,i]=e;err+=float(((w-q)**2/d**2).sum())
  Q[:,i1:i2]=Q1;W[:,i2:]-=E1@Hinv[i1:i2,i2:]
 Q=Q[:,torch.argsort(perm)];codes=torch.round(Q/s).clamp(-127,127)
 assert torch.allclose(codes*s,Q,atol=1e-6*float(s.max()))
 # official per-row grid requires each row's absmax code to stay 127 when absmax is fixed to 127*scale at build time
 np.savez(CODES/(name+'.npz'),codes=codes.to(torch.int8).cpu().numpy(),scales=s.cpu().numpy().astype(np.float32))
 mod.weight.data.copy_((codes*s).to(mod.weight.dtype));r['modules'].append(dict(name=name,shape=[rows,cols],gptq_loss=err,dead=int(dead.sum())))
model=None
try:
 save();torch.backends.cuda.matmul.allow_tf32=False
 config=AutoConfig.from_pretrained(str(SOURCE),trust_remote_code=True);config._attn_implementation='sdpa';config.text_config._attn_implementation='sdpa';config.vision_config._attn_implementation='sdpa'
 model=AutoModel.from_pretrained(str(SOURCE),config=config,torch_dtype=torch.bfloat16,device_map={'':'cuda:0'},trust_remote_code=True,attn_implementation='sdpa').eval();processor=AutoProcessor.from_pretrained(str(SOURCE),trust_remote_code=True,use_fast=False)
 lm=model.language_model;layers=lm.model.layers;tok=processor.tokenizer;img=model.config.image_token_index
 fm72=json.loads((FEAT72/'status.json').read_text());f72={c['image_id']:np.load(FEAT72/c['deployed']['feature_file'],allow_pickle=False) for c in fm72['cases']}
 # ---- capture layer-0 inputs for every calibration sequence (teacher forcing) ----
 r['status']='capturing';save();inps=[]
 class Stop(Exception):pass
 def catch(m,args,kwargs):
  inps.append((args[0] if args else kwargs.pop('hidden_states'),{k:v for k,v in kwargs.items() if k!='hidden_states'}));raise Stop
 h0=layers[0].register_forward_pre_hook(catch,with_kwargs=True)
 with torch.no_grad():
  for c in old:
   ids=np.load(c['ids'],allow_pickle=False);ans=tok.encode(c['response'],add_special_tokens=False);full=torch.tensor(np.concatenate([ids,np.array(ans,dtype=ids.dtype)])[None],device='cuda:0')
   feat=torch.from_numpy(f72[str(c['image_id'])]).to('cuda:0',torch.bfloat16)
   try:lm(input_ids=full,position_ids=torch.arange(full.shape[1],device='cuda:0')[None],use_cache=False,visual_features=feat,image_token_index=img)
   except Stop:pass
 h0.remove();r['calibration_sequences']=len(inps);r['calibration_tokens']=int(sum(x[0].shape[1] for x in inps));save()
 # ---- sequential per-layer GPTQ ----
 groups=[['self_attn.q_proj','self_attn.k_proj','self_attn.v_proj'],['self_attn.o_proj'],['mlp.gate_proj','mlp.up_proj'],['mlp.down_proj']]
 for li,layer in enumerate(layers):
  r['status']=f'gptq_layer_{li}';save();mods=dict(layer.named_modules())
  for g in groups:
   H={};hooks=[]
   def add(name):
    def hook(m,args):
     x=args[0].reshape(-1,args[0].shape[-1]).float();H[name]=H.get(name,0)+x.T@x
    return hook
   hooks.append(mods[g[0]].register_forward_pre_hook(add(g[0])))
   with torch.no_grad():
    for x,kw in inps:layer(x,**kw)
   for hk in hooks:hk.remove()
   for n in g:gptq(f'layer{li}.{n}',mods[n],H[g[0]].clone())
   del H;torch.cuda.empty_cache()
  with torch.no_grad():
   inps=[(layer(x,**kw)[0],kw) for x,kw in inps]
  save()
 head=lm.lm_head
 if lm.model.embed_tokens.weight.data_ptr()==head.weight.data_ptr():head.weight=torch.nn.Parameter(head.weight.detach().clone())
 w=head.weight.data.float();s=(w.abs().amax(1,keepdim=True)/127).clamp_min(1e-12);head.weight.data.copy_((torch.round(w/s).clamp(-127,127)*s).to(head.weight.dtype))
 del inps;gc.collect();torch.cuda.empty_cache()
 # ---- independent160 evaluation with deployed actual-BPU vision features ----
 r['status']='evaluating';save();fm=json.loads((FEAT160/'status.json').read_text());feats={e['image_id']:np.load(FEAT160/e['deployed']['feature_file'],allow_pickle=False) for e in fm['cases']};answers=[]
 with torch.inference_mode():
  for c in cases:
   pixels=torch.from_numpy(np.load(REF/c['pixels'],allow_pickle=False)).to('cuda:0',torch.bfloat16);ids=np.load(REF/c['ids'],allow_pickle=False);feat=torch.from_numpy(feats[c['image_id']]).to('cuda:0',torch.bfloat16)
   a=model.generate(pixel_values=pixels,input_ids=torch.from_numpy(ids[None]).to('cuda:0'),attention_mask=torch.ones((1,len(ids)),dtype=torch.int64,device='cuda:0'),visual_features=feat,image_grid_hws=None,tokenizer=processor.tokenizer,max_new_tokens=256,use_cache=True,generation_mode='slow',temperature=0.,do_sample=False,verbose=False)
   a=a[0] if isinstance(a,tuple) else a;answers.append(a);r['cases'].append(dict(index=c['index'],response=a,terminal='<|im_end|>' in a));save()
 r['scores']={str(t):score(answers,t) for t in [0.5,0.75,0.9]};r['terminal']=sum(x['terminal'] for x in r['cases']);r['status']='completed'
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:
 model=None;gc.collect();torch.cuda.empty_cache();r['finished']=time.time();save()
print(json.dumps({k:r.get(k) for k in ['status','calibration_sequences','calibration_tokens','scores','terminal','error']}))
