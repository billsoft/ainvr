"""Original BF16 hybrid/MTP diagnostic on all existing frozen160 operations.

This changes generation mode for a NEW research comparison,not current BPU
outputs or its accepted exception. No quantization fitting,new unseen claim,
production CUDA fallback,HBM acceptance or GPU-to-BPU speed extrapolation.
"""
from pathlib import Path
import argparse,ast,gc,hashlib,json,math,os,re,shutil,signal,subprocess,sys,time,traceback
os.environ['OPENBLAS_NUM_THREADS']='1';os.environ['OMP_NUM_THREADS']='2'
STAGE=Path('/work/official-llm-v1');REF=STAGE/'independent-final-native-reference-v2-head-o2';SOURCE=Path('/opt/locate-original-weights');ASSETS=STAGE/'independent-final-reference-assets-v1';GUARD=STAGE/'native-hybrid-mode-v146-guard.json'
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def read(p):return json.loads(Path(p).read_text())
def ticks(pid):return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
def save(p,r):
 t=p.with_name('.'+p.name+'.incoming-v146');t.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');t.replace(p)
def location():
 dependency=STAGE/'compile_locateanything_w8_prefill_g9_v141.py';assert sha(dependency)=='8f3d82f5ed235f5e7377c4215a070a9559981c93ce4380d4ae6933dcba6a0fbc';sys.path.insert(0,str(STAGE));from compile_locateanything_w8_prefill_g9_v141 import storage
 holder,large,_=storage();return holder,large,large/'native-hybrid-mode-v146'
def admission():
 holder,large,out=location();assert sha(REF/'status.json')=='20ef947af737c09436e59a58ce89ef682143ffb3458633a698cef38e719e6821';old=read(REF/'status.json');assert old['status']=='completed' and len(old['cases'])==160 and old['native_prompt_contract_all160_exact'] and old['maximum_new_tokens']==256
 for e in old['original_files']:
  p=SOURCE/e['file'];assert p.stat().st_size==e['bytes'] and sha(p)==e['sha256']
 assert sha(ASSETS/'locateanything_prompt.py')=='d1adce4fa0c3bc55575b4a0505c050a96b4f633c59e2420497a3bb29b082f420' and sha(ASSETS/'tokenizer-original-v1.json')=='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40';parser=STAGE/'validate_locateanything_official_heldout_bpu_v2.py';assert sha(parser)=='616e0504988c3ff480922717f9c18a0538ce3395752d42f4bc554fdfd01cef1b';names={'parse_response','iou','maximum_matches'};nodes=[x for x in ast.parse(parser.read_text()).body if isinstance(x,ast.FunctionDef) and x.name in names];assert {x.name for x in nodes}==names;functions={'re':re};exec(compile(ast.Module(body=nodes,type_ignores=[]),str(parser),'exec'),functions)
 for index,e in enumerate(old['cases']):
  assert e['index']==index and e['kind'] in ['box','point']
  for k in ['pixels','grid','ids']:p=Path(e[k]);assert p.resolve().is_relative_to(REF.resolve()) and sha(p)==e[k+'_sha256']
 assert not out.exists();return old,functions,holder,large,out
