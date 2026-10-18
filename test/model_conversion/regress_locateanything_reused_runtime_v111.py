"""All frozen160 current-W8 requests through the private reused-IO backend.

This is runtime equivalence, not a new unseen-set quantization experiment.
The previously accepted nonterminal117 remains failed, never a truncated success.
"""
from pathlib import Path
import argparse,hashlib,json,os,re,socket,struct,sys,time,traceback,statistics
import numpy as np
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';RUNTIME=ROOT/'ai-service/runtime';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
REF=BASE/'independent-final-native-reference-v2-head-o2'
BASELINE=BASE/'independent-final-bpu-ar2-pref0-head2-trial-v2/status.json'
BASELINE_SHA='8dfbecd5c9031e113c774cdd7478e80a2e9bef28ec92a073cfc0d3dd509665e8'
REF_SHA='8b16861bd8f5c78e050dfae3a41a18597ca887105fbac636469e8ffb2e8ef253'
CONTRACT=BASE/'official-full-family-w8a16-o2-all-ar-head-v1.json';CONTRACT_SHA='fd3e01f51bc36edaa62b3f5f45fc8507f03ae263ed53420fbc3df3cfb1fed042'
BACKEND=RUNTIME/'locateanything_bpu_reused_io_executor_v6.py';BACKEND_SHA='29db0fce3375d96aae69eb9a96ac8660d7be7242622c16d345f201ba767ee07b'
OUT=BASE/'runtime-reuse-frozen160-v111';BINDING=BASE/'runtime-reuse-frozen160-v111-binding.json'
SOCKET=ROOT/'data/ai/locate-runtime-regress-v111.sock'
TOKEN_SHA='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40'
def sha(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def save(path,value):
 tmp=path.with_name(path.name+'.incoming');tmp.write_text(json.dumps(value,indent=2,allow_nan=False)+'\n');tmp.replace(path)
def admission():
 assert sha(CONTRACT)==CONTRACT_SHA and sha(REF/'reference-index-v3.json')==REF_SHA and sha(BASELINE)==BASELINE_SHA
 assert sha(BACKEND)==BACKEND_SHA
 assert sha(CODE/'evaluate_locateanything_independent_final_v2.py')=='f676d759f87aae8e2eee3d2148d26791af96217b88380254aac5a36864bf8efb'
 sys.path.insert(0,str(CODE));sys.path.insert(0,str(RUNTIME))
 import evaluate_locateanything_independent_final_v2 as legacy
 legacy.REF_SHA=REF_SHA
 artifacts=legacy.check_contract(CONTRACT,CONTRACT_SHA)
 reference=json.loads((REF/'reference-index-v3.json').read_text());baseline=json.loads(BASELINE.read_text())
 assert baseline['status']=='completed_all160_candidate_operations' and baseline['contract_sha256']==CONTRACT_SHA and baseline['reference_index_sha256']==REF_SHA
 assert len(baseline['cases'])==len(reference['cases'])==160
 assert [x['index'] for x in baseline['cases']]==reference['required_candidate_indices']==list(range(160))
 assert all(x['rpc_ok'] and x['answer']['ok'] and not x['neural_cpu_fallback'] for x in baseline['cases'])
 assert [x['index'] for x in baseline['cases'] if not x['terminal']]==[117]
 approval=ROOT/'test/results/locateanything-w8-trial-human-acceptance-v1.json'
 assert sha(approval)=='8fbb0e7c141a4d254231d03addbafbd9a6302a024252bd8ca208bf483c344622'
 accepted=json.loads(approval.read_text());assert accepted['accepted_failed_indices']==[117] and accepted['contract_sha256']==CONTRACT_SHA and accepted['formal_quality_approved'] is False
 for old,native in zip(baseline['cases'],reference['cases']):
  assert all(old[k]==native[k] for k in ['index','image_id','query','kind','reference','reference_eligible','reference_terminal'])
  for key in ['pixels','grid','ids']:
   path=(REF/native[key]).resolve();assert path.is_relative_to(REF.resolve()) and sha(path)==native[key+'_sha256']
 return reference,baseline,artifacts,legacy.parser_functions()
def binding():
 reference,baseline,artifacts,parser=admission()
 data=dict(status='all160_runtime_regression_bound_before_generation',contract_sha256=CONTRACT_SHA,reference_index_sha256=REF_SHA,baseline_bpu_sha256=BASELINE_SHA,
           evaluator_sha256=sha(__file__),backend_sha256=BACKEND_SHA,artifacts=artifacts,
           original_human_exception_sha256='8fbb0e7c141a4d254231d03addbafbd9a6302a024252bd8ca208bf483c344622',
           reused_module_sha256='fc69ef48c28cbc43952b426848846e381f5c46de9059cc50d778a7c2351f106e',
           generator_changed=False,weights_changed=False,recalibration_executed=False,release_approved=False)
 return data,reference,baseline,parser
def receive(sock,size):
 blocks=[]
 while size:
  block=sock.recv(size)
  if not block:raise ConnectionError('Incomplete private backend response')
  blocks.append(block);size-=len(block)
 return b''.join(blocks)
def rpc(header,payload=b''):
 header.update(schema_version=1,contract_sha256=CONTRACT_SHA,input_bytes=len(payload));raw=json.dumps(header).encode();start=time.monotonic()
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
  s.settimeout(960);s.connect(str(SOCKET));s.sendall(struct.pack('!I',len(raw))+raw+payload)
  size=struct.unpack('!I',receive(s,4))[0];assert 0<size<=8*1024**2;answer=json.loads(receive(s,size))
 return answer,time.monotonic()-start
def main():
 p=argparse.ArgumentParser();p.add_argument('--bind-only',action='store_true');p.add_argument('--check-only',action='store_true');p.add_argument('--binding-sha');a=p.parse_args()
 expected,reference,baseline,func=binding()
 if a.bind_only:
  assert os.getuid()==0 and not BINDING.exists() and not OUT.exists();save(BINDING,expected);os.chown(BINDING,1000,1000)
  print(json.dumps(dict(status=expected['status'],binding_sha256=sha(BINDING),neural_calls=0)));return
 assert a.binding_sha and re.fullmatch('[0-9a-f]{64}',a.binding_sha) and sha(BINDING)==a.binding_sha and json.loads(BINDING.read_text())==expected
 if a.check_only:
  assert not OUT.exists();print(json.dumps(dict(status='all160_runtime_regression_admission_passed',required_cases=160,accepted_failed_indices=[117],neural_calls=0)));return
 assert os.getuid()==1000 and OUT.is_dir() and OUT.stat().st_uid==1000 and not (OUT/'status.json').exists()
 from locateanything_prompt import LocateAnythingPrompt,patchify_prepared_chw
 from score_locateanything_independent_final_v2 import summarize
 prompt=LocateAnythingPrompt(BASE/'tokenizer-original-v1.json',TOKEN_SHA)
 r=dict(status='running_all160_runtime_equivalence',scope=__doc__,started=time.time(),source_sha256=sha(__file__),binding_sha256=a.binding_sha,
        baseline_bpu_sha256=BASELINE_SHA,contract_sha256=CONTRACT_SHA,reference_index_sha256=REF_SHA,
        cases=[],neural_calls=0,mismatch_indices=[],release_approved=False,overall_elapsed_cap_seconds=None)
 status=OUT/'status.json';save(status,r)
 try:
  health,_=rpc(dict(operation='health'));assert health['ok'] and health['ready'] and health['runtime_io_policy']=='persistent_static_io_v1' and health['component_count']==76 and health['physical_hbm_files']==46
  for native,old in zip(reference['cases'],baseline['cases']):
   index=native['index'];r['current_index']=index;save(status,r)
   arrays={k:np.load(REF/native[k],allow_pickle=False) for k in ['pixels','grid','ids']}
   assert np.array_equal(prompt.encode(native['query'],256,'slow'),arrays['ids']) and arrays['grid'].tolist()==[[16,32]]
   pixels=arrays['pixels'];assert pixels.shape==(512,3,14,14) and pixels.dtype==np.float32 and np.isfinite(pixels).all()
   chw=np.ascontiguousarray(pixels.reshape(16,32,3,14,14).transpose(2,0,3,1,4).reshape(3,224,448));assert patchify_prepared_chw(chw).tobytes()==pixels.tobytes()
   answer,seconds=rpc(dict(operation='generate',description=native['query'],tokens=256,input_shape=[3,224,448],pixel_format='rgb-chw-f32le'),chw.astype('<f4',copy=False).tobytes())
   item={k:native[k] for k in ['index','image_id','query','kind','reference','reference_eligible','reference_terminal']}
   item.update(rpc_ok=answer.get('ok') is True,terminal=answer.get('terminal') is True,neural_cpu_fallback=answer.get('neural_cpu_fallback',True),candidate=func['parse_response'](answer['response']) if answer.get('ok') else None,rpc_seconds=seconds,answer=answer)
   differences=[]
   if not answer.get('ok'):differences.append('rpc_ok')
   else:
    assert answer['runtime_io_policy']=='persistent_static_io_v1' and not answer['neural_cpu_fallback']
    assert answer['models_retained_for_next_request'] and not answer['generation_state_retained'] and not answer['image_features_retained']
    assert answer['executor_stats']['loads']==answer['executor_stats']['evictions']==answer['model_loads']==0
    for k in ['generated_ids','response','token_logprobs','terminal','stopped_at_token_limit','generation_mode','neural_cpu_fallback','limits','bpu_calls','model_loads']:
     if answer[k]!=old['answer'][k]:differences.append(k)
    steps=lambda x:[{k:v for k,v in step.items() if k!='seconds'} for step in x['steps']]
    if steps(answer)!=steps(old['answer']):differences.append('step_semantics')
    if item['candidate']!=old['candidate']:differences.append('parsed_json_semantics')
    duration=sum(s['seconds'] for s in answer['steps'][1:]);item['native_decode_tokens_per_second']=(len(answer['generated_ids'])-1)/duration if duration>0 else None
    r['neural_calls']+=answer['bpu_calls']
   item['runtime_equivalent']=not differences;item['different_fields']=differences
   if differences:r['mismatch_indices'].append(index)
   r['cases'].append(item);r['summary']=summarize(r['cases'],func['parse_response'],func['iou'],func['maximum_matches'],reference);save(status,r)
   health,_=rpc(dict(operation='health'));assert health['ok'] and health['ready'] and not health['busy'] and health['persistent_worker']['failed_requests']==0
  assert [c['index'] for c in r['cases']]==list(range(160))
  r['summary_exactly_equal_baseline']=r['summary']==baseline['summary']
  r['retained_failed_indices']=[c['index'] for c in r['cases'] if not c['terminal']]
  r['runtime_equivalence_passed']=not r['mismatch_indices'] and r['summary_exactly_equal_baseline'] and r['retained_failed_indices']==[117]
  r['all160_operations_executed']=True;r['status']='completed_all160_runtime_regression'
  r['median_native_decode_tps']=statistics.median(x['native_decode_tokens_per_second'] for x in r['cases'] if x.get('native_decode_tokens_per_second') is not None)
  r['speed_comparison_note']='The saved160 baseline had different concurrent production load;use controlled full-image v110 A/B for causal runtime speed gain.'
 except BaseException:r.update(status='failed_incomplete_runtime_regression',error=traceback.format_exc());raise
 finally:r['finished']=time.time();save(status,r)
 print(json.dumps({k:r.get(k) for k in ['status','neural_calls','runtime_equivalence_passed','mismatch_indices','retained_failed_indices','median_native_decode_tps','error']}))
 assert r['runtime_equivalence_passed']
if __name__=='__main__':main()
