"""AINVR offline FP32 reference outputs for independent validation only."""
import argparse
import hashlib
import json
import time
from pathlib import Path
import numpy as np
import onnxruntime as ort

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--root',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args(); a.output.mkdir(parents=True,exist_ok=False)
specs=[('yolo26x','yolo26x.onnx','coco-calibration-512-v2/validation'),
       ('yolo26x-face','yolo26x-face-op17.onnx','celeba-calibration-512/face/validation'),
       ('gpen256','gpen256.onnx','celeba-calibration-512/gpen256/validation')]
for name,model,dataset in specs:
    model_path=a.root/'models'/model
    options=ort.SessionOptions(); options.intra_op_num_threads=4; options.inter_op_num_threads=1
    session=ort.InferenceSession(str(model_path),options,providers=['CPUExecutionProvider'])
    inp=session.get_inputs()[0]; out=a.output/name; out.mkdir()
    report={'model':name,'reference_only':True,'production_cpu_inference':False,
            'onnx_sha256':hashlib.sha256(model_path.read_bytes()).hexdigest(),
            'input_name':inp.name,'shape':inp.shape,'samples':[]}
    files=sorted((a.root/dataset).glob('*.bin')); assert len(files)==128
    for i,path in enumerate(files):
        data=np.fromfile(path,dtype='<f4').reshape(inp.shape)
        start=time.monotonic(); values=session.run(None,{inp.name:data})
        assert all(np.isfinite(v).all() for v in values),path
        np.savez_compressed(out/(path.stem+'.npz'),**{str(j):v for j,v in enumerate(values)})
        report['samples'].append({'id':path.stem,'input_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                                  'seconds':time.monotonic()-start,'output_shapes':[list(v.shape) for v in values]})
        if i%16==0: print(name,i,flush=True)
    (out/'manifest.json').write_text(json.dumps(report,indent=2))
    print(name,'128 reference outputs ready',flush=True)
