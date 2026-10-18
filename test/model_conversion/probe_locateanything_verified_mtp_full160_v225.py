"""Full frozen160 target-verified MTP research after both prefill compilers exit.

Retain the original v164 proposal/causal verification code, not the v184
AR1-boundary variant. Inspect both strict token parity and the EXISTING box
IoU0.9 / point tolerance10 metrics. No threshold changes, new failure waiver,
new unseen-data claim, BPU speed claim, quantization, deployment or fallback.
All36Qwen/27MoonViT/full152681-vocab and original greedy0 prompt/EOS remain.
The original two dev token mismatches and v184 negative findings are retained.
Resource bounds unchanged; run only after the exact serial compile event.
Reference: https://huggingface.co/blog/assisted-generation
"""
from pathlib import Path
import argparse,ast,gc,hashlib,json,math,os,re,shutil,signal,subprocess,sys,time,traceback,fcntl
os.environ['OPENBLAS_NUM_THREADS']='1';os.environ['OMP_NUM_THREADS']='2'
STAGE=Path('/work/official-llm-v1');REF=STAGE/'independent-final-native-reference-v2-head-o2';SOURCE=Path('/opt/locate-original-weights');ASSETS=STAGE/'independent-final-reference-assets-v1';GUARD=STAGE/'verified-mtp-full160-v225-guard.json'
SELECTED=list(range(160))
CONTROL_SHA='ed29066642858c96d3ddcaa57b84831f203fd9f97bc84faa05688b98216ad6d6'
CONTROL_REPORT_SHA='04e6acea03dff4612a483c915b224249f12aa2b25412b36ebbf21a08f61ac676'

def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()

def read(p):return json.loads(Path(p).read_text())

def ticks(pid):return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]

def save(p,r):
 t=p.with_name('.'+p.name+'.incoming-v161');t.write_text(json.dumps(r,indent=2,allow_nan=False)+'\n');t.replace(p)

def location():
 dependency=STAGE/'compile_locateanything_w8_prefill_g9_v141.py';assert sha(dependency)=='8f3d82f5ed235f5e7377c4215a070a9559981c93ce4380d4ae6933dcba6a0fbc';sys.path.insert(0,str(STAGE));from compile_locateanything_w8_prefill_g9_v141 import storage
 holder,large,_=storage();return holder,large,large/'verified-mtp-full160-v225'

def admission():
 holder,large,out=location();assert sha(STAGE/'score_locateanything_independent_final_v2.py')=='69e88a0202aad9ee9ec45150607c885d44810cba2970c26dcd9be1cdaafc0093';assert sha(REF/'status.json')=='20ef947af737c09436e59a58ce89ef682143ffb3458633a698cef38e719e6821';old=read(REF/'status.json');assert old['status']=='completed' and len(old['cases'])==160 and old['native_prompt_contract_all160_exact'] and old['maximum_new_tokens']==256
 for e in old['original_files']:
  p=SOURCE/e['file'];assert p.stat().st_size==e['bytes'] and sha(p)==e['sha256']
 assert sha(ASSETS/'locateanything_prompt.py')=='d1adce4fa0c3bc55575b4a0505c050a96b4f633c59e2420497a3bb29b082f420' and sha(ASSETS/'tokenizer-original-v1.json')=='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40';parser=STAGE/'validate_locateanything_official_heldout_bpu_v2.py';assert sha(parser)=='616e0504988c3ff480922717f9c18a0538ce3395752d42f4bc554fdfd01cef1b';names={'parse_response','iou','maximum_matches'};nodes=[x for x in ast.parse(parser.read_text()).body if isinstance(x,ast.FunctionDef) and x.name in names];assert {x.name for x in nodes}==names;functions={'re':re};exec(compile(ast.Module(body=nodes,type_ignores=[]),str(parser),'exec'),functions)
 for index,e in enumerate(old['cases']):
  assert e['index']==index and e['kind'] in ['box','point']
  for k in ['pixels','grid','ids']:p=Path(e[k]);assert p.resolve().is_relative_to(REF.resolve()) and sha(p)==e[k+'_sha256']
 assert sha(STAGE/'locateanything_verified_mtp_control_v161.py')==CONTROL_SHA and sha(STAGE/'locateanything-verified-mtp-controls-v161.board-proof.json')==CONTROL_REPORT_SHA
 controls=read(STAGE/'locateanything-verified-mtp-controls-v161.board-proof.json');assert controls['control_sha256']==CONTROL_SHA and controls['positive_cases']==12 and controls['rejected_future_perturbations']==3 and controls['invalid_inputs_rejected']==2 and controls['neural_calls']==0
 assert not out.exists();return old,functions,holder,large,out

