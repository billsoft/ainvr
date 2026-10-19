"""v298:actual BPU29vision features (deployed or qk16/sv16 candidate recipe) plus unchanged original BF16 language model.

Research-only component attribution using original generate(visual_features=...).
Its native post-projector interface is positively controlled on one regression
input and the used4K frame.73used cases then consume checksummed actualBPU features.
No deployment,GPU fallback,case tuning or independent final acceptance.
"""
import os,sys
os.environ['OPENBLAS_NUM_THREADS']='1';os.environ['OMP_NUM_THREADS']='2'
sys.path.insert(0,'/opt/locate-reference-deps')
from pathlib import Path
from collections import Counter
import json,hashlib,time,traceback,threading,signal,gc,shutil,ast,re,math
import numpy as np
import torch,transformers
VARIANT=sys.argv[1];assert VARIANT in ('deployed','candidate')
from transformers import AutoModel,AutoConfig,AutoProcessor
BASE=Path('/work/official-llm-v1');OUT=BASE/('actual-bpu-vision-recipe-native-text-v298-'+VARIANT);SOURCE=Path('/opt/locate-original-weights');REF=Path('/opt/locate-official-grouped-heldout-native-v1/status.json');LIVE=BASE/'official-native-live-oracle-v1/status.json';INPUT=BASE/'native-live-inputs-v2';HELPER=BASE/'validate_locateanything_official_heldout_bpu_v2.py';FEATURES=BASE/'vision-recipe-features-v297'
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
assert not OUT.exists() and os.getpid()==os.getpgrp()
assert sha(REF)=='c30d9baf8668d45b442168e71c3eeb98ce550f69ac16486413ba734f222b0690' and sha(LIVE)=='89114475989770112066553cca0a4438f80fc430365b20adcfb3eb49e2bebd6d'
assert sha(HELPER)=='616e0504988c3ff480922717f9c18a0538ce3395752d42f4bc554fdfd01cef1b'
assert sha(BASE/'vision-dtype-generation-v1/status.json')=='03fdbeb8f162c0117b370b263568f3c9a3371021880f6422ff03f848bc60204c'
fm=json.loads((FEATURES/'status.json').read_text());assert fm['status']=='completed' and fm['control_matches_v1'] is True and len(fm['cases'])==17
feature_manifest=dict(cases=[dict(image_id=c['image_id'],pixels_sha256=c['pixels_sha256'],feature_file=c[VARIANT]['feature_file'],feature_sha256=c[VARIANT]['feature_sha256']) for c in fm['cases']])
ref=json.loads(REF.read_text());live=json.loads(LIVE.read_text());assert len(ref['cases'])==72
OUT.mkdir();r=dict(status='checking',started=time.time(),pid=os.getpid(),start_ticks=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],source_sha256=sha(Path(__file__)),reference_sha256=sha(REF),live_reference_sha256=sha(LIVE),actual_bpu_feature_manifest_sha256=sha(FEATURES/'status.json'),variant=VARIANT,scope=__doc__,neural_provider='Original BF16 CUDA language-model research using previously captured actual BPU vision features',original_model_weights_modified=False,new_bpu_calls_in_this_process=0,actual_bpu_capture_calls_in_separate_proof=986,whole_model_bpu_verified=False,release_approved=False,independent_final=False,new_hbm_compiled=False,production_changed=False,modes={})
def save():
 p=OUT/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+'\n');p.replace(OUT/'status.json')
def check(initial=False):
 available=int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024;r['minimum_observed_vm_available_bytes']=min(r.get('minimum_observed_vm_available_bytes',available),available)
 assert available>(18 if initial else 12)*1024**3 and shutil.disk_usage('/work').free>22*1024**3
 assert torch.cuda.mem_get_info()[0]>(12 if initial else 4)*1024**3
signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(RuntimeError('Owned research attribution interrupted')));done=threading.Event();model=None;hooks=[]
def watch():
 while not done.wait(.5):
  try:check()
  except BaseException as e:
   (OUT/'resource-stop.json').write_text(json.dumps(dict(error=repr(e),time=time.time()))+'\n');os.kill(os.getpid(),signal.SIGTERM);return
