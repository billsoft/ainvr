"""UID1000 actual BPU verification of a TWO-layer selected-checkpoint group only.

Six old tuning input/cache profiles repeated three times. All output elements are
compared with the matching compiler simulator;not full LocateAnything quality.
"""
from pathlib import Path
import os,argparse,json,time,hashlib,traceback,gc
import numpy as np,hbm_runtime
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
def digest(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4*1024**2),b''):h.update(b)
 return h.hexdigest()
def main():
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--report',type=Path,required=True);a=p.parse_args();root=a.root.resolve();assert root.parent==BASE and root.name=='selected-decoder-prototype-v1';assert a.report.parent.resolve()==root and not a.report.exists();assert os.getuid()==1000
 r=dict(status='checking',started=time.time(),scope=__doc__,uid=os.getuid(),source_sha256=digest(Path(__file__)),whole_model_verified=False,release_approved=False,actual_completed_bpu_calls=0,runs=[]);runtime=None
 def save():
  q=a.report.with_suffix('.json.tmp');q.write_text(json.dumps(r,indent=2)+'\n');q.replace(a.report)
 try:
  save();manifest=json.loads((root/'manifest.json').read_text());assert manifest['schema']=='selected_decoder_two_layer_fixture_v1' and manifest['evaluation_only'] and not manifest['release_approved'];assert manifest['layers']==[0,1]
  for name,sha in manifest['files'].items():
   path=(root/name).resolve();assert path.is_relative_to(root) and not path.is_symlink() and digest(path)==sha
  compiler=json.loads((root/'compiler-status.json').read_text());assert compiler['status']=='completed' and compiler['bpu_only'] and compiler['layer_count']==2 and compiler['sequence_capacity']==12 and len(compiler['selected_modules'])==14;assert compiler['selected_checkpoint_sha256']=='071195f09709241b3de2c823a04ae869320e373c0b779467cbde0a863d5737fb'
  assert digest(root/'model.hbm')==compiler['hbm_sha256'];qualification=json.loads((root/'fixtures/status.json').read_text());assert qualification['status']=='completed' and qualification['board_probe_eligible'] and len(qualification['cases'])==6
  start=time.monotonic();runtime=hbm_runtime.HB_HBMRuntime(str(root/'model.hbm'));assert len(runtime.model_names)==1;name=runtime.model_names[0];runtime.set_scheduling_params(bpu_cores={name:[0]});r['load_seconds']=time.monotonic()-start;r['hbm_sha256']=compiler['hbm_sha256']
  for index,case in enumerate(qualification['cases']):
   values={};references=[]
   for entry in case['inputs']:
    path=root/'fixtures'/entry['file'];assert digest(path)==entry['sha256'];value=np.load(path,allow_pickle=False);assert list(value.shape)==entry['shape'] and str(value.dtype)==entry['dtype'];values[entry['name']]=value
   for entry in case['outputs']:
    path=root/'fixtures'/entry['file'];assert digest(path)==entry['sha256'];references.append(np.load(path,allow_pickle=False))
   assert set(runtime.input_names[name])==set(values) and set(runtime.output_names[name])=={e['name'] for e in case['outputs']}
   for iteration in range(3):
    start=time.monotonic();result=runtime.run({name:values})[name];actual=[np.asarray(result[e['name']]).copy() for e in case['outputs']];elapsed=time.monotonic()-start;r['actual_completed_bpu_calls']+=1;metrics=[]
    for output,(value,reference) in enumerate(zip(actual,references)):
     assert value.shape==reference.shape and value.dtype==reference.dtype and np.isfinite(value).all();difference=value.astype(np.float64)-reference.astype(np.float64);equal=bool(np.array_equal(value,reference));metrics.append(dict(output=output,numeric_array_equal=equal,maxabs=float(np.abs(difference).max()),relative_l2=float(np.linalg.norm(difference)/max(np.linalg.norm(reference),1e-20))))
     path=root/f'actual-case{index:02d}-repeat{iteration}-out{output}.npy';assert not path.exists();np.save(path,value)
    r['runs'].append(dict(case=index,image_id=case['image_id'],mode=case['mode'],query_rows=case['query_rows'],repeat=iteration,seconds=elapsed,outputs=metrics));save();assert all(x['numeric_array_equal'] for x in metrics),'Actual BPU output differs from compiler simulator'
  assert r['actual_completed_bpu_calls']==18;r['status']='completed';r['all_output_arrays_numerically_equal']=True
 except BaseException:r.update(status='failed',error=traceback.format_exc());raise
 finally:
  runtime=None;gc.collect();r['runtime_reference_released']=True;r['finished']=time.time();save()
 print(json.dumps({k:r.get(k) for k in ['status','actual_completed_bpu_calls','all_output_arrays_numerically_equal','error']}))
if __name__=='__main__':main()
