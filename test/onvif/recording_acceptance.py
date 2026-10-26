#!/usr/bin/env python3
"""Exercise the actual AINVR recorder pipeline against an ephemeral SRS stream."""
import argparse
import asyncio
import json
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'recording-service/src'))
sys.path.insert(0,str(ROOT/'shared/python'))
from recorder.recording_pipeline import RecordingPipeline
from recorder.storage_io import IsolatedIO

async def record(args):
    import re
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}/[a-zA-Z0-9_-]{1,128}',args.stream):raise ValueError('Invalid fixture stream')
    args.result.mkdir(parents=True,exist_ok=False)
    io=IsolatedIO()
    events=[]
    pipeline=RecordingPipeline(channel_id='onvif-recorder-fixture',rtmp_url='rtmp://127.0.0.1:1935/'+args.stream,root=str(args.result),segment_seconds=3,io=io,soft_cap=4<<20,hard_cap=16<<20,codec='h265' if args.codec=='hevc' else 'h264',on_event=events.append)
    try:
        await pipeline.start()
        await asyncio.sleep(12)
    finally:
        stopped=await pipeline.stop()
        io.shutdown()
    assert stopped and not pipeline.error, 'recorder_pipeline_failed'
    files=list(args.result.rglob('*.mp4'))
    assert files, 'recorder_no_segments'
    segments=[]
    for path in files:
        data=json.loads(subprocess.check_output(['/opt/ainvr/ffmpeg-8.1.2/bin/ffprobe','-v','error','-show_entries','stream=codec_name,codec_type,duration','-show_entries','format=duration','-of','json',str(path)],timeout=5))
        video=next(s for s in data['streams'] if s['codec_type']=='video')
        audio=next((s for s in data['streams'] if s['codec_type']=='audio'),None)
        assert video['codec_name']==args.codec
        assert (audio is not None)==args.audio
        if audio: assert audio['codec_name']=='aac'
        segments.append({'name':path.name,'bytes':path.stat().st_size,'duration':float(data['format']['duration']),'audio':audio['codec_name'] if audio else None})
    result={'passed':True,'actual_recorder_pipeline':True,'segments':segments,'stats':pipeline.stats()}
    (args.result/'report.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--result',type=Path,required=True)
    parser.add_argument('--codec',choices=['h264','hevc'],required=True)
    parser.add_argument('--audio',action='store_true')
    parser.add_argument('--stream',default='live/onvif_acceptance')
    asyncio.run(record(parser.parse_args()))
