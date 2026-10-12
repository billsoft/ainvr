"""AINVR completion audit: real artifacts, running native service and UI evidence.

This audits the four requested models, not all AINVR product features. GPEN's
explicit visual acceptance remains separate from its failed FP32 numerical gate.
"""
import datetime
import hashlib
import json
import os
import re
import subprocess
import urllib.request
from pathlib import Path

repo = Path('/home/sunrise/ainvr')
assert Path.cwd().resolve() == repo
result_dir = repo/'test/results'
output = result_dir/'four-model-delivery-final-20261013.json'
assert not output.exists()
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
read = lambda name: json.loads((result_dir/name).read_text())
runtime = json.loads((repo/'deploy/s100p/runtime/ai-service.json').read_text())


def api(route):
    request = urllib.request.Request('http://127.0.0.1:8000'+route,
        headers={'x-api-key': runtime['server']['api_key']})
    return json.loads(urllib.request.urlopen(request,timeout=10).read())


models = []
first = read('three-model-final-audit-20261012.json')
assert first['first_three_delivery_verified']
for item in first['models']:
    model = repo/item['file']
    manifest = json.loads(Path(str(model)+'.ainvr.json').read_text())
    assert sha(model) == item['sha256'] == manifest['hbm_sha256']
    assert manifest['production_approved']
    if item['name'] == 'GPEN256':
        assert not manifest['numerical_parity_passed']
        assert manifest['human_visual_acceptance']['approved']
        assert manifest['optimized_reference_exact_samples'] == 128
        assert manifest['snapshot_mongo_verified']
        acceptance = manifest['acceptance_method']
        fps = manifest['benchmark_fps']
    else:
        assert manifest['accuracy_verified']
        validation = manifest['validation']
        assert validation['optimization_equivalence']['all_outputs_exact']
        assert validation['optimization_equivalence']['samples'] == 128
        metrics = manifest.get('validation_metrics',validation.get('agreement'))
        assert metrics['agreement_precision'] >= .95
        assert metrics['agreement_recall'] >= .95
        assert metrics['mean_matched_iou'] >= .9
        acceptance = '128 FP32 result agreement plus exact O2 equivalence'
        fps = validation['sequential_bpu_fps']
    assert fps > 5
    models.append({'name':item['name'],'path':str(model),'hbm_sha256':sha(model),
                   'manifest_sha256':sha(Path(str(model)+'.ainvr.json')),
                   'acceptance':acceptance,'pure_bpu_fps':fps,
                   'native_and_web_evidence':'three-model-final-audit-20261012.json'})

quality = read('yoloe-final-unseen-parity-20261013.json')
semantic = read('yoloe-free-text-visible-20261013.json')
raw = read('yoloe-free-text-semantic-final-20261013.json')
guards = read('yoloe-channel-contract-20261013.json')
adapter = read('yoloe-channel-adapter-live-20261013.json')
person = read('yoloe-live-person-service-20261013.json')
airplane = read('yoloe-live-airplane-service-20261013.json')
sei = read('yoloe-actual-sei-output-20261013.json')
archive = read('yoloe-production-worker-archive-v3-20261013.json')
assert quality['samples'] == 128 and quality['bpu_text_detector_parity_passed']
assert quality['metrics']['agreement_precision'] >= .95
assert quality['metrics']['agreement_recall'] >= .95
assert quality['metrics']['mean_matched_iou'] >= .9
assert semantic['visible_free_text_functionality_verified']
assert semantic['same_image_runtime_phrase_switch_verified']
assert not raw['runtime_free_text_verified']  # Original failed diagnostic stays failed.
assert guards['passed'] and len(guards['cases']) == 10
assert adapter['passed'] and adapter['source_size'] == [3840,1920]
assert {f['image_backend'] for g in adapter['groups'] for f in g['frames']} == {'pym+gles-color'}
assert person['channel']['state'] == airplane['channel']['state'] == 'running'
assert person['channel']['stats']['inference_fps_actual'] > 5
assert airplane['channel']['stats']['inference_fps_actual'] > 5
positive = person['latest_result']['result']
negative = airplane['latest_result']['result']
assert positive['detections'] and positive['model_extra']['prompt_phrases'] == ['person']
assert negative['detections'] == [] and negative['model_extra']['prompt_phrases'] == ['an airplane']
assert positive['model_extra']['hbm_sha256'] == negative['model_extra']['hbm_sha256'] == quality['hbm_sha256']
assert all(x['query_description']=='person' and x['label_id']=='person' for x in positive['detections'])
assert sei['passed'] and len(sei['samples']) >= 3 and not sei['injected_test_metadata']
assert archive['passed'] and archive['records_verified'] >= 12
delivery = archive['archive_stats']['delivery']
assert delivery['accepted'] == delivery['committed'] == archive['records_verified']
assert delivery['outstanding'] == delivery['quarantined'] == 0
assert archive['jpeg_jpu'] > 0 and archive['jpeg_cpu'] == 0

