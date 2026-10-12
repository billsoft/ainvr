#!/usr/bin/env python3
"""Create a calibrated YOLO26 experiment configuration, not a production HBM."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

ROOT=Path(__file__).resolve().parents[2]
MODEL_SOURCES=Path('/mnt/ainvr-ssd/model-sources/ainvr-20261012/models')

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('calibration_summary',type=Path)
    parser.add_argument('new_output',type=Path)
    parser.add_argument('--model',type=Path,default=MODEL_SOURCES/'yolo26m.onnx')
    args=parser.parse_args()
    assert ROOT.resolve()==Path('/home/sunrise/ainvr')
    assert Path('/mnt/ainvr-ssd').is_mount()
    summary=json.loads(args.calibration_summary.read_text())
    assert summary['passed'] and summary['seed_only']
    assert summary['tensor_shape']==[1,3,640,640] and summary['input_name']=='images'
    model=args.model.resolve(strict=True)
    assert digest(model)==summary['model_sha256']
    data=Path(summary['data_directory']).resolve()
    assert data.is_relative_to(Path('/mnt/ainvr-ssd/model-calibration'))
    samples=summary['samples'];assert samples
    names=set()
    for sample in samples:
        name=sample['file'];assert Path(name).name==name and name not in names
        names.add(name)
        path=data/name
        assert path.is_file() and path.stat().st_size==1*3*640*640*4
        assert digest(path)==sample['sha256']
    assert {p.name for p in data.iterdir() if p.is_file()}==names
    output=args.new_output.resolve()
    assert output.is_relative_to(Path('/mnt/ainvr-ssd')) and not output.exists()
    output.mkdir(parents=True)
    # JSON is also valid YAML. Featuremap passthrough preserves the already
    # normalized RGB/NCHW tensors; there is no second mean/scale transformation.
    config={'model_parameters':{'onnx_model':str(model),'march':'nash-m',
                'output_model_file_prefix':'yolo26m_calibrated_seed','working_dir':'./model_output'},
            'input_parameters':{'input_name':'images','input_shape':'1x3x640x640',
                'input_type_train':'featuremap','input_type_rt':'featuremap','input_layout_train':'NCHW'},
            'calibration_parameters':{'cal_data_dir':str(data)},
            'compiler_parameters':{'compile_mode':'latency','optimize_level':'O2','jobs':2}}
    (output/'candidate.yaml').write_text(json.dumps(config,indent=2)+'\n')
    report={'prepared':True,'hbm_compiled':False,'compiler_configuration_verified':False,
            'toolchain_available':shutil.which('hb_compile') is not None,
            'samples':len(samples),'seed_only':True,'representative_dataset_accepted':False,
            'production_model_manifest_created':False,'model_sha256':summary['model_sha256'],
            'source_calibration_summary':str(args.calibration_summary.resolve()),
            'compile_config':str(output/'candidate.yaml'),
            'required_toolchain_mounts':[str(ROOT),'/mnt/ainvr-ssd'],
            'remaining_gates':['official compiler parsing and operator placement',
                'representative calibration coverage','SDK tensor contract inspection',
                'BPU output and accuracy comparison','real recognition/archive/SEI/browser acceptance'],
            'official_reference':'https://toolchain.d-robotics.cc/guide/ptq/ptq_tool/hb_compile/convert.html'}
    (output/'preparation.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))

if __name__=='__main__':
    main()
