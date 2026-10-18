#!/usr/bin/env python3
"""Install a separately accepted 32-slot detector; preserve every 8-slot artifact."""
import argparse, hashlib, importlib.util, json, os, subprocess, uuid
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
for name in ('model','adapter-report','optimization-report','probe'):
    p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args();repo=Path('/home/sunrise/ainvr');assert Path.cwd().resolve()==repo
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
read=lambda path:json.loads(path.read_text())
assert a.model.resolve().is_relative_to(Path('/mnt/ainvr-ssd/model-compile-candidates'))
contract=read(Path(str(a.model)+'.ainvr.json'));h=sha(a.model)
assert contract['hbm_sha256']==h and contract['dynamic_text']['prompt_slots']==32
quality=contract['validation'];assert contract['production_approved'] and quality['full_pipeline_accuracy_verified']
for field in ('independent_image_report','free_text_visible_report'):
    assert sha(Path(quality[field]))==quality[field+'_sha256']
live=read(a.adapter_report);opt=read(a.optimization_report)
assert live['passed'] and live['prompt_slots']==32 and live['prompt_labels_verified']
assert live['same_hbm_runtime_prompt_reload_verified'] and not live['cpu_neural_fallback']
assert opt['optimized_component_verified'] and opt['outputs_exact'] and opt['optimized_sha256']==h and opt['optimized_fps']>5
assert len(live['groups'])==2
for group in live['groups']:
    assert group['metadata']['hbm_sha256']==h and group['metadata']['prompt_slots']==32
warm=[f['total_adapter_ms'] for g in live['groups'] for f in g['frames'][1:]]
assert len(warm)==10 and 1000/(sum(warm)/len(warm))>5
spec=importlib.util.spec_from_file_location('ainvr_yoloe_install',repo/'deploy-package/install-yoloe-s100p.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=Path('/mnt/ainvr-ssd/ainvr-models')/('yoloe-26x-32-'+h[:12]);root.mkdir(exist_ok=True)
model=root/'yoloe-26x-32.hbm';module.install_file(a.model,model,h)
contract['lifecycle']='32-slot hardware and adapter accepted; actual Web UI acceptance pending'
quality.update(native_channel_adapter_report=str(a.adapter_report.resolve()),
 native_channel_adapter_report_sha256=sha(a.adapter_report),
 optimization_report=str(a.optimization_report.resolve()),optimization_report_sha256=sha(a.optimization_report),
 warm_adapter_fps_excluding_first_frame_initialization=1000/(sum(warm)/len(warm)))
manifest=root/'yoloe-26x-32.hbm.ainvr.json'
data=(json.dumps(contract,indent=2)+'\n').encode()
if manifest.exists(): assert manifest.read_bytes()==data
else:
    temp=manifest.with_name('.'+manifest.name+'.'+uuid.uuid4().hex);temp.write_bytes(data);os.replace(temp,manifest)
config=root/'acceptance-config.json'
config.write_text(json.dumps({'id':'yoloe32-install-check','stream':{'url':'rtmp://localhost/live/test'},
 'model':{'name':'yoloe-26x-32','adapter':'yoloe_bpu','provider':'bpu','path':str(model),
 'prompts':[{'description':'person','label_id':'person','label_name':'Person'}]}}))
subprocess.run([str(a.probe),'--validate',str(config)],check=True,timeout=30)
entries=repo/'ai-service/models/derived/s100p'
module.install_link(entries/model.name,model,h)
module.install_link(entries/manifest.name,manifest,sha(manifest))
print(json.dumps({'installed':str(model),'hbm_sha256':h,'old_8_slot_preserved':True,'ui_enabled':False}))