def score_existing_thresholds(reference,candidates,functions):
 assert len(reference['cases'])==len(candidates)==160 and [x['index'] for x in candidates]==list(range(160))
 from score_locateanything_independent_final_v2 import summarize
 refs=[];scored=[]
 for original,candidate in zip(reference['cases'],candidates):
  assert original['index']==candidate['index'] and candidate['target_matches_frozen_reference']
  parsed=functions['parse_response'](original['response']);terminal='<|im_end|>' in original['response'];kind=original['kind'];typeok=not parsed['points'] if kind=='box' else not parsed['boxes']
  ref={k:original[k] for k in ['index','image_id','query','kind']};ref.update(reference=parsed,response=original['response'],reference_terminal=terminal,reference_eligible=bool(terminal and not parsed['malformed_blocks'] and typeok));refs.append(ref)
  item={k:v for k,v in ref.items() if k!='response'};item.update(candidate=functions['parse_response'](candidate['candidate_response']),terminal=candidate['candidate_terminal'],rpc_ok=True,neural_cpu_fallback=False);scored.append(item)
 summary=summarize(scored,functions['parse_response'],functions['iou'],functions['maximum_matches'],{'cases':refs})
 failures=[x['index'] for x in scored if not x['terminal'] or x['candidate']['malformed_blocks'] or (x['candidate']['points'] if x['kind']=='box' else x['candidate']['boxes'])]
 return dict(existing_threshold_quality_summary=summary,operational_failure_indices=failures,candidate_failures_outside_existing_human_exception=[i for i in failures if i!=117],existing_human_exception_indices=[117],strict_token_gate_passed=all(x['all_token_IDs_equal'] for x in candidates),no_new_failure_exception_granted=True,full160_development_only=True)

