"""Original BF16 CUDA calibration trajectories;no checkpoint/quantization edits.

Uses exactly the previous32images/two modes/first3calls,excluding all old test
sets. Archives every original layer input/KV in compressed lossless float32.
CUDA is a research oracle only;no BPU or quality acceptance is implied.
"""
from pathlib import Path
import os, sys, json, hashlib, time, traceback, signal, shutil, gc, threading
sys.path.insert(0, '/opt/locate-reference-deps')
import numpy as np
import torch
from transformers import AutoConfig, AutoModel, AutoProcessor

SOURCE = Path('/opt/locate-original-weights')
OUT = Path('/work/native-original-decoder-calibration-v1')
SELECTED = Path('/work/selected-decoder-layer-captures-v2/status.json')
BROAD = Path('/work/broad-decoder-reference-v2/status.json')
check_only = sys.argv[1:] == ['--check-only']
assert not sys.argv[1:] or check_only
assert (check_only or os.getpid() == os.getpgrp()) and not OUT.exists()

def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda: f.read(4*1024**2), b''): h.update(b)
    return h.hexdigest()

def memory_available():
    return next(int(s.split()[1])*1024 for s in Path('/proc/meminfo').read_text().splitlines() if s.startswith('MemAvailable:'))

def check_resources():
    assert memory_available() >= 8*1024**3, 'Preserve8GiB VM reserve for the existing compiler'
    assert shutil.disk_usage('/work').free >= 22*1024**3, 'Preserve22GiB work disk reserve'
    assert torch.cuda.mem_get_info()[0] >= 4*1024**3, 'Preserve4GiB GPU reserve;do not touch miners'
    for used, limit in [('/sys/fs/cgroup/memory.current','/sys/fs/cgroup/memory.max'),
                        ('/sys/fs/cgroup/memory/memory.usage_in_bytes','/sys/fs/cgroup/memory/memory.limit_in_bytes')]:
        if Path(used).exists() and Path(limit).read_text().strip() != 'max':
            assert int(Path(limit).read_text())-int(Path(used).read_text()) >= 2*1024**3
            break

assert digest(SELECTED) == '5cc4ef11f57120b1eaf14832a08794a374726bdc9c5b71b4ae658277220e4f7b'
assert digest(BROAD) == '2f2946d98ea485578896fa59015480094b197354fa573ff1329e0e8ca78a86ea'
selected = json.loads(SELECTED.read_text()); broad = json.loads(BROAD.read_text())
assert selected['status'] == broad['status'] == 'completed'
assert len(selected['cases']) == 64 and len({x['image_id'] for x in selected['cases']}) == 32
assert {x['generation_mode'] for x in selected['cases']} == {'slow', 'hybrid'}
excluded = {}
for path in [Path('/work/heldout-native-reference-v1/status.json'),
             Path('/opt/locate-official-grouped-heldout-native-v1/status.json'),
             Path('/opt/locate-fresh-final-native-v2/status.json')]:
    data = json.loads(path.read_text()); assert data['status'] == 'completed'
    ids = sorted({x['image_id'] for x in data['cases']})
    assert not set(ids) & {x['image_id'] for x in selected['cases']}
    excluded[str(path)] = dict(sha256=digest(path), image_ids=ids)
original_ref = json.loads(Path('/opt/locate-official-grouped-heldout-native-v1/status.json').read_text())
assert original_ref['parameters'] == 3517975280
selection = []
for entry in selected['cases']:
    matches = [x for x in broad['cases'] if (x['image_id'], x['query'], x['source_sha256']) ==
               (entry['image_id'], entry['query'], entry['source_sha256'])]
    assert len(matches) == 1
    directory = Path(matches[0]['directory'])
    old_directory = Path(entry['directory'])
    assert directory.is_relative_to(Path('/work/broad-decoder-reference-v2'))
    assert old_directory.is_relative_to(SELECTED.parent)
    inputs = {}
    for key in ('pixel_values', 'input_ids', 'attention_mask', 'image_grid_hws'):
        p = directory/f'prepared-{key}.npy';old = old_directory/p.name
        a, b = np.load(p, allow_pickle=False), np.load(old, allow_pickle=False)
        assert a.dtype == b.dtype and np.array_equal(a,b), 'Keep precisely the same prepared inputs'
        inputs[key] = dict(path=str(p),sha256=digest(p))
    selection.append(dict(image_id=entry['image_id'],query=entry['query'],
        source_sha256=entry['source_sha256'],generation_mode=entry['generation_mode'],inputs=inputs))