def worker():
 assert os.getpid()==os.getpgrp();old,functions,holder,large,out=admission();out.mkdir();sys.path.insert(0,'/opt/locate-reference-deps');sys.path.insert(0,str(ASSETS));import numpy as np;import torch;from transformers import AutoConfig,AutoModel,AutoProcessor;from locateanything_prompt import LocateAnythingPrompt
 prompt=LocateAnythingPrompt(ASSETS/'tokenizer-original-v1.json','f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40');plan=[]
 for e in old['cases']:
  arrays={k:np.load(e[k],allow_pickle=False) for k in ['pixels','grid','ids']};assert arrays['pixels'].shape==(512,3,14,14) and arrays['pixels'].dtype==np.float32 and np.isfinite(arrays['pixels']).all() and arrays['grid'].tolist()==[[16,32]] and np.array_equal(arrays['ids'],prompt.encode(e['query'],256,'hybrid')) and len(arrays['ids'])+6<=256 and len(arrays['ids'])+261<=512
  plan.append({k:e[k] for k in ['index','image_id','query','kind','pixels','pixels_sha256','grid','grid_sha256','ids','ids_sha256']})
 freeze=dict(status='all160_native_hybrid_diagnostic_bound_before_generation',source_sha256=sha(__file__),old_native_slow_reference_sha256=sha(REF/'status.json'),original_files=old['original_files'],cases=plan,mode='hybrid',future_tokens=6,max_new_tokens=256,temperature=0,do_sample=False,original_parameters=3517975280,decoder_layers=36,vision_blocks=27,vocabulary=152681,no_old_failure_exception_applied=True,independent_final=False,BPU_verified=False,release_approved=False);save(out/'freeze.json',freeze)
 r=dict(status='checking_native_hybrid_resources',started=time.time(),pid=os.getpid(),start_ticks=ticks(os.getpid()),source_sha256=sha(__file__),freeze_sha256=sha(out/'freeze.json'),scope=__doc__,neural_provider='Original BF16 CUDA research reference only',BPU_neural_calls=0,BPU_verified=False,release_approved=False,independent_final=False,cases=[]);status=out/'status.json';model=None;hook=None;lengths=[];save(status,r)
 def phase(stage,**extra):save(out/'phase.json',dict(stage=stage,started_monotonic=time.monotonic(),**extra))
 def interrupt(*_):raise RuntimeError('Owned native-hybrid oracle interrupted or perrequest bound reached')
 signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGALRM,interrupt)
 try:
  assert torch.cuda.is_available() and torch.cuda.mem_get_info()[0]>12*1024**3;torch.set_num_threads(2);torch.backends.cuda.matmul.allow_tf32=False;torch.backends.cudnn.allow_tf32=False;config=AutoConfig.from_pretrained(str(SOURCE),trust_remote_code=True);config._attn_implementation='sdpa';config.text_config._attn_implementation='sdpa';config.vision_config._attn_implementation='sdpa';r['status']='loading_original_BF16_model';save(status,r);phase('loading_original_model')
  model=AutoModel.from_pretrained(str(SOURCE),config=config,torch_dtype=torch.bfloat16,device_map={'':'cuda:0'},trust_remote_code=True,attn_implementation='sdpa').eval();processor=AutoProcessor.from_pretrained(str(SOURCE),trust_remote_code=True,use_fast=False)
  assert sum(p.numel() for p in model.parameters())==3517975280 and len(model.language_model.model.layers)==36 and len(model.vision_model.encoder.blocks)==27 and model.language_model.lm_head.out_features==152681 and all(p.dtype==torch.bfloat16 for p in model.parameters()) and model.language_model.model.embed_tokens.weight.data_ptr()==model.language_model.lm_head.weight.data_ptr()
  def capture(module,args,kwargs):
   ids=kwargs.get('input_ids');embeds=kwargs.get('inputs_embeds');value=ids if ids is not None else embeds;assert value is not None and value.shape[0]==1;lengths.append(int(value.shape[1]))
  hook=model.language_model.register_forward_pre_hook(capture,with_kwargs=True);r['status']='generating_all160_original_hybrid';save(status,r)
  with torch.inference_mode():
   for e,slow in zip(plan,old['cases']):
    assert torch.cuda.mem_get_info()[0]>=4*1024**3,'Leave GPU headroom for unrelated work'
    lengths.clear();phase('generating',index=e['index']);signal.alarm(900);arrays={k:np.load(e[k],allow_pickle=False) for k in ['pixels','grid','ids']};ids=arrays['ids'];begin=time.monotonic();answer=model.generate(pixel_values=torch.from_numpy(arrays['pixels']).to('cuda:0',torch.bfloat16),input_ids=torch.from_numpy(ids[None]).to('cuda:0'),attention_mask=torch.ones((1,len(ids)),dtype=torch.int64,device='cuda:0'),image_grid_hws=torch.from_numpy(arrays['grid']).to('cuda:0'),tokenizer=processor.tokenizer,max_new_tokens=256,use_cache=True,generation_mode='hybrid',temperature=0.,do_sample=False,verbose=False);signal.alarm(0);assert isinstance(answer,str);parsed=functions['parse_response'](answer);terminal='<|im_end|>' in answer;typeok=not parsed['points'] if e['kind']=='box' else not parsed['boxes'];good=terminal and not parsed['malformed_blocks'] and typeok
    ref=functions['parse_response'](slow['response']);eligible=slow['terminal'] and not ref['malformed_blocks'] and (not ref['points'] if e['kind']=='box' else not ref['boxes']);matched=functions['maximum_matches'](parsed['boxes'],ref['boxes'],lambda a,b:functions['iou'](a,b)>=.9) if good and eligible and e['kind']=='box' else [];pm=functions['maximum_matches'](parsed['points'],ref['points'],lambda a,b:math.dist(a,b)<=10) if good and eligible and e['kind']=='point' else []
    assert lengths and lengths[0]==len(ids)+6 and all(1<=x<=12 for x in lengths[1:]);r['cases'].append(dict(e,response=answer,generated_ids=processor.tokenizer.encode(answer,add_special_tokens=False),seconds=time.monotonic()-begin,terminal=terminal,parsed=parsed,geometry_type_valid=bool(typeok),operationally_valid=bool(good),forward_rounds=len(lengths),forward_query_lengths=list(lengths),slow_one_token_AR_rounds_implied_by_original_token_count=len(slow['generated_ids']),slow_reference_eligible=bool(eligible),slow_reference=ref,matched_boxes=len(matched),matched_points=len(pm)));save(status,r)
  assert len(r['cases'])==160;box=[x for x in r['cases'] if x['kind']=='box' and x['slow_reference_eligible']];points=[x for x in r['cases'] if x['kind']=='point' and x['slow_reference_eligible']];matched=sum(x['matched_boxes'] for x in box);pred=sum(len(x['parsed']['boxes']) for x in box);gold=sum(len(x['slow_reference']['boxes']) for x in box);assert gold==219
  r.update(status='completed_all160_original_hybrid_diagnostic_not_BPU_acceptance',native_hybrid_vs_native_slow_agreement=dict(matched_boxes=matched,candidate_boxes=pred,reference_boxes=gold,precision=matched/pred if pred else 0.,recall=matched/gold,iou_threshold=.9,point_matches=sum(x['matched_points'] for x in points),point_reference_count=sum(len(x['slow_reference']['points']) for x in points),eligible_reference_cases=sum(x['slow_reference_eligible'] for x in r['cases'])),invalid_or_nonterminal_indices=[x['index'] for x in r['cases'] if not x['operationally_valid']],hybrid_forward_rounds=sum(x['forward_rounds'] for x in r['cases']),slow_forward_rounds_implied_by_original_one_token_AR=sum(x['slow_one_token_AR_rounds_implied_by_original_token_count'] for x in r['cases']),GPU_time_is_not_BPU_speed_proof=True,gpu_peak_allocated_bytes=torch.cuda.max_memory_allocated())
 except BaseException:r.update(status='failed_native_hybrid_diagnostic',error=traceback.format_exc());raise
 finally:
  signal.alarm(0)
  if hook is not None:hook.remove()
  model=None;gc.collect();torch.cuda.empty_cache();r['finished']=time.time();save(status,r);phase('released')
