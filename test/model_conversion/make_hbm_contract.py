"""AINVR create a candidate model contract from actual SDK tensor metadata.

This records an interface; it does not certify accuracy or deploy the model.
"""
import argparse
import hashlib
import json
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--model',type=Path,required=True)
p.add_argument('--description',type=Path,required=True)
p.add_argument('--placement',type=Path,required=True)
p.add_argument('--kind',choices=['coco80','face','gpen256'],required=True)
p.add_argument('--export-summary',type=Path)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args(); assert not a.output.exists()
digest=hashlib.sha256(a.model.read_bytes()).hexdigest()
text=a.description.read_text()
# The SDK emits its version banner before the probe's JSON on stdout.
lines=text.splitlines()
start=next(i for i,line in enumerate(lines) if line.strip()=='{')
d,_=json.JSONDecoder().raw_decode('\n'.join(lines[start:]).lstrip())
placement=json.loads(a.placement.read_text())
assert placement['hbm_sha256']==digest and placement['placement_passed']
assert d['provider']=='bpu' and d['format']=='hbm'
assert len(d['inputs'])==len(d['outputs'])==1
size=256 if a.kind=='gpen256' else 640
assert d['inputs'][0]['shape']==[1,3,size,size]
# HB_DNN_TENSOR_TYPE_F32 == 7 in the inspected S100P SDK hb_dnn.h.
assert all(t['dtype_id']==7 and t['quantization']==0 for t in [d['inputs'][0],d['outputs'][0]])
record={'schema_version':1,'target':'rdk_s100p','hbm_sha256':digest,
        'input_size':[size,size],'inputs':d['inputs'],'outputs':d['outputs'],
        'placement_report_sha256':hashlib.sha256(a.placement.read_bytes()).hexdigest(),
        'accuracy_verified':False,'production_approved':False}
if a.kind=='gpen256':
    assert d['outputs'][0]['shape']==[1,3,256,256]
    record.update(adapter='gpen_bpu',role='face_restoration',
                  input_contract='float_nchw_rgb_minus1_1_cubic_gray128',
                  output_contract='float_nchw_rgb_minus1_1')
else:
    assert d['outputs'][0]['shape']==[1,300,6]
    names=['face']
    if a.kind=='coco80':
        assert a.export_summary
        export=json.loads(a.export_summary.read_text())
        assert export['passed'] and export['source_unchanged']
        names=export['class_names']; assert len(names)==80 and names[0]=='person'
        record['reference_onnx_sha256']=export['onnx_sha256']
    record.update(adapter='yolo26_bpu' if a.kind=='coco80' else 'yoloface_bpu',
                  input_contract='float_nchw',output_contract='end2end_xyxy_score_class',
                  class_names=names,preprocess={'rgb_order':True,'normalize':True,
                                              'mean':[0,0,0],'std':[255,255,255]})
a.output.write_text(json.dumps(record,indent=2)+'\n')
print('Candidate interface contract created; validation still required')