def worker():
 assert os.getpid()==os.getpgrp();old,functions,holder,large,out=admission();out.mkdir();sys.path.insert(0,'/opt/locate-reference-deps');sys.path.insert(0,str(ASSETS));sys.path.insert(0,str(STAGE))
 from locateanything_verified_mtp_control_v161 import select_verified_prefix
 import numpy as np
 import torch
 import inspect
 from transformers import AutoConfig,AutoModel,AutoProcessor
 selected=[old['cases'][i] for i in SELECTED];assert [e['index'] for e in selected]==SELECTED
 freeze=dict(status='development_cases_frozen_before_verified_MTP',source_sha256=sha(__file__),control_sha256=CONTROL_SHA,reference_sha256=sha(REF/'status.json'),cases=selected,selection=SELECTED,target_mode='original slow greedy temperature0 repetition1.0',proposal='original masked six-position raw greedy,only after ref_end or box_end',acceptance='causal target verifies;discard after first mismatch;no nonEOS bonus',maximum_new_tokens=256,independent_final=False,BPU_verified=False,release_approved=False)
 save(out/'freeze.json',freeze);r=dict(status='loading_original_for_verified_mtp_development',started=time.time(),pid=os.getpid(),start_ticks=ticks(os.getpid()),source_sha256=sha(__file__),control_sha256=CONTROL_SHA,freeze_sha256=sha(out/'freeze.json'),scope=__doc__,cases=[],BPU_neural_calls=0,BPU_verified=False,release_approved=False,independent_final=False);status=out/'status.json';save(status,r);model=None
 def phase(stage,**extra):save(out/'phase.json',dict(stage=stage,started_monotonic=time.monotonic(),**extra))
 def interrupt(*_):raise RuntimeError('Owned verified-MTP research interrupted or perrequest bound reached')
 signal.signal(signal.SIGTERM,interrupt);signal.signal(signal.SIGALRM,interrupt)
 try:
  assert torch.cuda.is_available() and torch.cuda.mem_get_info()[0]>12*1024**3;torch.set_num_threads(2);torch.backends.cuda.matmul.allow_tf32=False;torch.backends.cudnn.allow_tf32=False
  config=AutoConfig.from_pretrained(str(SOURCE),trust_remote_code=True);config._attn_implementation='sdpa';config.text_config._attn_implementation='sdpa';config.vision_config._attn_implementation='sdpa'
  phase('loading_original_model');model=AutoModel.from_pretrained(str(SOURCE),config=config,torch_dtype=torch.bfloat16,device_map={'':'cuda:0'},trust_remote_code=True,attn_implementation='sdpa').eval();processor=AutoProcessor.from_pretrained(str(SOURCE),trust_remote_code=True,use_fast=False)
  assert sum(p.numel() for p in model.parameters())==3517975280 and len(model.language_model.model.layers)==36 and len(model.vision_model.encoder.blocks)==27 and model.language_model.lm_head.out_features==152681 and all(p.dtype==torch.bfloat16 for p in model.parameters()) and model.language_model.model.embed_tokens.weight.data_ptr()==model.language_model.lm_head.weight.data_ptr()
  namespace=inspect.unwrap(model.generate.__func__).__globals__;sampler=namespace['sample_tokens'];eos=int(model.token_ids['im_end_token_id']);mask=int(model.token_ids['default_mask_token_id']);box_start=int(model.token_ids['box_start_token_id']);boundaries={int(model.token_ids['ref_end_token_id']),int(model.token_ids['box_end_token_id'])}
  def choose(logits,history):
   assert logits.shape==(1,1,152681)
   probs,_,ids,_=sampler(logits,history,model.token_ids,generation_mode='slow',temperature=0.,do_sample=False)
   token=int(ids[0,0]);assert 0<=token<152681;return token
  def cut(cache,length):
   assert all(k.shape[2]>=length and v.shape[2]>=length for k,v in cache)
   return tuple((k[:,:,:length,:].contiguous(),v[:,:,:length,:].contiguous()) for k,v in cache)
  def getlen(cache):
   values={int(k.shape[2]) for k,v in cache}|{int(v.shape[2]) for k,v in cache};assert len(cache)==36 and len(values)==1;return values.pop()
  def forward(ids,past,positions,vit=None):
   kwargs=dict(input_ids=ids,past_key_values=past,position_ids=positions,use_cache=True,attention_mask=None)
   if vit is not None:kwargs.update(visual_features=vit,image_token_index=model.config.image_token_index)
   answer=model.language_model(**kwargs);return answer
  def verified_generate(ids,vit):
   generated=ids.clone();prefix=int(ids.shape[1]);maximum=prefix+256;stats=dict(prefill_calls=0,AR_calls=0,MTP_proposal_calls=0,causal_verification_calls=0,proposed_tokens=0,verified_candidate_tokens_accepted=0,first_candidate_rejections=0,query_lengths=[],rounds=[])
   answer=forward(generated,None,torch.arange(prefix,device='cuda:0').unsqueeze(0),vit);stats['prefill_calls']=1;stats['query_lengths'].append(prefix);first=choose(answer.logits[:,-1:,:],generated);cache=cut(answer.past_key_values,prefix);generated=torch.cat([generated,torch.tensor([[first]],device='cuda:0')],dim=1)
   while generated.shape[1]<maximum and int(generated[0,-1])!=eos:
    G=int(generated.shape[1]);assert getlen(cache)==G-1;remaining=maximum-G
    if int(generated[0,-1]) not in boundaries or remaining==1:
     answer=forward(generated[:,-1:],cache,torch.tensor([[G-1]],device='cuda:0'));stats['AR_calls']+=1;stats['query_lengths'].append(1);token=choose(answer.logits[:,-1:,:],generated);cache=cut(answer.past_key_values,G);generated=torch.cat([generated,torch.tensor([[token]],device='cuda:0')],dim=1);continue
    query=torch.cat([generated[:,-1:],generated[:,-1:],torch.full((1,5),mask,dtype=generated.dtype,device='cuda:0')],dim=1);positions=torch.arange(G-1,G+6,device='cuda:0').unsqueeze(0);positions[:,-6:]-=1
    answer=forward(query,cache,positions);stats['MTP_proposal_calls']+=1;stats['query_lengths'].append(7);first=choose(answer.logits[:,:1,:],generated);prefix_cache=cut(answer.past_key_values,G)
    # Proposals are advisory. Raw top1 avoids accepting hybrid's geometric
    # substitutions without causal target validation.
    draft=[choose(answer.logits[:,i:i+1,:],generated) for i in range(1,7)];draft=draft[:min(6,remaining)]
    if mask in draft:draft=draft[:draft.index(mask)]
    verification=None;cache_source=prefix_cache
    if draft and draft[0]==first and first==box_start and remaining>1:
     stats['proposed_tokens']+=len(draft);tokens=torch.tensor([draft],dtype=generated.dtype,device='cuda:0');verify=forward(tokens,prefix_cache,torch.arange(G,G+len(draft),device='cuda:0').unsqueeze(0));stats['causal_verification_calls']+=1;stats['query_lengths'].append(len(draft));verification=[choose(verify.logits[:,i:i+1,:],torch.cat([generated,tokens[:,:i+1]],dim=1)) for i in range(len(draft))];cache_source=verify.past_key_values
    else:
     if draft and draft[0]!=first:stats['first_candidate_rejections']+=1
     draft=[]
    accepted,keep=select_verified_prefix(draft,first,verification,eos,remaining)
    matched=0
    for predicted,actual in zip(draft,accepted):
     if predicted!=actual:break
     matched+=1
    stats['verified_candidate_tokens_accepted']+=matched
    stats['rounds'].append(dict(generated_before=G-prefix,first_target=first,proposal=draft,verified_next=verification,accepted=accepted,verified_KV_rows_kept=keep))
    cache=cut(cache_source,G+keep);generated=torch.cat([generated,torch.tensor([accepted],dtype=generated.dtype,device='cuda:0')],dim=1);assert getlen(cache)==int(generated.shape[1])-1
   result=generated[0,prefix:].tolist();stats['forward_calls']=sum(stats[k] for k in ['prefill_calls','AR_calls','MTP_proposal_calls','causal_verification_calls']);assert stats['forward_calls']==len(stats['query_lengths']);return result,stats
  r['status']='generating_development_verified_MTP';save(status,r)
  with torch.inference_mode():
   for entry in selected:
    assert torch.cuda.mem_get_info()[0]>=4*1024**3;phase('generating',index=entry['index']);signal.alarm(900);pixels=torch.from_numpy(np.load(entry['pixels'],allow_pickle=False)).to('cuda:0',torch.bfloat16);grid=torch.from_numpy(np.load(entry['grid'],allow_pickle=False)).to('cuda:0');ids=torch.from_numpy(np.load(entry['ids'],allow_pickle=False)[None]).to('cuda:0');assert ids.shape[1]+261<=512
    features=model.extract_feature(pixels,grid);vit=model.mlp1(torch.cat(features,dim=0));target_ids=[];target_queries=[]
    def observe_sampler(*args,**kwargs):
     answer=sampler(*args,**kwargs);assert answer[2].numel()==1;target_ids.append(int(answer[2].reshape(-1)[0]));return answer
    def observe_forward(module,args,kwargs):target_queries.append(int(kwargs['input_ids'].shape[1]))
    hook=model.language_model.register_forward_pre_hook(observe_forward,with_kwargs=True);namespace['sample_tokens']=observe_sampler
    try:baseline=model.generate(pixel_values=pixels,visual_features=features,input_ids=ids,attention_mask=torch.ones_like(ids),image_grid_hws=grid,tokenizer=processor.tokenizer,max_new_tokens=256,use_cache=True,generation_mode='slow',temperature=0.,do_sample=False,verbose=False)
    finally:namespace['sample_tokens']=sampler;hook.remove()
    proposal_ids,stats=verified_generate(ids,vit);signal.alarm(0);proposal_response=processor.tokenizer.decode(proposal_ids,skip_special_tokens=False);different=next((i for i,(a,b) in enumerate(zip(target_ids,proposal_ids)) if a!=b),min(len(target_ids),len(proposal_ids)) if len(target_ids)!=len(proposal_ids) else None)
    r['cases'].append(dict(index=entry['index'],kind=entry['kind'],query=entry['query'],target_response=baseline,target_ids=target_ids,target_forward_queries=target_queries,target_matches_frozen_reference=baseline==entry['response'],candidate_response=proposal_response,candidate_ids=proposal_ids,all_token_IDs_equal=proposal_ids==target_ids,first_different_token=different,original_target_terminal=eos in target_ids,candidate_terminal=eos in proposal_ids,statistics=stats));save(status,r)
   assert len(r['cases'])==len(SELECTED)
  r.update(status='completed_verified_MTP_development_not_BPU_qualification',parity_summary=dict(cases=len(SELECTED),all_token_IDs_equal=all(e['all_token_IDs_equal'] for e in r['cases']),all_baselines_equal_frozen_reference=all(e['target_matches_frozen_reference'] for e in r['cases']),different_case_indices=[e['index'] for e in r['cases'] if not e['all_token_IDs_equal']]),round_summary=dict(target_measured_calls=sum(len(e['target_forward_queries']) for e in r['cases']),candidate_measured_calls=sum(e['statistics']['forward_calls'] for e in r['cases']),accepted_candidates=sum(e['statistics']['verified_candidate_tokens_accepted'] for e in r['cases']),proposed_candidates=sum(e['statistics']['proposed_tokens'] for e in r['cases'])),GPU_calls_do_not_prove_BPU_speed=True)
  r.update(score_existing_thresholds(old,r['cases'],functions));save(status,r)
 except BaseException:r.update(status='failed_verified_MTP_development',error=traceback.format_exc());raise
 finally:
  signal.alarm(0);model=None;gc.collect();torch.cuda.empty_cache();r['finished']=time.time();save(status,r);phase('released')


