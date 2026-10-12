"""AINVR official OE INT8 compilation using checked, independent datasets.

Run inside the official x86 OE 3.7.0 container after copying models and data
to --workspace. Outputs/logs stay there. No production deployment is performed.
"""
import argparse
import hashlib
import json
import subprocess
import time
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--workspace',type=Path,required=True)
p.add_argument('--output-name',default='compiled')
p.add_argument('--models',nargs='+',choices=['yolo26x','yolo26x-face','gpen256'])
p.add_argument('--calibration-method', choices=['auto', 'max'], default='auto',
               help='max avoids the default multi-method search; independent accuracy validation is still required')
p.add_argument('--prepare-only', action='store_true', help='Verify data and write configs without starting a compiler')
p.add_argument('--gpen-model-path', type=Path)
p.add_argument('--gpen-parity-report', type=Path)
p.add_argument('--compiler-jobs', type=int, choices=range(1,17), default=4)
a=p.parse_args(); root=a.workspace.resolve(strict=True)
assert Path(a.output_name).name==a.output_name
output=root/a.output_name; output.mkdir(exist_ok=False)
specs=[('yolo26x','yolo26x.onnx',root/'coco/calibration',root/'coco/manifest.json','images',640),
       ('yolo26x-face','yolo26x-face-op17.onnx',root/'celeba/face/calibration',root/'celeba/manifest.json','images',640),
       ('gpen256','gpen256.onnx',root/'celeba/gpen256/calibration',root/'celeba/manifest.json',None,256)]
if a.models:
    specs=[spec for spec in specs if spec[0] in a.models]
status={'target':'nash-m','precision_requested':'int8','calibration_method':a.calibration_method,'accuracy_verified':False,'production_deployed':False,'models':[]}
def save():
    temp=output/'status.json.tmp'; temp.write_text(json.dumps(status,indent=2)); temp.replace(output/'status.json')
for name,model,data,manifest,input_name,size in specs:
    run=output/name; run.mkdir()
    entry={'name':name,'state':'verifying','calibration_samples':0,'started_unix':time.time()}
    status['models'].append(entry); save()
    metadata=json.loads(manifest.read_text(encoding='utf-8'))
    expected={}
    for item in metadata['items']:
        if item['split']!='calibration': continue
        tensor=item.get('tensor')
        sha=item.get('tensor_sha256')
        if tensor is None:
            kind='face' if name=='yolo26x-face' else 'gpen256'
            tensor=item['tensors'][kind]['path']; sha=item['tensors'][kind]['sha256']
        expected[Path(tensor.replace('\\','/')).name]=sha
    files=sorted(data.glob('*.bin'))
    assert len(files)==len(expected)==512, name
    for file in files:
        assert file.stat().st_size==size*size*3*4
        assert hashlib.sha256(file.read_bytes()).hexdigest()==expected[file.name],file
    entry['calibration_samples']=len(files)
    source=root/'models'/model
    if name=='gpen256' and a.gpen_model_path:
        assert a.gpen_parity_report, 'Rewritten GPEN requires an independent FP32 parity report'
        source=a.gpen_model_path.resolve(strict=True)
        parity=json.loads(a.gpen_parity_report.read_text())
        assert parity['fp32_rewrite_parity_passed'] is True and len(parity['samples'])==128
        assert parity['model_sha256']==hashlib.sha256(source.read_bytes()).hexdigest()
        assert parity['original_model_sha256']=='bf7c7ced8e5f69fca6a3a226023a65f8f0689ae9c7d2e095b29c8c78dc3c6bb5'
        entry['rewrite_parity_report_sha256']=hashlib.sha256(a.gpen_parity_report.read_bytes()).hexdigest()
    entry['onnx_sha256']=hashlib.sha256(source.read_bytes()).hexdigest()
    entry['manifest_sha256']=hashlib.sha256(manifest.read_bytes()).hexdigest()
    inputs={'input_type_train':'featuremap','input_type_rt':'featuremap'}
    if input_name: inputs.update(input_name=input_name,input_shape=f'1x3x{size}x{size}')
    config={'model_parameters':{'onnx_model':str(source),'march':'nash-m',
        'output_model_file_prefix':name.replace('-','_')+'_int8','working_dir':str(run/'model_output')},
        'input_parameters':inputs,
        'calibration_parameters':{'cal_data_dir':str(data),
            'quant_config':{'model_config':{'all_node_type':'int8'}}},
        'compiler_parameters':{'compile_mode':'latency','optimize_level':'O0','jobs':a.compiler_jobs}}
    if a.calibration_method == 'max':
        config['calibration_parameters']['quant_config']['model_config']['activation'] = {'calibration_type':'max'}
    path=run/'candidate.yaml'; path.write_text(json.dumps(config,indent=2))
    if a.prepare_only:
        entry['state']='prepared_not_started'; save(); print(name,'prepared',flush=True)
        continue
    entry['state']='compiling'; save(); print(name,'compiling',flush=True)
    with (run/'compile.log').open('w') as log:
        result=subprocess.run(['timeout','21600','hb_compile','--config',str(path)],cwd=run,
                              stdout=log,stderr=subprocess.STDOUT)
    entry.update(exit_code=result.returncode,finished_unix=time.time(),
                 state='compiled_needs_validation' if result.returncode==0 else 'compile_failed',
                 hbm_files=[str(x) for x in run.rglob('*.hbm')])
    save(); print(json.dumps(entry),flush=True)
