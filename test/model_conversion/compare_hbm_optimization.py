"""AINVR compare optimized HBM to an approved HBM on 128 board inputs.

Only inference is paused, through the service API; the source and recorder stay
running. Exact output equality transfers the existing reference comparison,
but is not a new ground-truth accuracy benchmark. Restore the channel in finally.
"""
import argparse
import hashlib
import json
import time
import urllib.request
from pathlib import Path
import numpy as np
import hbm_runtime

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--baseline', type=Path, required=True)
p.add_argument('--candidate', type=Path, required=True)
p.add_argument('--inputs', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--config', type=Path, required=True)
p.add_argument('--channel', required=True)
a = p.parse_args()
assert not a.output.exists()
baseline_contract = json.loads(Path(str(a.baseline)+'.ainvr.json').read_text())
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
assert baseline_contract['hbm_sha256'] == sha(a.baseline)
assert baseline_contract['accuracy_verified'] and baseline_contract['production_approved']
files = sorted(a.inputs.glob('*.bin'))
assert len(files) == 128
key = json.loads(a.config.read_text())['server']['api_key']
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
route = '/api/v1/channels/' + a.channel
def api(path, method='GET'):
    req = urllib.request.Request('http://127.0.0.1:8000'+path,
        headers={'x-api-key':key}, method=method)
    with opener.open(req, timeout=20) as response:
        return json.load(response)

before = api(route)
was_running = before['state'] == 'running'
report = {'baseline_sha256':sha(a.baseline), 'candidate_sha256':sha(a.candidate),
          'samples':128, 'cpu_neural_inference':False, 'production_deployed':False,
          'scope':'Same 128 independent image tensors; optimized vs approved BPU baseline',
          'inference_only_paused':was_running, 'accuracy_verified':False}
try:
    if was_running:
        api(route+'/stop', 'POST')
        deadline = time.monotonic()+20
        while api(route)['state'] == 'running':
            assert time.monotonic() < deadline
            time.sleep(.2)
    models = []
    for path in [a.baseline, a.candidate]:
        rt = hbm_runtime.HB_HBMRuntime(str(path)); name = rt.model_names[0]
        assert len(rt.model_names) == 1 and len(rt.input_names[name]) == 1
        rt.set_scheduling_params(bpu_cores={name:[0]})
        input_name = rt.input_names[name][0]
        shape = tuple(rt.input_shapes[name][input_name])
        assert shape == (1,3,640,640)
        first = np.fromfile(files[0],dtype='<f4').reshape(shape)
        for _ in range(10): rt.run({name:{input_name:first}})
        models.append((rt,name,input_name,shape))
    latencies = [[],[]]; maximum = 0.0; all_exact = True; valid_classes = True
    deadline = time.monotonic()+900
    for i,path in enumerate(files):
        assert time.monotonic()<deadline
        data = np.fromfile(path,dtype='<f4').reshape(1,3,640,640)
        outputs = []
        for j,(rt,name,input_name,shape) in enumerate(models):
            start = time.perf_counter()
            result = rt.run({name:{input_name:data}})[name]
            latencies[j].append((time.perf_counter()-start)*1000)
            assert len(result) == 1
            value = next(iter(result.values()))
            assert value.shape == (1,300,6) and np.isfinite(value).all()
            valid_classes &= bool(np.all(value[:,:,5] == np.rint(value[:,:,5])))
            outputs.append(value.copy())
        maximum = max(maximum,float(np.max(np.abs(outputs[0]-outputs[1]))))
        all_exact &= bool(np.array_equal(*outputs))
        if i%32==0: print('samples',i,flush=True)
    fps = [1000/float(np.mean(x)) for x in latencies]
    report.update(maximum_absolute_difference=maximum, all_outputs_exact=all_exact,
                  strict_integer_classes=valid_classes, baseline_fps=fps[0], candidate_fps=fps[1],
                  speedup=fps[1]/fps[0], accuracy_verified=all_exact and valid_classes,
                  passed=all_exact and valid_classes and fps[1]>fps[0] and fps[1]>5)
finally:
    if was_running:
        api(route+'/start', 'POST')
        deadline = time.monotonic()+30
        while api(route)['state'] != 'running':
            assert time.monotonic()<deadline, 'Production AI channel did not restore'
            time.sleep(.2)
    report['channel_restored'] = api(route)['state'] == before['state']
    a.output.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2),flush=True)
if not report.get('passed'): raise SystemExit(2)
