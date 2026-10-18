"""AINVR bounded HBM component execution, with no CPU neural fallback.

CPU handles file integrity, model/cache ownership and copied I/O only.
This executor is used by full generation; it does not replace missing layers.
"""
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
import gc,hashlib,json,time
import numpy as np
import hbm_runtime

@dataclass(frozen=True)
class ComponentSpec:
    key: str
    root: Path
    hbm_sha256: str
    input_shapes: tuple
    input_dtypes: tuple

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda:f.read(4*1024**2),b''):h.update(b)
    return h.hexdigest()

def available_bytes():
    return next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))

class ComponentExecutor:
    def __init__(self,specs,budget_bytes,minimum_available_bytes=2*1024**3,maximum_models=2):
        self.specs={s.key:s for s in specs};assert len(self.specs)==len(specs)
        assert budget_bytes>0 and minimum_available_bytes>0
        assert 1<=maximum_models<=2,'Only one/two resident HBM runtimes have passed bounded production-sharing validation'
        self.budget_bytes=budget_bytes;self.minimum_available_bytes=minimum_available_bytes;self.maximum_models=maximum_models
        self.loaded=OrderedDict();self.verified={};self.resident_file_bytes=0
        self.stats=dict(loads=0,evictions=0,calls=0,load_ms=0.,inference_ms=0.,peak_resident_file_bytes=0,peak_loaded_models=0,minimum_observed_available_bytes=available_bytes(),events=[])

    def _observe_memory(self):
        value=available_bytes();self.stats['minimum_observed_available_bytes']=min(self.stats['minimum_observed_available_bytes'],value)
        return value

    def _evict_oldest(self):
        key,item=self.loaded.popitem(last=False);self.resident_file_bytes-=item['bytes']
        self.stats['evictions']+=1;self.stats['events'].append(dict(type='evict',key=key,file_bytes=item['bytes']))
        # The caller only sees independent copied arrays; no borrowed runtime
        # output buffer can keep a retired model alive or be overwritten later.
        del item;gc.collect()

    def _load(self,key):
        if key in self.loaded:
            self.loaded.move_to_end(key);return self.loaded[key]
        spec=self.specs[key];root=spec.root.resolve();assert root.is_relative_to(Path('/mnt/ainvr-ssd/model-compile-candidates'))
        path=root/'model.hbm';size=path.stat().st_size;assert size<=self.budget_bytes,'Single HBM exceeds configured component budget'
        while self.loaded and (self.resident_file_bytes+size>self.budget_bytes or len(self.loaded)>=self.maximum_models or self._observe_memory()<self.minimum_available_bytes):self._evict_oldest()
        assert self._observe_memory()>=self.minimum_available_bytes,'Insufficient host memory margin before HBM load'
        signature=(path.stat().st_size,path.stat().st_mtime_ns)
        if key not in self.verified:
            source=json.loads((root/'status.json').read_text());ports=json.loads((root/'ports.json').read_text())
            assert source['status']=='compiled_bpu_only' and source['bpu_only']
            assert source['nodes'] and all('bpu' in n['device'].lower() for n in source['nodes'])
            assert source.get('cpu_fallback_count') in [None,0]
            assert digest(path)==spec.hbm_sha256==source['hbm_sha256']
            assert len(ports['inputs'])==len(spec.input_shapes)==len(spec.input_dtypes)
            self.verified[key]=dict(signature=signature,ports=ports)
        assert self.verified[key]['signature']==signature,'Verified component changed on disk'
        ports=self.verified[key]['ports'];started=time.perf_counter();runtime=None
        try:
            runtime=hbm_runtime.HB_HBMRuntime(str(path));assert len(runtime.model_names)==1
            name=runtime.model_names[0];runtime.set_scheduling_params(bpu_cores={name:[0]})
            assert set(runtime.input_names[name])=={x['name'] for x in ports['inputs']}
            assert set(runtime.output_names[name])=={x['name'] for x in ports['outputs']}
            assert self._observe_memory()>=self.minimum_available_bytes,'Insufficient memory margin after HBM load'
            item=dict(runtime=runtime,name=name,ports=ports,bytes=size)
            self.loaded[key]=item;self.resident_file_bytes+=size
            elapsed=(time.perf_counter()-started)*1000;self.stats['loads']+=1;self.stats['load_ms']+=elapsed
            self.stats['peak_resident_file_bytes']=max(self.stats['peak_resident_file_bytes'],self.resident_file_bytes)
            self.stats['peak_loaded_models']=max(self.stats['peak_loaded_models'],len(self.loaded))
            self.stats['events'].append(dict(type='load',key=key,file_bytes=size,load_ms=elapsed))
            return item
        except BaseException:
            del runtime;gc.collect();raise

    def run_ordered(self,key,values):
        assert key in self.specs;spec=self.specs[key];assert len(values)==len(spec.input_shapes)
        for value,shape,dtype in zip(values,spec.input_shapes,spec.input_dtypes):
            assert isinstance(value,np.ndarray) and tuple(value.shape)==tuple(shape) and value.dtype==np.dtype(dtype)
            assert value.flags.c_contiguous and np.isfinite(value).all()
        item=self._load(key);inputs={p['name']:v for p,v in zip(item['ports']['inputs'],values)};started=time.perf_counter()
        result=item['runtime'].run({item['name']:inputs})[item['name']]
        outputs=[np.asarray(result[p['name']]).copy() for p in item['ports']['outputs']]
        assert all(np.isfinite(v).all() for v in outputs)
        self.stats['calls']+=1;self.stats['inference_ms']+=(time.perf_counter()-started)*1000;self._observe_memory()
        return outputs

    def close(self):
        while self.loaded:self._evict_oldest()
        self._observe_memory()

    def __enter__(self):return self
    def __exit__(self,*args):self.close()
