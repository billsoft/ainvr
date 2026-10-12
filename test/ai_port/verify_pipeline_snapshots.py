#!/usr/bin/env python3
"""Real uploaded YOLO model -> detected-object crops on a bounded board sample video."""
from pathlib import Path
import datetime,hashlib,json,os,subprocess
ROOT=Path(__file__).resolve().parents[2]
out=ROOT/'test/results'/('pipeline-snapshots-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'));out.mkdir()
source=Path('/app/res/assets/bus.jpg')
assert source.is_file(),'Board sample image is required'
video=out/'source.mp4'
subprocess.run(['/usr/bin/ffmpeg','-v','error','-loop','1','-i',str(source),'-vf','scale=800:1080','-r','10','-frames:v','2','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-bf','0',str(video)],check=True,timeout=45)
classes=out/'classes.json';classes.write_text(json.dumps([str(i) for i in range(80)]))
env=dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib:'+str(ROOT/'out/deps/onnxruntime-1.23.2/lib'))
summary=[]
for mode in ['none','erp_equirect']:
    report=out/(mode+'.json');images=out/(mode+'-images')
    with (out/(mode+'.log')).open('w') as log:
        subprocess.run([str(ROOT/'out/build/ai-s100p/ainvr_pipeline_probe'),str(ROOT/'ai-service/models/yolo26m.onnx'),str(video),'end2end','2',str(report),str(classes),str(images),mode],check=True,timeout=120,env=env,stdout=log,stderr=subprocess.STDOUT)
    frames=json.loads(report.read_text())['frames'];assert len(frames)==2
    assert [f['source_pts_ns'] for f in frames]==[0,100000000]
    count=0
    for frame in frames:
        assert frame['detections'],'Nonempty real model detections required'
        assert len(frame['snapshots'])==len(frame['detections'])
        for i,crop in enumerate(frame['snapshots']):
            assert crop['detection_index']==i and crop['projection']==mode
            path=images/crop['file'];assert path.is_file()
            meta=json.loads(subprocess.check_output(['/usr/bin/ffprobe','-v','error','-show_entries','stream=width,height','-of','json',str(path)],text=True,timeout=15))['streams'][0]
            assert (meta['width'],meta['height'])==(crop['width'],crop['height'])
            decoded=subprocess.run(['/usr/bin/ffmpeg','-v','error','-i',str(path),'-f','null','-'],check=True,capture_output=True,timeout=15)
            assert not decoded.stderr,decoded.stderr
            count+=1
    assert len(list(images.glob('*.jpg')))==count
    summary.append(dict(mode=mode,frames=2,snapshots=count,per_frame=[len(f['detections']) for f in frames],snapshot_ms=[f['snapshot_ms'] for f in frames]))
(out/'summary.json').write_text(json.dumps(dict(passed=True,runs=summary,source=str(source),source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),scope='Real YOLO CPU inference and VPU decoded-frame snapshots; ERP switch exercised on ordinary image, not ERP accuracy; no archive/live/NPU claim'),indent=2))
print(out/'summary.json')
