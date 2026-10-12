"""AINVR real adapter validation rejects bad QA, components and token inputs."""
import argparse
import copy
import json
import os
import subprocess
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
for name in ['model','probe','work','output']:
    p.add_argument('--'+name,type=Path,required=True)
a=p.parse_args()
assert not a.work.exists() and not a.output.exists()
a.work.mkdir()
model=a.work/'test.hbm'
os.link(a.model,model)
sidecar=Path(str(model)+'.ainvr.json')
contract=json.loads(Path(str(a.model)+'.ainvr.json').read_text())
cfg={'id':'yoloe-contract-test','stream':{'url':'rtmp://127.0.0.1:1935/live/xm'},
     'model':{'name':'yoloe-26x','adapter':'yoloe_bpu','provider':'bpu',
              'path':str(model),'input_size':[640,640],'class_names':None,
              'description':'a passenger bus','label_id':'bus','label_name':'公交车'}}
cases=[('valid-single-description',None,None,True,''),
       ('nine-prompts',('class_names',['bus']*9),None,False,'1 到 8'),
       ('empty-description',('description',''),None,False,'单行识别描述'),
       ('over-token-capacity',('description','bus '*100),None,False,'识别描述无效'),
       ('bad-component-sha',None,('dynamic_text','text_hbm_sha256','0'*64),False,'校验契约'),
       ('unapproved-free-text',None,('validation','runtime_free_text_verified',False),False,'自由文字验证'),
       ('insufficient-independent-images',None,('validation','independent_images',127),False,'独立图片'),
       ('bad-recall',None,('metrics','agreement_recall',.94),False,'验收门槛'),
       ('bad-output-shape',None,('output','shape',[1,12,8401]),False,'原始检测头'),
       ('non-bpu-provider',('provider','cpu'),None,False,'BPU')]
rows=[]
for name,config_change,manifest_change,expected,message in cases:
    current=copy.deepcopy(cfg);metadata=copy.deepcopy(contract)
    if config_change:current['model'][config_change[0]]=config_change[1]
    if manifest_change:
        section,key,value=manifest_change
        if section=='metrics':metadata['validation']['metrics'][key]=value
        elif section=='output':metadata['outputs'][0][key]=value
        else:metadata[section][key]=value
    sidecar.write_text(json.dumps(metadata))
    request=a.work/(name+'.json');request.write_text(json.dumps(current))
    result=subprocess.run([str(a.probe),'--validate',str(request)],
                          capture_output=True,text=True,timeout=20)
    accepted=result.returncode==0
    passed=accepted==expected and (expected or message in result.stderr)
    rows.append({'case':name,'expected_accepted':expected,'accepted':accepted,
                 'passed':passed,'error':result.stderr.strip() if not accepted else ''})
# Restore the approved test contract; never mutate the real candidate manifest.
sidecar.write_text(json.dumps(contract,indent=2)+'\n')
report={'scope':'Actual config parser and BpuChannelAdapter component/QA/token guards',
        'passed':all(row['passed'] for row in rows),'cases':rows,
        'production_configuration_changed':False}
a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
if not report['passed']:raise SystemExit(2)
