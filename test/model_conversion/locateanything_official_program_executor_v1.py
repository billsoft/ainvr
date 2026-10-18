"""Thread-owned checked BPU programs sharing physical HBM contexts by path.

Supports the official27-graph vision and two-profile text HBMs without loading
weights again for every logical program. CPU only verifies/routes/copies arrays.
Large residency is evaluation-only until a separate actual complete-model proof.
"""
from dataclasses import dataclass
from pathlib import Path
from collections import OrderedDict
import hashlib,json,gc,threading,time
import numpy as np
import hbm_runtime
BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1')
@dataclass(frozen=True)
class ProgramSpec:
 key:str
 path:Path
 hbm_sha256:str
 disas_path:Path
 disas_sha256:str
 program:str
 input_names:tuple
 input_shapes:tuple
 input_dtypes:tuple
 output_names:tuple
 output_shapes:tuple
 output_dtypes:tuple

def digest(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(4194304),b''):h.update(b)
 return h.hexdigest()
def available_bytes():return next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
def identity(p):
 st=Path(p).stat();return st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns

class OfficialProgramExecutor:
 def __init__(self,specs,*,budget_bytes=7*1024**3,minimum_available_bytes=2*1024**3,maximum_models=2,experimental_residency=False):
  assert specs and budget_bytes>0 and minimum_available_bytes>=1024**3 and 1<=maximum_models<=46
  assert maximum_models<=2 or experimental_residency is True,'Complete official-family residency still requires actual qualification'
  self.owner=threading.get_ident();self.specs={s.key:s for s in specs};assert len(self.specs)==len(specs)
  self.budget_bytes=budget_bytes;self.minimum_available_bytes=minimum_available_bytes;self.maximum_models=maximum_models;self.loaded=OrderedDict();self.verified={};self.bytes=0;self.by_path={}
  for s in specs:
   assert isinstance(s,ProgramSpec) and s.key and s.program and s.path.is_absolute() and s.path.resolve().is_relative_to(BASE) and s.disas_path.resolve().is_relative_to(BASE) and not s.path.is_symlink() and not s.disas_path.is_symlink()
   assert len(s.input_names)==len(s.input_shapes)==len(s.input_dtypes) and len(s.output_names)==len(s.output_shapes)==len(s.output_dtypes) and s.input_names and s.output_names
   assert len(set(s.input_names))==len(s.input_names) and len(set(s.output_names))==len(s.output_names)
   assert all(len(h)==64 and all(c in '0123456789abcdef' for c in h) for h in [s.hbm_sha256,s.disas_sha256])
   siblings=self.by_path.setdefault(str(s.path.resolve()),[])
   if siblings:assert (s.hbm_sha256,s.disas_sha256,s.disas_path)==(siblings[0].hbm_sha256,siblings[0].disas_sha256,siblings[0].disas_path)
   assert s.program not in {x.program for x in siblings};siblings.append(s)
  self.stats=dict(calls=0,loads=0,evictions=0,load_ms=0.,inference_ms=0.,peak_loaded_models=0,peak_resident_file_bytes=0,logical_programs=len(specs),physical_hbm_files=len(self.by_path),file_bytes_are_not_runtime_memory=True,events=[])
 def _owned(self):assert threading.get_ident()==self.owner,'SDK contexts must be used and closed by their owning thread'
 def _evict(self):
  self._owned();path,item=self.loaded.popitem(last=False);self.bytes-=item['bytes'];self.stats['evictions']+=1;self.stats['events'].append(dict(type='evict',path=path));del item;gc.collect()
 def _load(self,s):
  self._owned();path=str(s.path.resolve());signature=(identity(s.path),identity(s.disas_path))
  if path in self.loaded:
   assert self.verified[path]==signature,'Verified model or disassembly changed';self.loaded.move_to_end(path);return self.loaded[path]
  size=s.path.stat().st_size;assert 0<size<=self.budget_bytes
  while self.loaded and (self.bytes+size>self.budget_bytes or len(self.loaded)>=self.maximum_models or available_bytes()<self.minimum_available_bytes):self._evict()
  assert available_bytes()>=self.minimum_available_bytes,'Insufficient Linux memory headroom'
  if path not in self.verified:
   assert digest(s.path)==s.hbm_sha256 and digest(s.disas_path)==s.disas_sha256
   d=json.loads(s.disas_path.read_text());expected={x.program for x in self.by_path[path]};assert {g['name'] for g in d['graphs']}==expected
   assert all(g['nodes'] and all(n['device']=='DEVICE_CATEGORY_BPU' for n in g['nodes']) for g in d['graphs']),'Neural CPU fallback rejected'
   assert (identity(s.path),identity(s.disas_path))==signature;self.verified[path]=signature
  assert self.verified[path]==signature
  runtime=None;started=time.perf_counter()
  try:
   runtime=hbm_runtime.HB_HBMRuntime(str(s.path));assert set(runtime.model_names)=={x.program for x in self.by_path[path]};runtime.set_scheduling_params(bpu_cores={n:[0] for n in runtime.model_names})
   for view in self.by_path[path]:assert set(runtime.input_names[view.program])==set(view.input_names) and set(runtime.output_names[view.program])==set(view.output_names)
   assert available_bytes()>=self.minimum_available_bytes and (identity(s.path),identity(s.disas_path))==signature
   item=dict(runtime=runtime,bytes=size);self.loaded[path]=item;self.bytes+=size;ms=(time.perf_counter()-started)*1000;self.stats['loads']+=1;self.stats['load_ms']+=ms;self.stats['peak_loaded_models']=max(self.stats['peak_loaded_models'],len(self.loaded));self.stats['peak_resident_file_bytes']=max(self.stats['peak_resident_file_bytes'],self.bytes);self.stats['events'].append(dict(type='load',path=path,file_bytes=size,load_ms=ms));return item
  except BaseException:runtime=None;gc.collect();raise

 def run_ordered(self,key,values):
  self._owned();assert key in self.specs;s=self.specs[key];assert len(values)==len(s.input_names)
  for v,shape,dtype in zip(values,s.input_shapes,s.input_dtypes):assert isinstance(v,np.ndarray) and v.shape==tuple(shape) and v.dtype==np.dtype(dtype) and v.flags.c_contiguous and np.isfinite(v).all()
  item=self._load(s);start=time.perf_counter();answer=item['runtime'].run({s.program:{name:v for name,v in zip(s.input_names,values)}})[s.program];outputs=[np.asarray(answer[n]).copy() for n in s.output_names]
  for value,shape,dtype in zip(outputs,s.output_shapes,s.output_dtypes):assert value.shape==tuple(shape) and value.dtype==np.dtype(dtype) and np.isfinite(value).all()
  self.stats['calls']+=1;self.stats['inference_ms']+=(time.perf_counter()-start)*1000;return outputs
 def preload_all(self):
  self._owned();assert self.maximum_models>=len(self.by_path) and sum(Path(p).stat().st_size for p in self.by_path)<=self.budget_bytes
  for values in self.by_path.values():self._load(values[0])
  assert len(self.loaded)==len(self.by_path),'Requested complete residency was not retained'
 def close(self):
  self._owned()
  while self.loaded:self._evict()
  assert self.bytes==0
 def __enter__(self):return self
 def __exit__(self,*args):self.close()
