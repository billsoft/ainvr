#!/usr/bin/env python3
"""AINVR: actual uploaded six-column ONNX detection outputs, no NPU claim."""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess
import numpy as np
import onnxruntime as ort
ROOT=Path(__file__).resolve().parents[2]

def main():
    folder=ROOT/'test/results'/('end2end-decode-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    folder.mkdir(parents=True,exist_ok=False);report=[]
    image=np.random.default_rng(947).uniform(0,1,(1,3,640,640)).astype(np.float32)
    for name in ('yolo26m.onnx','yolo26x-face.onnx','yolov12m-face.onnx','yoloe-26x-seg.onnx'):
        model=ROOT/'ai-service/models'/name;before=hashlib.sha256(model.read_bytes()).hexdigest()
        options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
        session=ort.InferenceSession(str(model),sess_options=options,providers=['CPUExecutionProvider'])
        outputs=session.run(None,{session.get_inputs()[0].name:image});assert len(outputs)==1
        tensor=outputs[0];assert tensor.shape==(1,300,6),tensor.shape
        rows=tensor[0];assert np.isfinite(rows).all()
        classes=[str(i) for i in range(80)] if name=='yolo26m.onnx' else ['face' if 'face' in name else 'adult woman']
        positive=rows[rows[:,4]>0,4]
        # Embedded NMS may correctly suppress all detections on random input.
        # Preserve this result; never fabricate positive detections for parity.
        threshold=float(np.quantile(positive,.8)) if positive.size else .25
        payload={'decoder':'end2end','source_width':1280,'source_height':720,'input_width':640,'input_height':640,
          'confidence':threshold,'maximum':20,'classes':classes,
          'outputs':[{'name':session.get_outputs()[0].name,'shape':list(tensor.shape),'values':tensor.reshape(-1).tolist()}]}
        fixture=folder/(name+'.json');fixture.write_text(json.dumps(payload),encoding='utf-8')
        process=subprocess.run([str(ROOT/'out/build/ai-s100p/ainvr_decode_detections'),str(fixture)],capture_output=True,text=True,check=True,timeout=30)
        actual=json.loads(process.stdout);expected=rows[rows[:,4]>=threshold];expected=expected[np.argsort(-expected[:,4],kind='stable')][:20]
        assert len(actual)==len(expected)
        maximum=0.
        for got,want in zip(actual,expected):
            box=np.clip((want[:4].astype(np.float64)-[0,140,0,140])/.5,[0,0,0,0],[1280,720,1280,720]);box[2:]-=box[:2]
            delta=float(np.max(np.abs(np.array(got['bbox'])-box)));maximum=max(maximum,delta)
            assert delta<.001 and abs(got['confidence']-float(want[4]))<1e-7
            assert got['class_id']==int(want[5]) and got['class_name']==classes[int(want[5])] and got['landmarks'] is None
        assert hashlib.sha256(model.read_bytes()).hexdigest()==before
        item={'model':name,'sha256':before,'detections_compared':len(actual),'coverage':'nonempty numeric parity' if actual else 'empty output only','max_box_error':maximum,'status':'PASS'}
        report.append(item);print(json.dumps(item),flush=True)
        del session
    (folder/'report.json').write_text(json.dumps({'scope':'CPU ONNX + native six-column decoder, synthetic input; YOLOE file is fixed detection only, not segmentation or dynamic prompts','models':report},indent=2)+'\n',encoding='utf-8')
    print(folder)
if __name__=='__main__':main()
