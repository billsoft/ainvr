#!/usr/bin/env python3
"""Sequential bounded media acceptance; no production camera settings are changed."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[2]
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures',type=Path,required=True,help='Distinctive-audio reference fixture directory')
    parser.add_argument('--host',required=True)
    parser.add_argument('--interface',required=True)
    parser.add_argument('--result',type=Path,required=True)
    args=parser.parse_args();args.result.mkdir(parents=True,exist_ok=False)
    env={**os.environ,'INGEST_FFMPEG':str(ROOT/'out/media-bridge/runtime/bin/ffmpeg'),'INGEST_FFPROBE':str(ROOT/'out/media-bridge/runtime/bin/ffprobe')}
    samples={codec:args.fixtures/(codec+'.mp4') for codec in ['h264','hevc']}
    cases=[]
    for codec,sample in samples.items():
        for audio in ['aac','alaw','mulaw','g726','g726le','silent']:
            name=codec+'-'+audio;target=args.result/name
            command=[sys.executable,str(ROOT/'test/onvif/media_acceptance.py'),'--host',args.host,'--sample',str(sample),'--audio',audio,'--result',str(target)]
            if codec=='h264' and audio=='aac':command+=['--interface',args.interface]
            if (codec,audio) in [('h264','alaw'),('hevc','aac')]:command+=['--recorder']
            with (args.result/(name+'.log')).open('wb') as handle:
                code=subprocess.call(command,env=env,stdout=handle,stderr=handle)
            report=json.loads((target/'report.json').read_text()) if (target/'report.json').exists() else {'passed':False,'error':'no_report'}
            cases.append({'case':name,'exit':code,**report})
            (args.result/'report.json').write_text(json.dumps({'passed':all(c['passed'] and c['exit']==0 for c in cases),'completed':len(cases),'cases':cases},indent=2)+'\n')
            print(name,code,report.get('passed'),flush=True)
    raise SystemExit(0 if all(c['passed'] and c['exit']==0 for c in cases) else 1)
if __name__=='__main__':main()
