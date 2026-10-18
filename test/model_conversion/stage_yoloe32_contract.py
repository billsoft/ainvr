"""Stage a separately verified 32-slot contract; never enables the UI."""
import argparse, hashlib, json, subprocess
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
for name in ('model','quality','semantics','baseline-status','probe'):
    p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args()
repo=Path('/home/sunrise/ainvr');assert Path.cwd().resolve()==repo
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
read=lambda path:json.loads(path.read_text())
assert a.model.resolve().is_relative_to(Path('/mnt/ainvr-ssd/model-compile-candidates'))
q,s,b=read(a.quality),read(a.semantics),read(a.baseline_status)
assert q['samples']==128 and q['bpu_text_detector_parity_passed']
assert q['hbm_sha256']==s['detector_hbm_sha256']==sha(a.model)
assert s['visible_free_text_functionality_verified'] and s['same_image_runtime_phrase_switch_verified']
assert not s['cpu_neural_fallback'] and not b['external_cpu_ops'] and not b['cpu_neural_fallback_rejected_ops']
assert b['target']=='nash-m' and b['prompt_slots']==32
current=read(a.model.parent/'status.json');assert current['hbm_sha256']==sha(a.model)
assert current['bc_sha256']==b['bc_sha256']
assert q['metrics']['agreement_precision']>=.95 and q['metrics']['agreement_recall']>=.95 and q['metrics']['mean_matched_iou']>=.9
base=read(repo/'ai-service/models/derived/s100p/yoloe-26x.hbm.ainvr.json')
text=base['dynamic_text'];text['prompt_slots']=32
for key in ('text','reprta'):
    assert q[key+'_hbm_sha256']==s[key+'_hbm_sha256']==text[key+'_hbm_sha256']==sha(Path(text[key+'_hbm']))
result=subprocess.run([str(a.probe),'--describe',str(a.model)],capture_output=True,text=True,timeout=45,check=True)
d= json.loads(next(line for line in result.stdout.splitlines() if line.startswith('{')))
inputs={x['name']:x for x in d['inputs']}
assert inputs['images']['shape']==[1,3,640,640] and inputs['prompt_embeddings']['shape']==[1,32,512]
assert len(d['outputs'])==1 and d['outputs'][0]['shape']==[1,36,8400]
contract={key:base[key] for key in ('schema_version','target','adapter','input_size','input_contract','output_contract','preprocess')}
contract.update(hbm_sha256=sha(a.model),inputs=d['inputs'],outputs=d['outputs'],class_names=[],
 accuracy_verified=True,production_approved=True,dynamic_text=text,
 lifecycle='Quality verified candidate for bounded actual-adapter acceptance; not installed or enabled',
 validation={'scope':q['scope']+'; FP32 agreement is not official COCO AP',
 'full_pipeline_accuracy_verified':True,'independent_images':128,'runtime_free_text_verified':True,
 'metrics':q['metrics'],'confidence_threshold':.25,'nms_iou_threshold':.45,'neural_cpu_fallback':False,
 'independent_image_report':str(a.quality.resolve()),'independent_image_report_sha256':sha(a.quality),
 'free_text_visible_report':str(a.semantics.resolve()),'free_text_visible_report_sha256':sha(a.semantics),
 'raw_grid_diagnostic_passed':s['raw_grid_diagnostic_passed'],'limitations':s['limitations'],
 'service_integration_verified':False,'web_ui_verified':False})
sidecar=Path(str(a.model)+'.ainvr.json');assert not sidecar.exists()
sidecar.write_text(json.dumps(contract,indent=2)+'\n');print(sidecar)