assert len({(e['image_id'],e['generation_mode']) for e in selection}) == 64
check_resources();assert torch.cuda.mem_get_info()[0] > 12*1024**3
if check_only:
    print(json.dumps(dict(status='original_calibration_inputs_and_exclusions_checked',
        images=32,cases=64,excluded_reference_sets=len(excluded),neural_calls=0,
        weights_verified=False,calibration_capture_executed=False)))
    sys.exit(0)
OUT.mkdir()
selection_file = OUT/'selection.json'
selection_file.write_text(json.dumps(dict(status='frozen_before_native_capture',
    entries=selection,excluded=excluded,previous_capture_sha256=digest(SELECTED),
    native_original_weights=True,calibration_only=True,independent_final=False),indent=2)+'\n')
report = dict(status='checking_original_weights', started=time.time(), pid=os.getpid(),
    start_ticks=Path(f'/proc/{os.getpid()}/stat').read_text().rsplit(')',1)[1].split()[19],
    source_sha256=digest(Path(__file__)),selection_sha256=digest(selection_file),
    original_weights_unchanged=True,decoder_layers=36,vision_blocks=27,
    calibration_images=32,calibration_only=True,independent_final=False,
    production_inference=False,neural_provider='CUDA_reference_only',
    whole_model_bpu_verified=False,release_approved=False,cases=[],capture_bytes=0)

def persist():
    p=OUT/'status.json.incoming';p.write_text(json.dumps(report,indent=2)+'\n');p.replace(OUT/'status.json')

model=None;handles=[];guard_done=threading.Event();case_dir=None;counters=[0]*36;case_files=[]
def stop(signum,frame):raise RuntimeError('Owned original calibration capture interrupted')
signal.signal(signal.SIGTERM,stop);persist()

def resource_guard():
    while not guard_done.wait(3):
        try:check_resources()
        except BaseException as error:
            (OUT/'resource-stop.json').write_text(json.dumps(dict(time=time.time(),reason=str(error))))
            os.kill(os.getpid(),signal.SIGTERM);return

threading.Thread(target=resource_guard,daemon=True).start()

def numpy_value(value):
    value=value.detach()
    return value.float().cpu().numpy() if value.is_floating_point() else value.cpu().numpy()

def before(index):
    def hook(module,args,kwargs):
        call=counters[index];counters[index]+=1
        if call>=3:return
        values={k:numpy_value(v) for k,v in kwargs.items() if isinstance(v,torch.Tensor)}
        if 'hidden_states' not in values and args:values['hidden_states']=numpy_value(args[0])
        assert 'hidden_states' in values and 'position_ids' in values
        cache=kwargs.get('past_key_value')
        if cache is not None:
            try:pair=cache[index]
            except (KeyError,IndexError,TypeError):pair=None
            if pair:
                values.update({f'past-{i}':numpy_value(t) for i,t in enumerate(pair)})
        assert all(v.dtype!=object and (not np.issubdtype(v.dtype,np.floating) or np.isfinite(v).all()) for v in values.values())
        assert values['hidden_states'].shape[0]==1 and values['hidden_states'].shape[2]==2048
        p=case_dir/f'block{index}-call-{call}.npz'
        assert not p.exists();np.savez_compressed(p,**values)
        # Verify every archive key,dtype and value before using it for later calibration.
        with np.load(p,allow_pickle=False) as check:
            assert set(check.files)==set(values)
            for key,value in values.items():assert check[key].dtype==value.dtype and np.array_equal(check[key],value)
        case_files.append(dict(layer=index,call=call,file=p.name,bytes=p.stat().st_size,
            sha256=digest(p),query_rows=int(values['hidden_states'].shape[1]),
            keys=sorted(values)))
    return hook