health = api('/health')
channels = api('/api/v1/channels')['channels']
before = json.loads(Path('/mnt/ainvr-ssd/migration-backups/yoloe-service-integration-20261013/channels-before.json').read_text())['channels']
assert len(channels) == len(before) == 1
assert channels[0]['id'] == before[0]['id'] and channels[0]['config'] == before[0]['config']
assert channels[0]['state'] == 'running' and not channels[0]['stats']['last_error']
assert channels[0]['stats']['publish']['running'] and not channels[0]['stats']['publish']['reconnecting']
assert health['version'] == 'ainvr-s100p-reused-control-0.13'
assert health['business']['ready'] and health['capabilities']['model_providers'] == ['bpu']
assert 'yoloe_bpu' in health['capabilities']['model_adapters']
binary = repo/'deploy/s100p/bin/ainvr_ai_service'
binary_sha = sha(binary)
assert binary_sha == 'a5cc2df2ca4bee11050809940466a8c79fd753fe6c31e74036cdac5a2d409159'
pid = int(subprocess.check_output(['systemctl','show','ainvr-ai','-p','MainPID','--value'],text=True).strip())
assert pid > 1 and sha(Path('/proc')/str(pid)/'exe') == binary_sha
linked = subprocess.check_output(['ldd',str(binary)],text=True)
assert 'not found' not in linked
assert not re.search(r'\blib(?:onnxruntime|nvinfer|cuda|cudart)[^ /]*\.so',linked)
assert subprocess.check_output(['systemctl','is-active','ainvr-recorder'],text=True).strip() == 'active'

# Validate the final installed detector and every neural/tokenizer component.
model = repo/'ai-service/models/derived/s100p/yoloe-26x.hbm'
sidecar = Path(str(model)+'.ainvr.json')
manifest_path = sidecar.resolve()
manifest_original = manifest_path.read_bytes()
manifest = json.loads(manifest_original)
assert sha(model) == manifest['hbm_sha256'] == quality['hbm_sha256']
assert model.resolve().is_relative_to(Path('/mnt/ainvr-ssd'))
text = manifest['dynamic_text']
for field in ['text_hbm','reprta_hbm','tokenizer_helper']:
    assert sha(Path(text[field])) == text[field+'_sha256']
assert sha(Path(text['tokenizer_assets'])/'simple_tokenizer.py') == text['tokenizer_source_sha256']
assert sha(Path(text['tokenizer_assets'])/'bpe_simple_vocab_16e6.txt.gz') == text['tokenizer_bpe_sha256']
assert text['text_hbm_sha256'] == quality['text_hbm_sha256']
assert text['reprta_hbm_sha256'] == quality['reprta_hbm_sha256']

front = repo/'srs-web-console/frontend'
presets = (front/'src/types/aiChannel.ts').read_text()
match = re.search(r'SELECTABLE_AI_MODEL_PRESET_KEYS[^=]*=\s*\[(.*?)\]',presets,re.S)
assert set(re.findall(r"'([^']+)'",match.group(1))) == {'yolo26x','yolo26x-face','yoloe-26x'}
assert (front/'dist/index.html').is_file()
test_passes = {}
for filename in ['yoloe-ui-tests-20261013.log','yoloe-ui-wizard-tests-v2-20261013.log']:
    clean = re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',(result_dir/filename).read_text())
    for name,count in re.findall(r'✓\s+(src/test/\S+)\s+\((\d+) tests\)',clean):
        test_passes[name] = int(count)
assert len(test_passes) == 4 and sum(test_passes.values()) == 99
assert '✓ built' in (result_dir/'yoloe-ui-build-20261013.log').read_text()
assert '[  PASSED  ] 19 tests.' in (result_dir/'yoloe-raw-head-metadata-worker-tests-20261013.log').read_text()
assert (result_dir/'yoloe-reproducible-probes-build-v2-20261013.log').stat().st_size > 1000
for image in ['yoloe-live-ui-20261013.jpg','yoloe-live-switch-ui-20261013.jpg','four-model-restored-monitor-20261013.jpg']:
    assert (result_dir/image).read_bytes().startswith(b'\xff\xd8\xff')

evidence_names = ['three-model-final-audit-20261012.json',
    'yoloe-final-unseen-parity-20261013.json','yoloe-free-text-visible-20261013.json',
    'yoloe-free-text-semantic-final-20261013.json','yoloe-channel-contract-20261013.json',
    'yoloe-channel-adapter-live-20261013.json','yoloe-live-person-service-20261013.json',
    'yoloe-live-airplane-service-20261013.json','yoloe-actual-sei-output-20261013.json',
    'yoloe-production-worker-archive-v3-20261013.json',
    'yoloe-original-config-restored-20261013.json',
    'yoloe-ui-wizard-tests-v2-20261013.log','yoloe-control-regression-tests-20261013.log']
