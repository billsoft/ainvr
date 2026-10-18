"""Private experimental adapter; never replaces the installed hbm_runtime package."""
from pathlib import Path
import hashlib,importlib.util,types
MODULE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1/runtime-reuse-io-v108/_locate_reused_io_v1.so')
MODULE_SHA='fc69ef48c28cbc43952b426848846e381f5c46de9059cc50d778a7c2351f106e'
assert MODULE.is_file() and not MODULE.is_symlink() and hashlib.sha256(MODULE.read_bytes()).hexdigest()==MODULE_SHA
spec=importlib.util.spec_from_file_location('_locate_reused_io_v1',MODULE)
native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
class PrivateRuntime:
 def __init__(self,path):self._native=native.Runtime(path);self._closed=False
 @property
 def model_names(self):return self._native.model_names
 @property
 def input_names(self):return self._native.input_names
 @property
 def output_names(self):return self._native.output_names
 @property
 def reuse_stats(self):return self._native.reuse_stats
 def set_scheduling_params(self,*,bpu_cores):
  # The private native implementation uses this exact S100P core mask.
  if bpu_cores!={n:[0] for n in self.model_names}:raise ValueError('Only verified single-core scheduling is available')
 def run(self,values):return self._native.run(values)
 def close(self):
  if not self._closed:self._native.close();self._closed=True
runtime_api=types.SimpleNamespace(HB_HBMRuntime=PrivateRuntime)