def guard(check):
 old,functions,holder,large,out=admission()
 if check:print(json.dumps(dict(status='admitted_native_hybrid_existing160_zero_neural_calls',original_reference_sha256=sha(REF/'status.json'),cases=len(old['cases']),original_modeling_source_sha256=sha(SOURCE/'modeling_locateanything.py'),output_directory=str(out))));return
 assert not GUARD.exists();cgroup=Path('/sys/fs/cgroup/memory');limit=int((cgroup/'memory.limit_in_bytes').read_text());assert limit==27917287424 and shutil.disk_usage(STAGE).free>7*1024**3 and shutil.disk_usage(large).free>12*1024**3
 r=dict(status='starting_owned_native_hybrid_oracle',started=time.time(),source_sha256=sha(__file__),pid=os.getpid(),start_ticks=ticks(os.getpid()),output_directory=str(out),scope=__doc__,overall_elapsed_cap_seconds=None,owned_group_rss_limit_bytes=12*1024**3,minimum_VM_available_bytes=12*1024**3,minimum_C_free_bytes=6*1024**3,minimum_D_free_bytes=12*1024**3,cgroup_safety_headroom_bytes=2*1024**3,other_compile_modified=False,maximum_group_rss_bytes=0);child=None;start=None
 def interrupted(*_):raise RuntimeError('Only native oracle guard interrupted;compile remains unchanged')
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted)
 try:
  with (STAGE/'native-hybrid-mode-v146-worker.log').open('xb') as f:child=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--worker'],stdin=subprocess.DEVNULL,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
  start=ticks(child.pid);r.update(status='watching_owned_original_hybrid_reference',worker_pid=child.pid,worker_start_ticks=start);save(GUARD,r);next_save=time.monotonic()+5
  while child.poll() is None:
   rss=0
   for p in Path('/proc').iterdir():
    if not p.name.isdigit():continue
    try:a=(p/'stat').read_text().rsplit(')',1)[1].split()
    except (FileNotFoundError,ProcessLookupError):continue
    if int(a[2])==child.pid and a[0] not in ['Z','X']:rss+=int(a[21])*os.sysconf('SC_PAGE_SIZE')
   available=int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024;usage=int((cgroup/'memory.usage_in_bytes').read_text());cfree=shutil.disk_usage(STAGE).free;dfree=shutil.disk_usage(large).free;r.update(checked=time.time(),group_rss_bytes=rss,maximum_group_rss_bytes=max(r['maximum_group_rss_bytes'],rss),VM_available_bytes=available,cgroup_usage_bytes=usage,C_free_bytes=cfree,D_free_bytes=dfree);assert rss<=r['owned_group_rss_limit_bytes'] and available>=r['minimum_VM_available_bytes'] and usage<=limit-r['cgroup_safety_headroom_bytes'] and cfree>=r['minimum_C_free_bytes'] and dfree>=r['minimum_D_free_bytes'],'Owned native oracle resource bound reached'
   phase=out/'phase.json'
   if phase.exists():
    ph=read(phase)
    if ph['stage']=='generating':assert time.monotonic()-ph['started_monotonic']<=910,'Perrequest CUDA generation bound reached'
   if time.monotonic()>=next_save:save(GUARD,r);next_save=time.monotonic()+5
   time.sleep(1)
  r['worker_returncode']=child.returncode;assert child.returncode==0;s=read(out/'status.json');assert s['status']=='completed_all160_original_hybrid_diagnostic_not_BPU_acceptance' and len(s['cases'])==160;r.update(status='completed_original_hybrid_diagnostic_not_BPU_qualification',raw_sha256=sha(out/'status.json'),native_hybrid_vs_native_slow_agreement=s['native_hybrid_vs_native_slow_agreement'],invalid_or_nonterminal_indices=s['invalid_or_nonterminal_indices'],hybrid_forward_rounds=s['hybrid_forward_rounds'],slow_forward_rounds_implied=s['slow_forward_rounds_implied_by_original_one_token_AR'])
 except BaseException:r.update(status='failed',error=traceback.format_exc())
 finally:
  if child is not None and child.poll() is None:
   assert ticks(child.pid)==start and os.getpgid(child.pid)==child.pid;os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=15)
   except subprocess.TimeoutExpired:assert ticks(child.pid)==start;os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
  r['finished']=time.time();save(GUARD,r)
 print(json.dumps({k:r.get(k) for k in ['status','native_hybrid_vs_native_slow_agreement','hybrid_forward_rounds','slow_forward_rounds_implied','invalid_or_nonterminal_indices','error']}));assert r['status']=='completed_original_hybrid_diagnostic_not_BPU_qualification'
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--worker',action='store_true');p.add_argument('--check-only',action='store_true');a=p.parse_args()
 if a.worker:worker()
 else:guard(a.check_only)
