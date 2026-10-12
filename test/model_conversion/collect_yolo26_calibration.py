#!/usr/bin/env python3
"""Prepare bounded real-camera YOLO26 calibration seeds; never claim HBM acceptance."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import pwd
import subprocess

ROOT=Path(__file__).resolve().parents[2]

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    import onnx
    import numpy as np
    parser=argparse.ArgumentParser()
    parser.add_argument('--samples',type=int,default=20)
    parser.add_argument('--interval-ms',type=int,default=500)
    parser.add_argument('--source',default='rtmp://127.0.0.1:1935/live/xm')
    parser.add_argument('--model',type=Path,default=Path('/mnt/ainvr-ssd/model-export/yolo26x-20261012-v3/yolo26x.onnx'))
    args=parser.parse_args()
    assert ROOT.resolve()==Path('/home/sunrise/ainvr') and os.geteuid()==0
    assert Path('/mnt/ainvr-ssd').is_mount()
    assert 1<=args.samples<=60 and 200<=args.interval_ms<=1000
    model=args.model.resolve(strict=True)
    assert model.is_relative_to(Path('/mnt/ainvr-ssd')), 'Source/export model must stay on SSD'
    original_sha=digest(model)
    graph=onnx.load(str(model))
    onnx.checker.check_model(graph,full_check=True)
    initializers={t.name for t in graph.graph.initializer}
    inputs=[t for t in graph.graph.input if t.name not in initializers]
    assert len(inputs)==1
    inp=inputs[0]
    shape=[d.dim_value for d in inp.type.tensor_type.shape.dim]
    assert shape==[1,3,640,640] and inp.type.tensor_type.elem_type==onnx.TensorProto.FLOAT
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+str(os.getpid())
    result=ROOT/'test/results'/('yolo26-calibration-'+stamp);result.mkdir()
    parent=Path('/mnt/ainvr-ssd/model-calibration')/result.name;parent.mkdir(parents=True)
    assert parent.resolve().is_relative_to(Path('/mnt/ainvr-ssd'))
    user=subprocess.check_output(['systemctl','show','ainvr-ai','-p','User','--value'],
                                 text=True,timeout=5).strip()
    account=pwd.getpwnam(user)
    os.chown(parent,account.pw_uid,account.pw_gid)
    os.chmod(parent,0o700)
    dataset=parent/'capture'
    spec={'source_url':args.source,'count':args.samples,'interval_ms':args.interval_ms,
          'input_size':[640,640],'letterbox':True,'nearest':False,'bgr':False,
          'mean':[0,0,0],'divisor':[255,255,255],'padding':[114,114,114],
          'model_sha256':original_sha,'model_input_name':inp.name}
    spec_path=parent/'capture-spec.json';spec_path.write_text(json.dumps(spec,indent=2));spec_path.chmod(0o600)
    os.chown(spec_path,account.pw_uid,account.pw_gid)
    build=ROOT/'out/build/ai-ffmpeg8'
    protected=[ROOT/'deploy/s100p/bin/ainvr_ai_service',ROOT/'data/ai/config_overlay.json',
               ROOT/'data/recorder/config.json',model]
    protected_shas={str(p):digest(p) for p in protected}
    with (result/'build.log').open('w') as log:
        subprocess.run(['cmake','-S',str(ROOT/'ai-service'),'-B',str(build),
                        '-DAINVR_S100P=ON','-DBUILD_TESTING=ON'],stdout=log,
                       stderr=subprocess.STDOUT,check=True,timeout=60)
        subprocess.run(['cmake','--build',str(build),'--target','ainvr_calibration_capture','-j2'],
                       stdout=log,stderr=subprocess.STDOUT,check=True,timeout=180)
    # A failed capture must never overwrite a directory supplied by an operator.
    sentinel=parent/'existing-output';sentinel.mkdir();os.chown(sentinel,account.pw_uid,account.pw_gid)
    marker=sentinel/'capture.json';marker.write_text('AINVR existing data must survive')
    before_marker=digest(marker)
    with (result/'overwrite-rejection.log').open('w') as log:
        rejected=subprocess.run(['runuser','-u',user,'--',str(build/'ainvr_calibration_capture'),
                                 str(spec_path),str(sentinel)],stdout=log,stderr=subprocess.STDOUT,
                                timeout=10)
    assert rejected.returncode!=0 and digest(marker)==before_marker
    with (result/'capture.log').open('w') as log:
        subprocess.run(['runuser','-u',user,'--',str(build/'ainvr_calibration_capture'),
                        str(spec_path),str(dataset)],env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib'),
                       stdout=log,stderr=subprocess.STDOUT,check=True,timeout=100)
    capture=json.loads((dataset/'capture.json').read_text())
    assert capture['passed'] and len(capture['samples'])==args.samples
    assert capture['tensor']=={'dtype':'float32_le','layout':'NCHW','shape':shape,'header_bytes':0}
    rows=[];pts=[]
    for sample in capture['samples']:
        path=dataset/'data_f32'/sample['file']
        assert path.stat().st_size==3*640*640*4==sample['bytes']
        assert digest(path)==sample['sha256']
        tensor=np.fromfile(path,dtype='<f4').reshape(shape)
        assert np.isfinite(tensor).all() and tensor.min()>=-1e-4 and tensor.max()<=1.0001
        assert sample['backend'] in ('gles','pym+gles-color')
        assert (sample['source_width'],sample['source_height'])==(3840,1920)
        # Independent format/padding check, not a CPU image transformation.
        assert np.max(np.abs(tensor[0,:,0,:]-114/255))<.003
        assert float(tensor[0,:,160:480,:].std())>.001
        pts.append(sample['pts_ns'])
        rows.append({'file':sample['file'],'sha256':sample['sha256'],
                     'backend':sample['backend'],'minimum':float(tensor.min()),
                     'maximum':float(tensor.max())})
    assert all(b>a for a,b in zip(pts,pts[1:]))
    assert {str(p):digest(p) for p in protected}==protected_shas
    report={'passed':True,'purpose':'real-camera seed collection and format validation',
            'samples':rows,'capture_report':str(dataset/'capture.json'),
            'data_directory':str(dataset/'data_f32'),'bytes':len(rows)*3*640*640*4,
            'execution_user':user,'model_sha256':original_sha,'input_name':inp.name,
            'tensor_shape':shape,'source_dimensions':[3840,1920],
            'production_files_unchanged':True,'seed_only':True,'hbm_compiled':False,
            'existing_output_overwrite_rejected':True,
            'representative_dataset_accepted':False,'user_model_accuracy_verified':False,
            'cpu_image_processing':False,'cpu_decode':False,
            'capture_source_sha256':digest(ROOT/'test/model_conversion/calibration_capture.cpp')}
    (result/'summary.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!='samples'},indent=2),flush=True)
    print('RESULT',result,flush=True)

if __name__=='__main__':
    main()
