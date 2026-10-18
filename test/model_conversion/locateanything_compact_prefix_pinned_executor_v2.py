"""Experimental diagnostic residency;NOT a qualified compact production policy.
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

class DiagnosticPinnedExecutor(ComponentExecutor):
 def __init__(self,specs,budget_bytes,minimum_available_bytes=2*1024**3,maximum_models=1):
  super().__init__(specs,budget_bytes,minimum_available_bytes,maximum_models)
  assert len(self.specs)==113 and PIN_KEYS<=set(self.specs)
  assert self.specs['decoder-group-00-08-decode'].hbm_sha256=='05b6566a85777083e4a2072285618abf59ebaa1a785ffe1b0b8d742fa6753abb'
  pinned=sum((self.specs[k].root/'model.hbm').stat().st_size for k in PIN_KEYS)
  rotating=max((s.root/'model.hbm').stat().st_size for k,s in self.specs.items() if k not in PIN_KEYS)
  assert budget_bytes>=pinned+rotating
  requirements={k:memory_requirement(s.root) for k,s in self.specs.items()}
  missing=[k for k,v in requirements.items() if v is None]
  estimated=None if missing else sum(requirements[k] for k in PIN_KEYS)+max(v for k,v in requirements.items() if k not in PIN_KEYS)
  if estimated is not None:assert estimated+512*1024**2<7500*1024**2
  assert pinned+rotating<6*1024**3,'File working set too large for bounded residency experiment'
  self.residency_plan=dict(diagnostic_only=True,pinned_contexts=42,maximum_contexts=43,pinned_file_bytes=pinned,largest_rotating_file_bytes=rotating,compiler_minimum_sum_plus_rotating=estimated,compiler_metadata_missing=missing,compiler_minimum_complete=not bool(missing),sampled_guard_ceiling_bytes=10400000000,measured_runtime_peak_verified=False)
  self._initial_maximum=maximum_models;self._pinning_started=False;self._closing=False
 def _load(self,key):
  if key in PIN_KEYS:self._pinning_started=True
  self.maximum_models=43 if self._pinning_started else self._initial_maximum
  return super()._load(key)
 def _evict_oldest(self):
  if not self._closing:
   eligible=next((key for key in self.loaded if key not in PIN_KEYS),None)
   if eligible is None:raise RuntimeError('Cannot preserve diagnostic pins within available memory')
   self.loaded.move_to_end(eligible,last=False)
  return super()._evict_oldest()
 def close(self):
  self._closing=True
  try:super().close()
  finally:self._closing=False;self._pinning_started=False;self.maximum_models=self._initial_maximum
