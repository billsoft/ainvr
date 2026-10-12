#!/usr/bin/env python3
"""AINVR bounded native VPU/PYM/GLES -> ONNX CPU -> detection integration."""
from pathlib import Path
import datetime
import json
import os
import subprocess
ROOT=Path(__file__).resolve().parents[2]

def main():
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    work=ROOT/'test/runtime'/('native-pipeline-'+stamp);work.mkdir(parents=True,exist_ok=False)
    out=ROOT/'test/results'/('native-pipeline-'+stamp);out.mkdir(parents=True,exist_ok=False)
    env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib:'+str(ROOT/'out/deps/onnxruntime-1.23.2/lib'))
    video=work/'source.h264'
    subprocess.run(['/usr/bin/ffmpeg','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=1920x1080:rate=15',
                    '-frames:v','3','-c:v','libx264','-threads','2','-preset','ultrafast','-bf','0','-f','h264',str(video)],check=True,timeout=45)
    classes=work/'classes.json';classes.write_text(json.dumps([str(i) for i in range(80)]))
    models=[('scrfd','derived/s100p/scrfd_10g_kps_640.onnx'),('end2end','yolo26m.onnx')]
    summary=[]
    for decoder,name in models:
        output=out/(decoder+'.json')
        with (out/(decoder+'.log')).open('w') as log:
            subprocess.run([str(ROOT/'out/build/ai-s100p/ainvr_pipeline_probe'),str(ROOT/'ai-service/models'/name),str(video),decoder,'3',str(output),str(classes)],
                           env=env,stdout=log,stderr=subprocess.STDOUT,timeout=120,check=True)
        result=json.loads(output.read_text());assert result['model_provider']=='cpu'
        frames=result['frames'];assert len(frames)==3
        assert len({f['decode_packet_token'] for f in frames})==3
        for f in frames:
            assert (f['frame_width'],f['frame_height'])==(1920,1080)
            assert f['decode_backend']=='vpu-jpu' and f['preprocess_backend']=='pym+gles-color'
            assert f['model']['provider']=='cpu' and f['model']['format']=='onnx'
            assert not f['fallback_reasons'] and f['timing_ms']['inference']>0
            for d in f['detections']:
                b=d['bbox'];assert 0<=b['x']<=1920 and 0<=b['y']<=1080 and b['w']>=0 and b['h']>=0
        summary.append({'model':name,'frames':len(frames),'detections':[len(f['detections']) for f in frames],
                        'inference_ms':[f['timing_ms']['inference'] for f in frames],
                        'preprocess_ms':[f['timing_ms']['preprocess'] for f in frames]})
    (out/'summary.json').write_text(json.dumps({'status':'PASS','scope':'native offline pipeline; CPU inference, no live service/NPU/accuracy claim','models':summary},indent=2)+'\n')
    print(json.dumps(summary));print(out)
if __name__=='__main__':main()
