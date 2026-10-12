#!/usr/bin/env python3
"""AINVR: real uploaded ONNX outputs compared with native SCRFD decoding."""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess
import numpy as np
import onnxruntime as ort
ROOT=Path(__file__).resolve().parents[2]

def reference(outputs,threshold):
    heads={(int(a.shape[-2]),int(a.shape[-1])):a.reshape(a.shape[-2:]) for a in outputs}
    boxes=[];scores=[];points=[]
    for stride in (8,16,32):
        side=640//stride;n=side*side*2
        centers=np.stack(np.meshgrid(np.arange(side),np.arange(side)),axis=-1).reshape(-1,2)
        centers=np.repeat(centers,2,axis=0)*stride
        select=heads[n,1][:,0]>=threshold
        c=centers[select].astype(np.float64);b=heads[n,4][select].astype(np.float64)*stride
        boxes.append(np.concatenate((c-b[:,:2],c+b[:,2:]),axis=1));scores.append(heads[n,1][select,0])
        points.append(heads[n,10][select].reshape(-1,5,2).astype(np.float64)*stride+c[:,None,:])
    b=np.concatenate(boxes);s=np.concatenate(scores);p=np.concatenate(points)
    order=np.argsort(-s,kind='stable');keep=[]
    while order.size:
        i=order[0];keep.append(i);rest=order[1:]
        minimum=np.maximum(b[i,:2],b[rest,:2]);maximum=np.minimum(b[i,2:],b[rest,2:])
        intersection=np.prod(np.maximum(0,maximum-minimum),axis=1)
        area=np.prod(np.maximum(0,b[:,2:]-b[:,:2]),axis=1)
        union=area[i]+area[rest]-intersection
        iou=np.divide(intersection,union,out=np.zeros_like(intersection),where=union>0)
        order=rest[iou<=.45]
    result=[]
    # Source 1280x720 -> 640x640 letterbox: scale=.5, top=140.
    for i in keep[:20]:
        xyxy=(b[i]-[0,140,0,140])/.5
        xyxy=np.clip(xyxy,[0,0,0,0],[1280,720,1280,720])
        result.append({'confidence':float(s[i]),'bbox':[xyxy[0],xyxy[1],xyxy[2]-xyxy[0],xyxy[3]-xyxy[1]],'landmarks':((p[i]-[0,140])/.5).tolist()})
    return result

def main():
    folder=ROOT/'test/results'/('scrfd-decode-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    folder.mkdir(parents=True,exist_ok=False)
    model=ROOT/'ai-service/models/derived/s100p/scrfd_10g_kps_640.onnx'
    before=hashlib.sha256(model.read_bytes()).hexdigest()
    options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
    session=ort.InferenceSession(str(model),sess_options=options,providers=['CPUExecutionProvider'])
    rng=np.random.default_rng(731);image=rng.uniform(-1,1,(1,3,640,640)).astype(np.float32)
    outputs=session.run(None,{session.get_inputs()[0].name:image})
    scores=np.concatenate([a.reshape(-1) for a in outputs if a.shape[-1]==1])
    threshold=float(np.quantile(scores,.998))
    payload={'decoder':'scrfd','source_width':1280,'source_height':720,'input_width':640,'input_height':640,'confidence':threshold,'iou':.45,'maximum':20,
      'outputs':[{'name':meta.name,'shape':list(a.shape),'values':a.reshape(-1).tolist()} for meta,a in zip(session.get_outputs(),outputs)]}
    payload['outputs'].reverse() # Model-output order is deliberately shuffled.
    fixture=folder/'outputs.json';fixture.write_text(json.dumps(payload),encoding='utf-8')
    native=subprocess.run([str(ROOT/'out/build/ai-s100p/ainvr_decode_detections'),str(fixture)],capture_output=True,text=True,check=True,timeout=30)
    actual=json.loads(native.stdout);expected=reference(outputs,threshold)
    assert len(actual)==len(expected)>0,(len(actual),len(expected))
    maximum=0.
    for got,want in zip(actual,expected):
        for key in ('confidence','bbox','landmarks'):
            delta=float(np.max(np.abs(np.asarray(got[key])-np.asarray(want[key]))));maximum=max(maximum,delta)
            assert delta<.001,(key,delta)
    assert hashlib.sha256(model.read_bytes()).hexdigest()==before
    report={'status':'PASS','model_sha256':before,'detections_compared':len(actual),'max_absolute_error':maximum,'threshold':threshold,
            'scope':'ONNX Runtime CPU inference plus native SCRFD output decoder; synthetic input, not accuracy or BPU validation'}
    (folder/'native.json').write_text(native.stdout,encoding='utf-8')
    (folder/'report.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report));print(folder)
if __name__=='__main__':main()