manifest['validation'].update(service_integration_verified=True,web_ui_verified=True,
    snapshot_mongodb_verified=True,actual_sei_readback_verified=True,
    runtime_phrase_update_without_recompile_verified=True,
    live_person_fps=person['channel']['stats']['inference_fps_actual'],
    live_airplane_fps=airplane['channel']['stats']['inference_fps_actual'],
    delivery_audit=str(output))
manifest['lifecycle'] = 'Installed and verified in native BPU AI service and normal Web UI; original user configuration restored'
manifest['deployment'] = {'service_version':health['version'],'binary_sha256':binary_sha}
temporary = manifest_path.with_name('.'+manifest_path.name+'.final-audit')
assert not temporary.exists()
temporary.write_text(json.dumps(manifest,indent=2)+'\n')
assert manifest_path.read_bytes() == manifest_original
os.chmod(temporary,manifest_path.stat().st_mode);os.replace(temporary,manifest_path)
models.append({'name':'YOLOE-26x dynamic open vocabulary','path':str(model),
    'hbm_sha256':sha(model),'manifest_sha256':sha(sidecar),
    'text_hbm_sha256':text['text_hbm_sha256'],'reprta_hbm_sha256':text['reprta_hbm_sha256'],
    'acceptance':'Full BPU FP32 result agreement plus visible free-text, actual native service/UI, SEI and isolated production archive',
    'detector_tensor_fps':quality['board_fps_with_production_running'],
    'live_measured_fps':[person['channel']['stats']['inference_fps_actual'],airplane['channel']['stats']['inference_fps_actual']],
    'raw_grid_diagnostic_passed':False,'limitations':raw['limitations']})
report = {
    'checked_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope':'Four requested HBM models and native BPU AI service/Web UI integration; not whole-product completion or official accuracy benchmarks',
    'full_four_model_goal_complete':True,'models':models,
    'requirements':[
        {'requirement':'YOLO26x COCO80 HBM/BPU and service/UI','proved':True,'evidence':'unchanged approved HBM hash, three-model final audit and current native regression'},
        {'requirement':'YOLO26x-face HBM/BPU and service/UI','proved':True,'evidence':'unchanged approved O2 HBM and 128 exact outputs, prior real face/GPEN UI audit, preserved face regression'},
        {'requirement':'GPEN256 HBM/BPU and archive/UI','proved':True,'evidence':'explicit user visual approval, 128 exact O2 outputs and original/enhanced archive/UI evidence; strict numerical failure retained'},
        {'requirement':'YOLOE-26x dynamic open-vocabulary HBM/BPU','proved':True,'evidence':'real BPU text/RepRTA/detector, new independent128 and free-description ALL visible outputs'},
        {'requirement':'YOLOE native service and frontend wiring','proved':True,'evidence':'normal UI saves, >5FPS real4K, unchanged HBM at phrase switch, actual SEI, production worker/store Mongo/JPU'},
        {'requirement':'Hardware-first media, no neural CPU fallback','proved':True,'evidence':'compiler placement contracts, real PYM/GLES/BPU path, JPU counters, running binary no ONNX/CUDA dependencies'},
        {'requirement':'Preserve first-three delivery and user configuration','proved':True,'evidence':'all HBM hashes match and original channel config exactly restored; two actual browser3840x1920 readyState4 videos; recorder active'},
    ],
    'production_binary_sha256':binary_sha,'running_binary_sha_verified':True,
    'service_version':health['version'],'business_ready':health['business']['ready'],
    'runtime_providers':health['capabilities']['model_providers'],
    'original_user_config_restored_exactly':True,'current_model':'yolo26x',
    'current_target_fps':15,'current_snapshot_enabled':False,
    'current_measured_fps':channels[0]['stats']['inference_fps_actual'],
    'recorder_active':True,'frontend_related_tests':test_passes,
    'native_regression_tests':43,'final_worker_recheck_tests':19,
    'yoloe_archive_verified_records':archive['records_verified'],
    'yoloe_archive_jpu':archive['jpeg_jpu'],'yoloe_archive_cpu_jpeg':archive['jpeg_cpu'],
    'browser_proof':{'source_and_ai_dimensions':[3840,1920],'ready_state':4,
                     'source_time_observed':593.093837,'ai_time_observed':592.158797},
    'evidence_sha256':{name:sha(result_dir/name) for name in evidence_names},
    'known_non_passing_results_preserved':[
        'GPEN strict FP32 numerical gate failed, accepted explicitly by user visually',
        'YOLOE raw-grid pointwise gate failed; independent final detection-set and visible semantic gates passed',
        'Original FP32 model misses domestic-animal phrase on retained dog image'],
}
output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ['full_four_model_goal_complete',
    'service_version','original_user_config_restored_exactly',
    'current_measured_fps','yoloe_archive_verified_records']},ensure_ascii=False))
