#!/usr/bin/env python3
"""AINVR bounded CPU ONNX execution check, not BPU compilation or accuracy."""
import argparse,json,time
from pathlib import Path
import numpy as np
import onnxruntime as ort
p=argparse.ArgumentParser();p.add_argument('model');p.add_argument('--output',type=Path,required=True);a=p.parse_args()
report={'model':a.model,'provider':'CPUExecutionProvider','accuracy_verified':False}
try:
    options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
    session=ort.InferenceSession(a.model,sess_options=options,providers=['CPUExecutionProvider'])
    feed={}
    for x in session.get_inputs():
        if any(not isinstance(d,int) or d<=0 for d in x.shape):raise ValueError('Dynamic input needs explicit shape: '+x.name+str(x.shape))
        dtype={'tensor(float)':np.float32,'tensor(float16)':np.float16,'tensor(int64)':np.int64,'tensor(int32)':np.int32}.get(x.type)
        if dtype is None:raise ValueError('Unsupported test dtype '+x.type)
        feed[x.name]=np.zeros(x.shape,dtype=dtype)
    start=time.perf_counter();outputs=session.run(None,feed)
    report['elapsed_seconds']=time.perf_counter()-start
    report['outputs']=[{'name':x.name,'shape':list(y.shape),'finite':bool(np.isfinite(y).all()),'min':float(y.min()) if y.size else None,'max':float(y.max()) if y.size else None} for x,y in zip(session.get_outputs(),outputs)]
    report['status']='PASS' if all(x['finite'] for x in report['outputs']) else 'NONFINITE'
except Exception as e:report['status']='FAIL';report['error']=str(e)
a.output.write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report,indent=2))
raise SystemExit(0 if report['status']=='PASS' else 1)
