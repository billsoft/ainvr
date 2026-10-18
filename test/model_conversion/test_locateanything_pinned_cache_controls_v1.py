"""Cache ownership controls with a fake parent, not neural or hardware evidence."""
from pathlib import Path
from collections import OrderedDict
import ast,json

ROOT=Path('/home/sunrise/ainvr')


def main():
    source=ROOT/'test/model_conversion/locateanything_bpu_pinned_decoder_executor_v1.py'
    tree=ast.parse(source.read_text());cls=next(n for n in tree.body if isinstance(n,ast.ClassDef))
    assert 'run_ordered' not in {n.name for n in cls.body if isinstance(n,ast.FunctionDef)},'Neural execution must remain inherited'
    class FakeBase:
        def _load(self,key):
            if key in self.loaded:self.loaded.move_to_end(key);return self.loaded[key]
            while len(self.loaded)>=self.maximum_models:self._evict_oldest()
            self.loaded[key]=key;self.loads.append(key);return key
        def _evict_oldest(self):self.evictions.append(self.loaded.popitem(last=False)[0])
        def close(self):
            while self.loaded:self._evict_oldest()
    keys={f'decoder-group-{i:02d}-{i+8:02d}-decode' for i in (0,9,18,27)}
    ns=dict(ComponentExecutor=FakeBase,PIN_KEYS=keys)
    exec(compile(ast.Module(body=[cls],type_ignores=[]),str(source),'exec'),ns)
    actual=ns['PinnedDecoderExecutor']
    executor=actual.__new__(actual)
    executor.loaded=OrderedDict();executor.loads=[];executor.evictions=[]
    executor._initial_maximum=1;executor._pinning_started=False;executor._closing=False;executor.maximum_models=1
    for name in ['vision-0','vision-1','prefill']:executor._load(name)
    assert len(executor.loaded)==1
    for key in sorted(keys):executor._load(key)
    for index in range(38):
        executor._load('head-'+str(index));assert len(executor.loaded)<=5
        assert keys<=set(executor.loaded)
    for key in sorted(keys):executor._load(key)
    assert all(executor.loads.count(key)==1 for key in keys)
    assert not keys.intersection(executor.evictions)
    executor._load('embedding-37');assert keys<=set(executor.loaded)
    executor.close();assert not executor.loaded and executor.maximum_models==1
    for key in sorted(keys):executor._load(key)
    # Simulate the explicit memory-margin eviction request with no eligible
    # rotating entry: fail instead of silently losing a supposedly pinned HBM.
    failed=False
    try:executor._evict_oldest()
    except RuntimeError:failed=True
    assert failed and set(executor.loaded)==keys
    executor.close();assert not executor.loaded
    result=dict(status='passed',actual_bpu_calls=0,fake_parent=True,controls=['inherited_neural_execution','initial_cache_bound','all38_heads_rotate','four_decoder_models_loaded_once','no_decoder_eviction','embedding_rotation','full_close_releases_pins','insufficient_margin_fails_explicitly','second_close_releases_all'])
    out=ROOT/'test/results/locateanything-pinned-cache-controls-v1.json';assert not out.exists();out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))


if __name__=='__main__':main()
