#!/usr/bin/env python3
"""AINVR: prepare a separate static SCRFD ONNX candidate, leaving source intact."""
from pathlib import Path
import hashlib,json,os
import onnx
root=Path(__file__).resolve().parents[2]
model_sources=Path('/mnt/ainvr-ssd/model-sources/ainvr-20261012/models')
if not Path('/mnt/ainvr-ssd').is_mount():raise SystemExit('Model sources require mounted SSD')
source=model_sources/'scrfd_10g_kps.onnx'
output=Path('/mnt/ainvr-ssd/model-export/scrfd_10g_kps_640.onnx')
if output.exists():raise SystemExit('Output already exists; inspect it before replacing')
before=hashlib.sha256(source.read_bytes()).hexdigest();model=onnx.load(str(source))
if len(model.graph.input)!=1:raise ValueError('Unexpected SCRFD inputs')
shape=model.graph.input[0].type.tensor_type.shape
if len(shape.dim)!=4:raise ValueError('Unexpected SCRFD input rank')
for dim,value in zip(shape.dim,[1,3,640,640]):dim.ClearField('dim_param');dim.dim_value=value
onnx.checker.check_model(model,full_check=True)
output.parent.mkdir(parents=True,exist_ok=True);temporary=output.with_suffix('.tmp')
onnx.save(model,str(temporary));os.replace(temporary,output)
assert hashlib.sha256(source.read_bytes()).hexdigest()==before
report={'source':str(source),'source_sha256':before,'candidate':str(output),'candidate_sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'input_shape':[1,3,640,640],'status':'ONNX checker passed; HBM compilation not performed'}
(root/'test/results/model-audit-20261011/scrfd-preparation.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