save()
try:
 assert torch.cuda.is_available();check(True);threading.Thread(target=watch,daemon=True).start();torch.set_num_threads(2);torch.backends.cuda.matmul.allow_tf32=False;torch.backends.cudnn.allow_tf32=False
 tree=ast.parse(HELPER.read_text());wanted={'parse_response','iou','maximum_matches'};nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in wanted];assert {n.name for n in nodes}==wanted;funcs=dict(re=re);exec(compile(ast.Module(body=nodes,type_ignores=[]),str(HELPER),'exec'),funcs);parse,iou,match=[funcs[n] for n in ['parse_response','iou','maximum_matches']]
 features={}
 for e in feature_manifest['cases']:
  path=FEATURES/e['feature_file'];assert path.parent==FEATURES and sha(path)==e['feature_sha256'];value=np.load(path,allow_pickle=False)
  assert value.shape==(128,2048) and value.dtype==np.float32 and np.isfinite(value).all() and np.all((value.view(np.uint32)&65535)==0)
  features[e['image_id']]=dict(value=value,pixels_sha256=e['pixels_sha256'],feature_sha256=e['feature_sha256'])
 assert len(features)==17;prepared=[]
 for c in ref['cases']:
  arrays={}
  for k in ['pixels','grid','ids']:
   path=Path(c[k]);assert path.is_relative_to(REF.parent) and sha(path)==c[k+'_sha256'];arrays[k]=np.load(path,allow_pickle=False)
  assert features[str(c['image_id'])]['pixels_sha256']==c['pixels_sha256'];prepared.append((c,arrays,128))
 assert sha(INPUT/'pixel_values.npy')==live['prepared_pixels_sha256'] and sha(INPUT/'input_ids.npy')==live['input_ids_sha256'] and features['already_used_live4K']['pixels_sha256']==live['prepared_pixels_sha256']
 prepared.append((dict(index=72,image_id='already_used_live4K',query='person',kind='box',response=live['response']),dict(pixels=np.load(INPUT/'pixel_values.npy',allow_pickle=False),ids=np.load(INPUT/'input_ids.npy',allow_pickle=False),grid=np.array([[16,32]],np.int64)),256))
 for entry in ref['original_files']:
  path=SOURCE/entry['file'];assert path.stat().st_size==entry['bytes'] and sha(path)==entry['sha256']
 assert sha(SOURCE/'modeling_locateanything.py')=='cea0723d4195b80a318ebd9a1269d07ac1770ba9316983816bdc7a6b42832f51'
 r.update(status='loading_original',original_files=ref['original_files'],torch_version=torch.__version__,transformers_version=transformers.__version__);save()
 config=AutoConfig.from_pretrained(str(SOURCE),trust_remote_code=True);config._attn_implementation='sdpa';config.text_config._attn_implementation='sdpa';config.vision_config._attn_implementation='sdpa'
 model=AutoModel.from_pretrained(str(SOURCE),config=config,torch_dtype=torch.bfloat16,device_map={'':'cuda:0'},trust_remote_code=True,attn_implementation='sdpa').eval();processor=AutoProcessor.from_pretrained(str(SOURCE),trust_remote_code=True,use_fast=False)
 assert sum(p.numel() for p in model.parameters())==3517975280 and len(model.language_model.model.layers)==36 and len(model.vision_model.encoder.blocks)==27 and model.language_model.lm_head.out_features==152681
 assert all(p.dtype==torch.bfloat16 for p in model.parameters());assert model.language_model.model.embed_tokens.weight.data_ptr()==model.language_model.lm_head.weight.data_ptr()
 text_calls=Counter();vision_calls=Counter()
 for i,layer in enumerate(model.language_model.model.layers):hooks.append(layer.register_forward_pre_hook(lambda m,args,index=i:text_calls.update([index])))
 hooks.append(model.vision_model.register_forward_pre_hook(lambda m,args:vision_calls.update(['vision'])))
 hooks.append(model.mlp1.register_forward_pre_hook(lambda m,args:vision_calls.update(['connector'])))
 with torch.inference_mode():
  for mode in ['native_feature_interface_controls','actual_bpu_vision_native_text']:
   if mode=='actual_bpu_vision_native_text':assert r['modes']['native_feature_interface_controls']['all_controls_exact']
   r['status']='generating_'+mode;r['modes'][mode]=dict(cases=[]);records=r['modes'][mode]['cases'];save()
   selected=[prepared[0],prepared[-1]] if mode=='native_feature_interface_controls' else prepared
   for c,arrays,tokens in selected:
    check();pixels=torch.from_numpy(arrays['pixels']).to('cuda:0',torch.bfloat16)
    if mode=='native_feature_interface_controls':feat=model.mlp1(torch.cat(model.extract_feature(pixels,torch.from_numpy(arrays['grid']).to('cuda:0')),dim=0));feature_sha=None
    else:
     entry=features[str(c['image_id'])];feat=torch.from_numpy(entry['value']).to('cuda:0',torch.bfloat16);assert np.array_equal(feat.float().cpu().numpy(),entry['value']);feature_sha=entry['feature_sha256']
    assert feat.shape==(128,2048) and feat.dtype==torch.bfloat16;text_calls.clear();vision_calls.clear();begin=time.monotonic()
    answer=model.generate(pixel_values=pixels,input_ids=torch.from_numpy(arrays['ids'][None]).to('cuda:0'),attention_mask=torch.ones((1,len(arrays['ids'])),dtype=torch.int64,device='cuda:0'),visual_features=feat,image_grid_hws=None,tokenizer=processor.tokenizer,max_new_tokens=tokens,use_cache=True,generation_mode='slow',temperature=0.,do_sample=False,verbose=False)
    answer=answer[0] if isinstance(answer,tuple) else answer;assert set(text_calls)==set(range(36)) and len(set(text_calls.values()))==1 and min(text_calls.values())>0 and not vision_calls
    reference=parse(c['response']);candidate=parse(answer);pairs=match(reference['boxes'],candidate['boxes'],lambda x,y:iou(x,y)>=.9);points=match(reference['points'],candidate['points'],lambda x,y:math.hypot(x[0]-y[0],x[1]-y[1])<=10)
    record=dict(index=c['index'],image_id=c['image_id'],query=c['query'],kind=c['kind'],response=answer,exact_to_saved_reference=answer==c['response'],reference=reference,candidate=candidate,terminal='<|im_end|>' in answer,generated_tokens=len(processor.tokenizer.encode(answer,add_special_tokens=False)),matched_boxes=len(pairs),matched_points=len(points),maximum_new_tokens=tokens,feature_sha256=feature_sha,all36_native_decoder_layers_executed=True,each_text_layer_calls=next(iter(text_calls.values())),gpu_vision_or_connector_calls_during_generate=0,seconds=time.monotonic()-begin)
    records.append(record);save()
    if mode=='native_feature_interface_controls':assert record['exact_to_saved_reference'],'Native visual_features interface positive control failed'
   if mode=='native_feature_interface_controls':r['modes'][mode]['all_controls_exact']=True;save();continue
   boxes=[c for c in records if c['index']<72 and c['kind']=='box'];points=[c for c in records if c['index']<72 and c['kind']=='point'];matched=sum(c['matched_boxes'] for c in boxes);predicted=sum(len(c['candidate']['boxes']) for c in boxes);reference=sum(len(c['reference']['boxes']) for c in boxes);crowd=records[-1];assert len(boxes)==64 and len(points)==8 and crowd['index']==72
   r['modes'][mode].update(regression72_summary=dict(matched=matched,predicted=predicted,reference=reference,precision=matched/predicted if predicted else float(reference==0),recall=matched/reference if reference else float(predicted==0),iou_threshold=.9,point_matches=sum(c['matched_points'] for c in points),point_reference_count=sum(len(c['reference']['points']) for c in points),all_terminal_and_well_formed=all(c['terminal'] and not c['candidate']['malformed_blocks'] for c in records[:72]),geometry_type_contract_valid=all(not c['candidate']['points'] for c in boxes) and all(not c['candidate']['boxes'] for c in points)),live4k_diagnostic=dict(matched=crowd['matched_boxes'],predicted=len(crowd['candidate']['boxes']),reference=len(crowd['reference']['boxes']),precision=crowd['matched_boxes']/len(crowd['candidate']['boxes']) if crowd['candidate']['boxes'] else 0.,recall=crowd['matched_boxes']/len(crowd['reference']['boxes']),terminal=crowd['terminal'],generated_tokens=crowd['generated_tokens']));save()
 r.update(status='completed',native_feature_interface_positive_controls=2,actual_bpu_vision_attribution_cases=73,total_gpu_generation_requests=75,gpu_peak_allocated_bytes=torch.cuda.max_memory_allocated(),native_post_projector_feature_api_used_without_model_patch=True,limitations='Cached actualBPU features are used only for controlled attribution;not production end-to-end execution or performance.72regression plus used4K case,not new final set.')
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:
 done.set()
 for h in hooks:h.remove()
 model=None;gc.collect()
 if torch.cuda.is_available():torch.cuda.empty_cache()
 r['finished']=time.time();save()
print(json.dumps(dict(status=r['status'],modes={k:{n:v for n,v in v.items() if n!='cases'} for k,v in r['modes'].items()},gpu_peak_allocated_bytes=r.get('gpu_peak_allocated_bytes'))))
