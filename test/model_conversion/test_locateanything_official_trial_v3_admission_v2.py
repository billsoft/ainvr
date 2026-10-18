"""Actual native receipt positive control plus semantic mutations; never install or call neural model."""
from pathlib import Path
import ast,copy,hashlib,importlib.util,json,time
R=Path('/home/sunrise/ainvr');T=R/'test/results';path=R/'deploy-package/install-locateanything-official-family-s100p-v3.py'
spec=importlib.util.spec_from_file_location('trial_v3',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
guard=T/'official-native-sei-archive-v3.json';client=T/'official-native-sei-archive-v3/client.json';raw=m.BASE/'official-native-sei-archive-v3/hardware-history/summary.json'
# This first control uses real files,digests,and all recorded traces.
memory,native=m.require_actual_sei_archive(guard);assert memory==6244925440 and native['records_verified']==12
original_read=m.read;original_digest=m.digest;mutated={};cache={}
def read(p):
 p=Path(p)
 if p in mutated:return copy.deepcopy(mutated[p])
 if p not in cache:cache[p]=original_read(p)
 return copy.deepcopy(cache[p])
m.read=read
# Preserve actual identity pins in these isolated controls to reach deeper
# semantic checks. No file is mutated and no identity bypass is installed.
checks=[]
def reject(name,p,change):
 mutated.clear();v=original_read(p);change(v);mutated[p]=v
 # Keep duplicate receipt views coherent so each mutation reaches its semantic
 # rule rather than being rejected only by the earlier cross-file equality.
 if p==raw:
  c=original_read(client);c['native']=copy.deepcopy(v);mutated[client]=c
  g=original_read(guard);g['client']=copy.deepcopy(c);mutated[guard]=g
 elif p==client:
  g=original_read(guard);g['client']=copy.deepcopy(v);mutated[guard]=g

 try:m.require_actual_sei_archive(guard)
 except (ValueError,KeyError,TypeError,IndexError):checks.append(name);return
 raise AssertionError('Malformed native evidence admitted: '+name)
for key in ['actual_failed_load_released','actual_duplicate_load_rejected','actual_worker_stop_released']:
 reject('lease_'+key,raw,lambda j,k=key:j['channel_lease'].__setitem__(k,False))
reject('extra_generate_request',raw,lambda j:j['channel_lease'].__setitem__('extra_generate_requests',1))
reject('lease_proof_missing',raw,lambda j:j.pop('channel_lease'))
reject('source_identity_changed',guard,lambda j:j.__setitem__('model_adapter_sha256','0'*64))
reject('memory_over_limit',guard,lambda j:j.__setitem__('native_plus_backend_sampled_memory_bytes_maximum',10400000001))
reject('ion_not_released',guard,lambda j:j['owned_ion_after_exit'].__setitem__('carveout',1))
reject('production_not_fresh',guard,lambda j:j.__setitem__('production_unchanged_and_fresh',False))
reject('unapproved_quality_override',guard,lambda j:j.__setitem__('quality_override_accepted',True))
reject('sei_timestamp_shift',raw,lambda j:j['actual_sei_readback'][0].__setitem__('timestamp_offset_ns',1))
reject('point_record_missing',raw,lambda j:j['sample_records']['items'].pop())
reject('point_coordinate_changed',raw,lambda j:j['sample_records']['items'][0]['point'].__setitem__('x',0.0))
reject('point_bbox_fabricated',raw,lambda j:j['sample_records']['items'][0].__setitem__('bbox',{'x':0,'y':0,'w':1,'h':1}))
reject('archive_not_drained',raw,lambda j:j['archive_stats']['delivery'].__setitem__('outstanding',1))
reject('cpu_jpeg',raw,lambda j:j.__setitem__('jpeg_cpu',1))
reject('cpu_neural',raw,lambda j:j.__setitem__('cpu_neural_fallback',True))
reject('readback_observer_injected',raw,lambda j:j.__setitem__('metadata_injected_by_observer',True))
reject('video_reencoded',raw,lambda j:j.__setitem__('video_reencoded',True))
reject('contexts_missing',client,lambda j:j.__setitem__('retained_contexts',45))
mutated.clear();m.read=original_read
old=ast.parse((R/'deploy-package/install-locateanything-official-family-s100p-v2.py').read_text());new=ast.parse(path.read_text());oldmap={n.name:n for n in old.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))};newmap={n.name:n for n in new.body if isinstance(n,(ast.FunctionDef,ast.ClassDef))};names=[];transaction=False
for n in old.body:
 if isinstance(n,(ast.FunctionDef,ast.ClassDef)):
  if n.name=='state':transaction=True
  if n.name=='main':break
  if transaction:
   assert ast.dump(n,include_attributes=False)==ast.dump(newmap[n.name],include_attributes=False),n.name
   names.append(n.name)
out=dict(status='passed',created=time.time(),source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),installer_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),actual_native_receipt_positive_controls=1,semantic_negative_controls=len(checks),mirrored_receipts_kept_coherent_in_controls=True,negative_cases=checks,transaction_ast_unchanged_from_v2=names,actual_installation_or_rollback_executed=False,neural_calls=0,production_modified=False,scope='Pinned real completed receipt plus isolated in-memory mutations. No disk receipt edits,quality exception acceptance,neural calls,install or new rollback execution.')
p=T/'locateanything-official-trial-v3-admission-controls-v2.json';assert not p.exists();p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