try:
    checked_files=[]
    for entry in original_ref['original_files']:
        p=SOURCE/entry['file'];assert p.stat().st_size==entry['bytes'] and digest(p)==entry['sha256']
        checked_files.append(dict(file=entry['file'],sha256=entry['sha256'],bytes=entry['bytes'],
                                  mtime_ns=p.stat().st_mtime_ns))
    assert {x['file']:x['sha256'] for x in checked_files if x['file'].endswith('.safetensors')} == {
        'model-00001-of-00002.safetensors':'923cfc10fed19808067da6df85a9a4220ddc1f9eb91ceee94c0fecd05d0f2d58',
        'model-00002-of-00002.safetensors':'3459ba101f40594f3f62d3312014f1f8378b4ba3da3b1d562480045938fc7d47'}
    report['original_files']=checked_files;report['status']='loading_original_bf16';persist()
    torch.set_num_threads(2);torch.backends.cuda.matmul.allow_tf32=False;torch.backends.cudnn.allow_tf32=False
    config=AutoConfig.from_pretrained(str(SOURCE),trust_remote_code=True)
    config._attn_implementation='sdpa';config.text_config._attn_implementation='sdpa';config.vision_config._attn_implementation='sdpa'
    model=AutoModel.from_pretrained(str(SOURCE),config=config,torch_dtype=torch.bfloat16,
        device_map={'':'cuda:0'},trust_remote_code=True,attn_implementation='sdpa').eval()
    assert len(model.language_model.model.layers)==36 and len(model.vision_model.encoder.blocks)==27
    assert sum(p.numel() for p in model.parameters())==3517975280
    assert model.language_model.model.embed_tokens.weight.data_ptr()==model.language_model.lm_head.weight.data_ptr()
    assert all(p.dtype==torch.bfloat16 for p in model.parameters() if p.is_floating_point())
    processor=AutoProcessor.from_pretrained(str(SOURCE),trust_remote_code=True,use_fast=False)
    for index,layer in enumerate(model.language_model.model.layers):
        handles.append(layer.register_forward_pre_hook(before(index),with_kwargs=True))
    report['status']='capturing_original_bf16_trajectories';persist()
    with torch.inference_mode():
        for entry in selection:
            check_resources();case_dir=OUT/f"original-{entry['image_id']}-{entry['generation_mode']}"
            assert not case_dir.exists();case_dir.mkdir();counters[:]=[0]*36;case_files.clear()
            prepared={}
            for key,ref in entry['inputs'].items():
                assert digest(ref['path'])==ref['sha256']
                prepared[key]=torch.from_numpy(np.load(ref['path'],allow_pickle=False)).to('cuda:0')
            begin=time.time()
            answer=model.generate(pixel_values=prepared['pixel_values'].to(torch.bfloat16),
                input_ids=prepared['input_ids'],attention_mask=prepared['attention_mask'],
                image_grid_hws=prepared['image_grid_hws'],tokenizer=processor.tokenizer,
                max_new_tokens=12,use_cache=True,generation_mode=entry['generation_mode'],
                temperature=0.,do_sample=False,verbose=False)
            answer=answer[0] if isinstance(answer,tuple) else answer
            assert len(case_files)==108 and all(c>=3 for c in counters),'Native generation ended before required3calibrationcalls'
            total=sum(x['bytes'] for x in case_files)
            case=dict(image_id=entry['image_id'],query=entry['query'],source_sha256=entry['source_sha256'],
                generation_mode=entry['generation_mode'],directory=str(case_dir),response=answer,
                captures_per_layer=[min(c,3) for c in counters],files=list(case_files),
                seconds=time.time()-begin,compressed_bytes=total)
            report['cases'].append(case);report['capture_bytes']+=total
            report['gpu_peak_allocated_bytes']=torch.cuda.max_memory_allocated();persist()
    assert len(report['cases'])==64 and sum(len(c['files']) for c in report['cases'])==6912
    for entry in checked_files:
        p=SOURCE/entry['file'];assert p.stat().st_size==entry['bytes'] and p.stat().st_mtime_ns==entry['mtime_ns']
    report.update(status='completed',native_captured_calls=192,native_layer_captures=6912,finished=time.time())
except BaseException:
    report.update(status='failed',error=traceback.format_exc(),finished=time.time());raise
finally:
    guard_done.set()
    for handle in handles:handle.remove()
    if model is not None:del model
    gc.collect()
    if torch.cuda.is_available():torch.cuda.empty_cache()
    persist()
print(json.dumps({k:report.get(k) for k in ['status','capture_bytes','native_captured_calls','native_layer_captures','gpu_peak_allocated_bytes']}))
