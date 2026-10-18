"""Experimental COMPLETE compact residency;production admission is not yet qualified.
Keep four decoder contexts and38heads;one other component rotates.
The unchanged base performs every neural call and returns copied outputs.
"""
from pathlib import Path
import json
from locateanything_bpu_components_v2 import ComponentExecutor,digest
PIN_KEYS={f'decoder-group-{i:02d}-{i+8:02d}-decode' for i in (0,9,18,27)}|{f'head-{i:02d}' for i in range(38)}

def memory_requirement(root):
 path=root/'disas.json'
 if not path.exists():return None
 data=json.loads(path.read_text());values=[]
 def walk(x):
  if isinstance(x,dict):
   for k,v in x.items():
    if k=='modelMemoryRequirement':values.append(v['minMemoryRequirement'])
    else:walk(v)
  elif isinstance(x,list):
   for v in x:walk(v)
 walk(data);assert values and len(set(values))==1 and values[0]>0
 return values[0]

class ExperimentalCompactResidentExecutor(ComponentExecutor):
 def __init__(self,specs,budget_bytes,minimum_available_bytes=2*1024**3,maximum_models=1,*,experimental_residency=False):
  if experimental_residency is not True:raise ValueError('Complete residency requires explicit bounded experimental admission')
  super().__init__(specs,budget_bytes,minimum_available_bytes,maximum_models)
  assert len(self.specs)==113 and PIN_KEYS<=set(self.specs)
  assert all(len(s.hbm_sha256)==64 and set(s.hbm_sha256)<=set('0123456789abcdef') for s in self.specs.values())
  pinned=sum((self.specs[k].root/'model.hbm').stat().st_size for k in PIN_KEYS)
  rotating=max((s.root/'model.hbm').stat().st_size for k,s in self.specs.items() if k not in PIN_KEYS)
  assert budget_bytes>=pinned+rotating
  requirements={k:memory_requirement(s.root) for k,s in self.specs.items()}
  missing=[k for k,v in requirements.items() if v is None]
  estimated=None if missing else sum(requirements[k] for k in PIN_KEYS)+max(v for k,v in requirements.items() if k not in PIN_KEYS)
  if estimated is not None:assert estimated+512*1024**2<7500*1024**2
  assert pinned+rotating<6*1024**3,'File working set too large for bounded residency experiment'
  self.residency_plan=dict(experimental_only=True,complete_compact_model_required=True,pinned_contexts=42,maximum_contexts=43,pinned_file_bytes=pinned,largest_rotating_file_bytes=rotating,compiler_minimum_sum_plus_rotating=estimated,compiler_metadata_missing=missing,compiler_minimum_complete=not bool(missing),sampled_guard_ceiling_bytes=10400000000,measured_runtime_peak_verified=False)
  self.aliases={}
  for start in (0,9,18,27):
   pre=f'decoder-group-{start:02d}-{start+8:02d}-prefill';ar=f'decoder-group-{start:02d}-{start+8:02d}-decode'
   a,b=self.specs[pre],self.specs[ar]
   if a.hbm_sha256==b.hbm_sha256 and a.input_shapes==b.input_shapes and a.input_dtypes==b.input_dtypes:
    assert json.loads((a.root/'ports.json').read_text())==json.loads((b.root/'ports.json').read_text()),'Same-graph role port metadata differs'
    self.aliases[pre]=ar
  expected={f'decoder-group-{i:02d}-{i+8:02d}-prefill':f'decoder-group-{i:02d}-{i+8:02d}-decode' for i in (0,9,18,27)}
  assert self.aliases==expected,'All4 compact groups must explicitly reuse the SAME AR1 graph for prefill1'
  self.residency_plan['verified_same_graph_role_aliases']=dict(self.aliases)
  self._initial_maximum=maximum_models;self._pinning_started=False;self._closing=False
 def _load(self,key):
  # Roles share one runtime ONLY for exactly identical executable hash and input/output port metadata.
  key=self.aliases.get(key,key)
  if key in PIN_KEYS:self._pinning_started=True
  self.maximum_models=43 if self._pinning_started else self._initial_maximum
  return super()._load(key)
 def _evict_oldest(self):
  if not self._closing:
   eligible=next((key for key in self.loaded if key not in PIN_KEYS),None)
   if eligible is None:raise RuntimeError('Cannot preserve complete compact pins within available memory')
   self.loaded.move_to_end(eligible,last=False)
  return super()._evict_oldest()
 def close(self):
  self._closing=True
  try:super().close()
  finally:self._closing=False;self._pinning_started=False;self.maximum_models=self._initial_maximum
