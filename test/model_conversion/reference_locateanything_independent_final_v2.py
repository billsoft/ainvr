"""Original BF16 reference for frozen32image160case final trial evaluation.

Recipe and all cases are frozen before reference generation. No candidate model,
case reselection,quantization fitting or candidate final inference is executed.
Pillow preprocessing is an explicitly labelled reference oracle only.
"""
import os,sys,ast
os.environ['OPENBLAS_NUM_THREADS']='1';os.environ['OMP_NUM_THREADS']='2'
sys.path.insert(0,'/opt/locate-reference-deps')
from pathlib import Path
import json,hashlib,time,signal,threading,traceback,gc,shutil,re
import numpy as np
import torch,transformers,PIL
from PIL import Image
from transformers import AutoModel,AutoConfig,AutoProcessor
BASE=Path('/work/official-llm-v1');IMAGES=BASE/'independent-final-images-v2-head-o2';ASSETS=BASE/'independent-final-reference-assets-v1';OUT=BASE/'independent-final-native-reference-v2-head-o2';SOURCE=Path('/opt/locate-original-weights');FREEZE=BASE/'locateanything-w8a16-ar2-pref0-head2-trial-v2-freeze.json'
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
parser_path=BASE/'validate_locateanything_official_heldout_bpu_v2.py';assert sha(parser_path)=='616e0504988c3ff480922717f9c18a0538ce3395752d42f4bc554fdfd01cef1b'
parser_node=next(n for n in ast.parse(parser_path.read_text()).body if isinstance(n,ast.FunctionDef) and n.name=='parse_response');parser_scope={'re':re};exec(compile(ast.Module(body=[parser_node],type_ignores=[]),str(parser_path),'exec'),parser_scope);parse_response=parser_scope['parse_response']
assert os.getpid()==os.getpgrp() and not OUT.exists()
assert sha(FREEZE)=='36a738d86f0a2f082d877544f14399f725b52fe585d1f87f79b7769cd1e1d2fb'
assert sha(IMAGES/'manifest.json')=='95c72fe2a8283bd0818a5263635c9f5a9a2d9e5062370155ea1c0aea52db7599'
assert sha(ASSETS/'locateanything_prompt.py')=='d1adce4fa0c3bc55575b4a0505c050a96b4f633c59e2420497a3bb29b082f420' and sha(ASSETS/'tokenizer-original-v1.json')=='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40'
sys.path.insert(0,str(ASSETS));from locateanything_prompt import LocateAnythingPrompt
prompt_contract=LocateAnythingPrompt(ASSETS/'tokenizer-original-v1.json','f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40')
m=json.loads((IMAGES/'manifest.json').read_text());frozen=json.loads(FREEZE.read_text());assert len(m['entries'])==32 and len({e['image_id'] for e in m['entries']})==32 and not {e['image_id'] for e in m['entries']} & set(m['excluded_ids'])
assert m['box_queries']==['person','car','bicycle','dog'] and m['free_box_queries']==['person on the left','a vehicle'] and m['point_queries']==['Point to: person.','Point to: the most prominent object.']
assert m['additional_query_image_indices']==[0,4,8,12,16,20,24,28] and m['generation_mode']=='slow' and m['maximum_new_tokens']==256
assert frozen['trial_version']=='official-w8a16-ar2-pref0-head2-trial-v2' and frozen['final_dataset']['sha256']==sha(IMAGES/'manifest.json') and not frozen['release_approved']
OUT.mkdir();r=dict(status='checking',started=time.time(),pid=os.getpid(),start_ticks=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],source_sha256=sha(Path(__file__)),trial_recipe_freeze_sha256=sha(FREEZE),selection_sha256=sha(IMAGES/'manifest.json'),scope=__doc__,independent_final_reference=True,candidate_tuning_forbidden=True,candidate_evaluation_executed=False,whole_model_bpu_verified=False,release_approved=False,neural_provider='CUDA original BF16 reference only',maximum_new_tokens=256,hard_elapsed_limit_seconds=None,cases=[])
def save():
 p=OUT/'status.json.tmp';p.write_text(json.dumps(r,indent=2)+'\n');p.replace(OUT/'status.json')