def guard(check):
 old,functions,holder,large,out=admission()
 if check:print(json.dumps(dict(status='admitted_verified_mtp_development_inputs_zero_neural_calls',original_reference_sha256=sha(REF/'status.json'),cases=len(SELECTED),original_modeling_source_sha256=sha(SOURCE/'modeling_locateanything.py'),output_directory=str(out))));return
 lease=(STAGE/'native-mode-research-v156.lock').open('a');fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
 assert not GUARD.exists()
 assert sha(STAGE/'continue_locateanything_prefill_serial_v208.py')=='8fcff48e8bdd481252017af166531662061a56fc78cdad6248ff18f777d0c348'
 serial=read(STAGE/'prefill-serial-continuation-v208.json');assert serial['source_sha256']=='8fcff48e8bdd481252017af166531662061a56fc78cdad6248ff18f777d0c348' and serial['status']=='group18_packaged_group27_compiled_both_still_need_board_qualification' and serial['pid']==673254 and serial['start_ticks']=='20481896'
 cgpath=STAGE/'official-w8-prefill-g27-o2-v207-guard.json';assert sha(cgpath)==serial['group27_guard_sha256'];compile_guard=read(cgpath);assert compile_guard==serial['group27_guard'] and compile_guard['source_sha256']=='301245b78fb9714a769eea34f90c87d3c2fb4a9ebac1dd48ab38b87db1fc50d3' and compile_guard['status']=='completed_same_bc_prefill_g27_candidate_not_board_qualified' and compile_guard['worker_returncode']==0
 for pid,start in [(compile_guard['pid'],compile_guard['start_ticks']),(compile_guard['worker_pid'],compile_guard['worker_start_ticks'])]:
  oldproc=Path(f'/proc/{pid}/stat')
  if oldproc.exists():
   state=oldproc.read_text().rsplit(')',1)[1].split();assert state[19]!=start or state[0] in ['Z','X'],'Compile has not released its process resources'
 compile_lease=(STAGE/'locate-prefill-o2-compile.lock').open('a');fcntl.flock(compile_lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
 for p in Path('/proc').iterdir():
  if not p.name.isdigit() or int(p.name)==os.getpid():continue
  try:a=(p/'stat').read_text().rsplit(')',1)[1].split();args=(p/'cmdline').read_bytes().split(b'\0')
  except (FileNotFoundError,ProcessLookupError):continue
  assert not (a[0] not in ['Z','X'] and any(x.startswith((b'/work/official-llm-v1/compile_locateanything_',b'/work/official-llm-v1/link_locateanything_',b'/work/official-llm-v1/probe_locateanything_')) and x.endswith(b'.py') for x in args)),'Another owned compile/link/GPU probe is live'
 cgroup=Path('/sys/fs/cgroup/memory');limit=int((cgroup/'memory.limit_in_bytes').read_text());assert int((cgroup/'memory.usage_in_bytes').read_text())<=limit-6*1024**3,'Insufficient initial model-loading headroom';assert limit==27917287424 and shutil.disk_usage(STAGE).free>7*1024**3 and shutil.disk_usage(large).free>12*1024**3
 r=dict(status='starting_owned_verified_MTP_development',started=time.time(),source_sha256=sha(__file__),pid=os.getpid(),start_ticks=ticks(os.getpid()),output_directory=str(out),scope=__doc__,overall_elapsed_cap_seconds=None,owned_group_rss_limit_bytes=12*1024**3,minimum_VM_available_bytes=12*1024**3,minimum_C_free_bytes=6*1024**3,minimum_D_free_bytes=12*1024**3,cgroup_safety_headroom_bytes=2*1024**3,other_compile_modified=False,maximum_group_rss_bytes=0);child=None;start=None
 def interrupted(*_):raise RuntimeError('Only native oracle guard interrupted;compile remains unchanged')
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGHUP,interrupted)
 try:
  with (STAGE/'verified-mtp-full160-v225-worker.log').open('xb') as f:child=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--worker'],stdin=subprocess.DEVNULL,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
  start=ticks(child.pid);r.update(status='watching_owned_verified_MTP_development',worker_pid=child.pid,worker_start_ticks=start);save(GUARD,r);next_save=time.monotonic()+5
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
  r['worker_returncode']=child.returncode;assert child.returncode==0;s=read(out/'status.json');assert s['status']=='completed_verified_MTP_development_not_BPU_qualification' and len(s['cases'])==len(SELECTED);r.update(status='completed_verified_MTP_development_not_BPU_qualification',raw_sha256=sha(out/'status.json'),parity_summary=s['parity_summary'],round_summary=s['round_summary'])
 except BaseException:r.update(status='failed',error=traceback.format_exc())
 finally:
  if child is not None and child.poll() is None:
   assert ticks(child.pid)==start and os.getpgid(child.pid)==child.pid;os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=15)
   except subprocess.TimeoutExpired:assert ticks(child.pid)==start;os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
  r['finished']=time.time();save(GUARD,r);fcntl.flock(lease,fcntl.LOCK_UN);lease.close();fcntl.flock(compile_lease,fcntl.LOCK_UN);compile_lease.close()
 print(json.dumps({k:r.get(k) for k in ['status','parity_summary','round_summary','error']}));assert r['status']=='completed_verified_MTP_development_not_BPU_qualification'

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--worker',action='store_true');p.add_argument('--check-only',action='store_true');a=p.parse_args()
 if a.worker:worker()
 else:guard(a.check_only)
