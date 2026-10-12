"""AINVR capture 128 independent dynamic-prompt YOLOE detector outputs.

The host FP32 oracle is development-only. A successful capture is not accuracy
approval, nor validation of the separate BPU text encoder.
"""
import argparse
import hashlib
import json
import time
import sys
from pathlib import Path
import numpy as np

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--backend', choices=['bpu', 'onnx-cuda'], required=True)
p.add_argument('--model', type=Path, required=True)
p.add_argument('--prepared', type=Path, required=True)
p.add_argument('--images', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--status', type=Path)
p.add_argument('--baseline-status', type=Path,
               help='O0 placement/source contract for an optimized HBM from exactly the same BC')
p.add_argument('--bpu-text', type=Path)
p.add_argument('--bpu-reprta', type=Path)
p.add_argument('--tokenizer', type=Path)
p.add_argument('--tokenizer-libraries', type=Path)
p.add_argument('--text-quality-report', type=Path)
p.add_argument('--reprta-quality-report', type=Path)
a = p.parse_args()
text_options=[a.bpu_text,a.bpu_reprta,a.tokenizer,a.tokenizer_libraries,
              a.text_quality_report,a.reprta_quality_report]
assert not any(text_options) or (all(text_options) and a.backend=='bpu')
dynamic_text=all(text_options)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
prepared = json.loads((a.prepared / 'manifest.json').read_text())
assert prepared['state'] == 'prepared'
samples = [x for x in prepared['samples'] if x['split'] == 'validation']
assert len(samples) == 128
assert len({x['image_tensor'] for x in samples}) == 128
assert not {x['image_tensor'] for x in samples} & {
    x['image_tensor'] for x in prepared['samples'] if x['split'] == 'calibration'}
a.output.mkdir(parents=True, exist_ok=False)
if a.backend == 'bpu':
    import hbm_runtime
    assert a.status is not None
    status = json.loads(a.status.read_text())
    if a.baseline_status:
        baseline=json.loads(a.baseline_status.read_text())
        assert status['opt']==2 and baseline['opt']==0
        assert status['bc_sha256']==baseline['bc_sha256']
        assert status['target']==baseline['target']=='nash-m'
        assert sha(a.baseline_status.parent/'detector.hbm')==baseline['hbm_sha256']
        status=dict(baseline,hbm_sha256=status['hbm_sha256'],opt=2,
                    optimized_from_same_bc=True)
    assert status['kind'] == 'detector'
    assert status['state'] == 'compiled_needs_validation'
    assert not status['external_cpu_ops']
    assert not status['cpu_neural_fallback_rejected_ops']
    assert sha(a.model) == status['hbm_sha256']
    assert status['source_onnx_sha256'] == prepared['detector_onnx_sha256']
    runtime = hbm_runtime.HB_HBMRuntime(str(a.model))
    assert len(runtime.model_names) == 1
    name = runtime.model_names[0]
    assert set(runtime.input_names[name]) == {'images', 'prompt_embeddings'}
    assert tuple(runtime.input_shapes[name]['images']) == (1, 3, 640, 640)
    assert tuple(runtime.input_shapes[name]['prompt_embeddings']) == (1, 8, 512)
    runtime.set_scheduling_params(bpu_cores={name: [0]})
    def run(inputs):
        result = runtime.run({name: inputs})[name]
        assert len(result) == 1
        return next(iter(result.values()))
    if dynamic_text:
        text_status=json.loads((a.bpu_text/'status.json').read_text())
        rep_status=json.loads((a.bpu_reprta/'status.json').read_text())
        tq=json.loads(a.text_quality_report.read_text())
        rq=json.loads(a.reprta_quality_report.read_text())
        text_model=a.bpu_text/'mobileclip2-text.hbm'
        rep_model=a.bpu_reprta/'reprta.hbm'
        assert sha(text_model)==text_status['hbm_sha256']==tq['hbm_sha256']
        assert sha(rep_model)==rep_status['hbm_sha256']==rq['hbm_sha256']
        assert tq['encoder_quantization_parity_passed'] and rq['reprta_parity_passed']
        assert not text_status['cpu_neural_fallback_rejected_ops']
        for op in text_status['external_cpu_ops']:
            assert op['op_name'] in {'token_low_index','token_hi_offset','token_high_index'}
            assert op['input_types']==['si32','si32']
        assert not rep_status['external_cpu_ops']
        sys.path.insert(0,str(a.tokenizer_libraries))
        sys.path.insert(0,str(a.tokenizer))
        from simple_tokenizer import SimpleTokenizer
        tokenizer=SimpleTokenizer(str(a.tokenizer/'bpe_simple_vocab_16e6.txt.gz'))
        text_runtime=hbm_runtime.HB_HBMRuntime(str(text_model))
        rep_runtime=hbm_runtime.HB_HBMRuntime(str(rep_model))
        assert len(text_runtime.model_names)==len(rep_runtime.model_names)==1
        text_name=text_runtime.model_names[0];rep_name=rep_runtime.model_names[0]
        assert text_runtime.input_names[text_name]==['tokens']
        assert rep_runtime.input_names[rep_name]==['text_embeddings']
        text_runtime.set_scheduling_params(bpu_cores={text_name:[0]})
        rep_runtime.set_scheduling_params(bpu_cores={rep_name:[0]})
        text_cache={};text_times=[];rep_times=[]
        def encode_prompts(item):
            raw=np.zeros((1,8,512),np.float32)
            for i,phrase in enumerate(item['class_names'][:item['active_count']]):
                if phrase not in text_cache:
                    ids=[tokenizer.encoder['<|startoftext|>']]+tokenizer.encode(phrase)+[tokenizer.encoder['<|endoftext|>']]
                    assert len(ids)<=77 and all(0<=x<=49407 for x in ids)
                    tokens=np.zeros((1,77),np.int32);tokens[0,:len(ids)]=ids
                    begin=time.perf_counter()
                    result=text_runtime.run({text_name:{'tokens':tokens}})[text_name]
                    text_times.append((time.perf_counter()-begin)*1000)
                    assert len(result)==1
                    encoded=next(iter(result.values()))
                    assert encoded.shape==(1,512) and np.isfinite(encoded).all()
                    text_cache[phrase]=encoded.copy()
                raw[0,i]=text_cache[phrase][0]
            begin=time.perf_counter()
            result=rep_runtime.run({rep_name:{'text_embeddings':raw}})[rep_name]
            rep_times.append((time.perf_counter()-begin)*1000)
            assert len(result)==1
            encoded=next(iter(result.values()))
            assert encoded.shape==(1,8,512) and np.isfinite(encoded).all()
            encoded=np.ascontiguousarray(encoded,dtype=np.float32).copy()
            # Learned FFN biases mean RepRTA(0) is not generally zero. Empty
            # slots are an interface mask, applied AFTER the learned network,
            # exactly as in preparation of the FP32 dynamic prompt oracle.
            encoded[:,item['active_count']:]=0
            return encoded
else:
    import onnxruntime as ort
    assert sha(a.model) == prepared['detector_onnx_sha256']
    assert 'CUDAExecutionProvider' in ort.get_available_providers()
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 2
    opts.inter_op_num_threads = 1
    opts.enable_profiling = True
    opts.profile_file_prefix = str(a.output / 'ort-profile')
    runtime = ort.InferenceSession(str(a.model), opts, providers=[
        ('CUDAExecutionProvider', {'gpu_mem_limit': 4 * 1024**3,
         'arena_extend_strategy': 'kSameAsRequested', 'use_tf32': 0}),
        'CPUExecutionProvider'])
    assert runtime.get_providers()[0] == 'CUDAExecutionProvider'
    def run(inputs):
        result = runtime.run(None, inputs)
        assert len(result) == 1
        return result[0]

def inputs_for(item):
    image = a.images / item['image_tensor']
    prompt = a.prepared / item['prompt_file']
    assert sha(image) == item['image_sha256']
    assert sha(prompt) == item['prompt_sha256']
    values = {'images': np.fromfile(image, dtype='<f4').reshape(1, 3, 640, 640),
              'prompt_embeddings': np.fromfile(prompt, dtype='<f4').reshape(1, 8, 512)}
    assert 1 <= item['active_count'] <= 8
    assert np.all(values['prompt_embeddings'][:, item['active_count']:] == 0)
    if dynamic_text:
        values['prompt_embeddings']=encode_prompts(item)
    return values

first = inputs_for(samples[0])
for _ in range(5):
    run(first)
rows = []
latencies = []
deadline = time.monotonic() + 900
for i, item in enumerate(samples):
    assert time.monotonic() < deadline, 'Bounded capture deadline reached'
    inputs = inputs_for(item)
    start = time.perf_counter()
    output = run(inputs)
    latency = (time.perf_counter() - start) * 1000
    assert output.shape == (1, 12, 8400)
    assert np.isfinite(output).all()
    key = Path(item['image_tensor']).stem
    np.savez_compressed(a.output / (key + '.npz'), output=output)
    rows.append(dict(item, id=key, latency_ms=latency,
                     runtime_prompt_sha256=hashlib.sha256(inputs['prompt_embeddings'].tobytes()).hexdigest(),
                     prompt_tensor_source='BPU text encoder and RepRTA' if dynamic_text else 'FP32 oracle file',
                     min_score=float(output[:, 4:].min()),
                     max_score=float(output[:, 4:].max())))
    latencies.append(latency)
    if i % 32 == 0:
        print('captured', i, flush=True)
report = {'scope': 'Complete image+prompt detector only; FP32 oracle prompt vectors',
          'model_sha256': sha(a.model), 'source_onnx_sha256': prepared['detector_onnx_sha256'],
          'prepared_manifest_sha256': sha(a.prepared / 'manifest.json'),
          'backend': a.backend, 'samples': rows, 'warmup': 5,
          'sequential_fps': 1000 / float(np.mean(latencies)),
          'median_ms': float(np.median(latencies)),
          'p95_ms': float(np.percentile(latencies, 95)),
          'timing': 'Tensor inference only, production may run concurrently; excludes loading and IO',
          'accuracy_verified': False, 'production_approved': False,
          'full_dynamic_text_pipeline_verified': False}
if dynamic_text:
    report.update(scope='Complete BPU text encoding, RepRTA and dual-input detector capture; requires comparison',
                  prompts_generated_on_bpu=True,text_hbm_sha256=sha(text_model),reprta_hbm_sha256=sha(rep_model),
                  distinct_texts_encoded=len(text_cache),
                  text_encoder_fps=1000/float(np.mean(text_times)),
                  reprta_batch8_fps=1000/float(np.mean(rep_times)),
                  text_logic_backend='CPU BPE/string/index logic only; every NN executes HBM on BPU')
if a.backend == 'onnx-cuda':
    profile_path = Path(runtime.end_profiling())
    events = json.loads(profile_path.read_text())
    providers = {}
    for event in events:
        provider = event.get('args', {}).get('provider')
        if provider:
            providers[provider] = providers.get(provider, 0) + 1
    assert providers.get('CUDAExecutionProvider', 0) > 0
    report['profile_provider_event_counts'] = providers
(a.output / 'manifest.json').write_text(json.dumps(report, indent=2))
print(json.dumps({k: v for k, v in report.items() if k != 'samples'}, indent=2))