def check(initial=False):
 available=int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024;r['minimum_observed_vm_available_bytes']=min(r.get('minimum_observed_vm_available_bytes',available),available)
 assert available>(18 if initial else 12)*1024**3 and shutil.disk_usage('/work').free>22*1024**3
 assert torch.cuda.mem_get_info()[0]>(12 if initial else 4)*1024**3
signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(RuntimeError('Owned final native reference interrupted')))
done=threading.Event();model=None
def watch():
 while not done.wait(.5):
  try:check()
  except BaseException as e:
   (OUT/'resource-stop.json').write_text(json.dumps(dict(error=repr(e),time=time.time()))+'\n');os.kill(os.getpid(),signal.SIGTERM);return
save()
try:
 assert torch.cuda.is_available();check(True);threading.Thread(target=watch,daemon=True).start();torch.set_num_threads(2);torch.backends.cuda.matmul.allow_tf32=False;torch.backends.cudnn.allow_tf32=False
 known=Path('/opt/locate-official-grouped-heldout-native-v1/status.json');assert sha(known)=='c30d9baf8668d45b442168e71c3eeb98ce550f69ac16486413ba734f222b0690';original=json.loads(known.read_text())
 for e in original['original_files']:
  p=SOURCE/e['file'];assert p.stat().st_size==e['bytes'] and sha(p)==e['sha256']
 for e in m['entries']:assert sha(IMAGES/e['file'])==e['sha256']
 r.update(original_files=original['original_files'],torch_version=torch.__version__,transformers_version=transformers.__version__,pillow_version=PIL.__version__,status='preparing_exact_native_inputs');save()
 processor=AutoProcessor.from_pretrained(str(SOURCE),trust_remote_code=True,use_fast=False);plan=[];prepared_refs=[]
 for image_index,e in enumerate(m['entries']):
  check();opened=Image.open(IMAGES/e['file']);source_size=opened.size;image=opened.convert('RGB').resize((448,224),Image.Resampling.BICUBIC);directory=OUT/str(e['image_id']);directory.mkdir()
  queries=[('box',q) for q in m['box_queries']]
  if image_index in m['additional_query_image_indices']:queries += [('box',q) for q in m['free_box_queries']]+[('point',q) for q in m['point_queries']]
  first_pixels=first_grid=None
  for kind,query in queries:
   messages=[dict(role='user',content=[dict(type='image',image=image),dict(type='text',text=query)])];text=processor.py_apply_chat_template(messages,tokenize=False,add_generation_prompt=True);images,videos=processor.process_vision_info(messages);prepared=processor(text=[text],images=images,videos=videos,return_tensors='pt')
   pixels=prepared['pixel_values'].float().numpy();grid=np.asarray(prepared['image_grid_hws']);ids=prepared['input_ids'].numpy()[0]
   assert pixels.shape==(512,3,14,14) and pixels.dtype==np.float32 and np.isfinite(pixels).all() and grid.tolist()==[[16,32]]
   assert np.array_equal(ids,prompt_contract.encode(query,256,'slow')) and len(ids)+256<=512
   if first_pixels is None:
    first_pixels=pixels.copy();first_grid=grid.copy();np.save(directory/'pixels.npy',pixels,allow_pickle=False);np.save(directory/'grid.npy',grid,allow_pickle=False)
   else:assert pixels.tobytes()==first_pixels.tobytes() and grid.tobytes()==first_grid.tobytes()
   index=len(plan);idfile=directory/f'ids-{index:03d}.npy';np.save(idfile,ids,allow_pickle=False)
   plan.append(dict(index=index,image_id=e['image_id'],query=query,kind=kind,source_sha256=e['sha256'],source_size=list(source_size),pixels=str(directory/'pixels.npy'),pixels_sha256=sha(directory/'pixels.npy'),grid=str(directory/'grid.npy'),grid_sha256=sha(directory/'grid.npy'),ids=str(idfile),ids_sha256=sha(idfile),prompt_tokens=len(ids)))
 assert len(plan)==160 and sum(c['kind']=='box' for c in plan)==144 and sum(c['kind']=='point' for c in plan)==16
 path=OUT/'case-plan.json';path.write_text(json.dumps(dict(status='all160_cases_fixed_and_prepared_before_any_native_generation',trial_recipe_freeze_sha256=sha(FREEZE),selection_sha256=sha(IMAGES/'manifest.json'),cases=plan),indent=2)+'\n');r.update(case_plan_sha256=sha(path),native_prompt_contract_all160_exact=True,status='loading_original_model');save()
 config=AutoConfig.from_pretrained(str(SOURCE),trust_remote_code=True);config._attn_implementation='sdpa';config.text_config._attn_implementation='sdpa';config.vision_config._attn_implementation='sdpa'
 model=AutoModel.from_pretrained(str(SOURCE),config=config,torch_dtype=torch.bfloat16,device_map={'':'cuda:0'},trust_remote_code=True,attn_implementation='sdpa').eval()
 assert sum(p.numel() for p in model.parameters())==3517975280 and len(model.language_model.model.layers)==36 and len(model.vision_model.encoder.blocks)==27 and model.language_model.lm_head.out_features==152681
 assert all(p.dtype==torch.bfloat16 for p in model.parameters()) and model.language_model.model.embed_tokens.weight.data_ptr()==model.language_model.lm_head.weight.data_ptr()
 r.update(status='generating_original_reference',original_parameters=3517975280,vision_blocks=27,decoder_layers=36,original_weights_modified=False);save()
 with torch.inference_mode():
  for entry in plan:
   check();pixels=np.load(entry['pixels'],allow_pickle=False);grid=np.load(entry['grid'],allow_pickle=False);ids=np.load(entry['ids'],allow_pickle=False);begin=time.monotonic()
   answer=model.generate(pixel_values=torch.from_numpy(pixels).to('cuda:0',torch.bfloat16),input_ids=torch.from_numpy(ids[None]).to('cuda:0'),attention_mask=torch.ones((1,len(ids)),dtype=torch.int64,device='cuda:0'),image_grid_hws=torch.from_numpy(grid).to('cuda:0'),tokenizer=processor.tokenizer,max_new_tokens=256,use_cache=True,generation_mode='slow',temperature=0.,do_sample=False,verbose=False)
   answer=answer[0] if isinstance(answer,tuple) else answer;coordinates=[list(map(int,re.findall(r'<(\d+)>',part))) for part in re.findall(r'<box>(.*?)</box>',answer)];parsed=parse_response(answer);invalid=parsed['malformed_blocks'];geometry_type_valid=not parsed['points'] if entry['kind']=='box' else not parsed['boxes']
   r['cases'].append(dict(entry,status='completed',response=answer,generated_ids=processor.tokenizer.encode(answer,add_special_tokens=False),raw_coordinates=coordinates,invalid_coordinates=invalid,coordinate_contract_valid=not invalid and geometry_type_valid,geometry_type_contract_valid=geometry_type_valid,parsed_response=parsed,terminal='<|im_end|>' in answer,seconds=time.monotonic()-begin,boxes=parsed['boxes'],points=parsed['points'],explicit_empty_boxes=parsed['explicit_empty_boxes']));save()
 assert len(r['cases'])==160;r.update(status='completed',box_cases=144,point_cases=16,all_terminal=all(c['terminal'] for c in r['cases']),invalid_coordinate_cases=sum(not c['coordinate_contract_valid'] for c in r['cases']),gpu_peak_allocated_bytes=torch.cuda.max_memory_allocated())
except BaseException:r.update(status='failed',error=traceback.format_exc());raise
finally:
 done.set();model=None;gc.collect()
 if torch.cuda.is_available():torch.cuda.empty_cache()
 r['finished']=time.time();save()
print(json.dumps({k:r.get(k) for k in ['status','box_cases','point_cases','all_terminal','invalid_coordinate_cases','gpu_peak_allocated_bytes']}))
