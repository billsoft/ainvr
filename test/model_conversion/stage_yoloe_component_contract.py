"""AINVR: stage a quality-approved YOLOE HBM contract on SSD, not deployment."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--research', type=Path, required=True)
p.add_argument('--repo', type=Path, required=True)
p.add_argument('--probe', type=Path, required=True)
a = p.parse_args()
assert a.repo.resolve() == Path('/home/sunrise/ainvr')
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
read = lambda path: json.loads(path.read_text())
r = a.research.resolve()
assert str(r).startswith('/mnt/ainvr-ssd/model-compile-candidates/')
model = r / 'detector-approved-o2-v3/detector.hbm'
sidecar = Path(str(model) + '.ainvr.json')
assert not sidecar.exists()
text = r / 'text-float-softmax-tail-v18/mobileclip2-text.hbm'
rep = r / 'reprta-ec-headroom-v5/reprta.hbm'
quality = a.repo / 'test/results/yoloe-final-unseen-parity-20261013.json'
semantics = a.repo / 'test/results/yoloe-free-text-visible-20261013.json'
raw = a.repo / 'test/results/yoloe-free-text-semantic-final-20261013.json'
q, s = read(quality), read(semantics)
assert q['samples'] == 128 and q['bpu_text_detector_parity_passed']
assert s['visible_free_text_functionality_verified']
assert s['same_image_runtime_phrase_switch_verified']
assert not s['cpu_neural_fallback']
assert q['hbm_sha256'] == s['detector_hbm_sha256'] == sha(model)
assert q['text_hbm_sha256'] == s['text_hbm_sha256'] == sha(text)
assert q['reprta_hbm_sha256'] == s['reprta_hbm_sha256'] == sha(rep)
assert s['original_raw_grid_diagnostic_sha256'] == sha(raw)
baseline = read(r / 'detector-float-prompt-norm-v2/status.json')
optimized = read(model.parent / 'status.json')
assert baseline['bc_sha256'] == optimized['bc_sha256']
assert not baseline['external_cpu_ops']
assert not baseline['cpu_neural_fallback_rejected_ops']
text_status = read(text.parent / 'status.json')
rep_status = read(rep.parent / 'status.json')
assert not text_status['cpu_neural_fallback_rejected_ops']
assert not rep_status['external_cpu_ops']
for op in text_status['external_cpu_ops']:
    assert op['op_name'] in {'token_low_index','token_hi_offset','token_high_index'}
    assert op['input_types'] == ['si32','si32']
helper = a.repo / 'ai-service/tools/clip_tokenize.py'
assets = r / 'clip-tokenizer-mit'
result = subprocess.run([str(a.probe), '--describe', str(model)],
                        capture_output=True, text=True, timeout=30, check=True)
description = json.loads(next(line for line in result.stdout.splitlines()
                              if line.startswith('{')))
assert {x['name'] for x in description['inputs']} == {'images','prompt_embeddings'}
assert description['outputs'][0]['name'] == 'boxes_scores'
assert description['outputs'][0]['shape'] == [1,12,8400]
contract = {
    'schema_version': 1, 'target': 'rdk_s100p', 'adapter': 'yoloe_bpu',
    'hbm_sha256': sha(model), 'input_size': [640,640],
    'inputs': description['inputs'], 'outputs': description['outputs'],
    'input_contract': 'float_nchw_dynamic_prompts',
    'output_contract': 'raw_xywh_class_probabilities',
    'class_names': [], 'accuracy_verified': True, 'production_approved': True,
    'lifecycle': 'Model quality approved for actual adapter testing; not installed or service/UI delivered',
    'preprocess': {'rgb_order': True, 'normalize': True,
                   'mean': [0,0,0], 'std': [255,255,255]},
    'dynamic_text': {
        'prompt_slots': 8, 'embedding_size': 512, 'neural_backend': 'bpu',
        'text_hbm': str(text), 'reprta_hbm': str(rep),
        'text_hbm_sha256': sha(text), 'reprta_hbm_sha256': sha(rep),
        'tokenizer_python': '/mnt/ainvr-ssd/yoloe-tokenizer-venv-20261013/bin/python',
        'tokenizer_helper': str(helper), 'tokenizer_helper_sha256': sha(helper),
        'tokenizer_assets': str(assets),
        'tokenizer_source_sha256': sha(assets/'simple_tokenizer.py'),
        'tokenizer_bpe_sha256': sha(assets/'bpe_simple_vocab_16e6.txt.gz'),
    },
    'validation': {
        'scope': '128 disjoint images compared to original FP32 plus four predeclared native free-description cases; not official COCO AP or arbitrary-phrase accuracy',
        'full_pipeline_accuracy_verified': True, 'independent_images': 128,
        'runtime_free_text_verified': True, 'metrics': q['metrics'],
        'confidence_threshold': .25, 'nms_iou_threshold': .45,
        'neural_cpu_fallback': False,
        'independent_image_report': str(quality),
        'independent_image_report_sha256': sha(quality),
        'free_text_visible_report': str(semantics),
        'free_text_visible_report_sha256': sha(semantics),
        'raw_grid_diagnostic': str(raw), 'raw_grid_diagnostic_sha256': sha(raw),
        'raw_grid_diagnostic_passed': False,
        'limitations': s['limitations'],
        'service_integration_verified': False, 'web_ui_verified': False,
    },
}
sidecar.write_text(json.dumps(contract, indent=2) + '\n')
print(json.dumps({'staged_contract': str(sidecar), 'sha256': sha(sidecar),
                  'installed_to_production': False}))
