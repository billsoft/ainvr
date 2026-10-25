import json, subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[2]
for path in (root/'test/results/gb28181/lan-probe').glob('*/recording.mp4'):
    data=json.loads(subprocess.check_output([str(root/'out/gb28181/ffmpeg-runtime/bin/ffprobe'),'-v','error','-show_streams','-show_packets','-of','json',str(path)],timeout=10))
    tracks=[]
    for stream in data['streams']:
        packets=[p for p in data['packets'] if p['stream_index']==stream['index'] and 'dts_time' in p]
        dts=[float(p['dts_time']) for p in packets]
        gaps=[b-a for a,b in zip(dts,dts[1:])]
        assert dts and min(gaps)>=0 and max(gaps)<.5,(path,stream['codec_type'],'timestamp discontinuity')
        assert float(stream['duration'])>=43,(path,'short recording')
        tracks.append({'codec':stream['codec_name'],'duration':stream['duration'],'packets':len(packets),'maxDtsGap':round(max(gaps),5)})
    assert {t['codec'] for t in tracks}=={'h264','aac'}
    report={'passed':True,'recording':str(path),'tracks':tracks,'scope':'container timestamps and codecs, not perceptual AV sync or real-camera accuracy'}
    (path.parent/'recording-validation.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report))
