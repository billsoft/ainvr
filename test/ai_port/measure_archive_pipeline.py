#!/usr/bin/env python3
"""Read-only bounded live archive audit; explicit channel and new evidence file."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import subprocess
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--channel-id', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=120)
    args = parser.parse_args()
    if args.output.exists() or not 10 <= args.seconds <= 600:
        parser.error('Use a new output file and a duration of 10..600 seconds')
    root = Path('/home/sunrise/ainvr')
    config = json.loads((root/'deploy/s100p/runtime/ai-service.json').read_text())

    def read(path):
        request = urllib.request.Request('http://127.0.0.1:8000'+path,
            headers={'x-api-key': config['server']['api_key']})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    def hardware_counter(path):
        try:
            return Path(path).read_text().strip()[:256]
        except OSError:
            return None

    samples = []
    configs = []
    for i in range(args.seconds//5+1):
        if i:
            time.sleep(5)
        channel = next(c for c in read('/api/v1/channels')['channels'] if c['id']==args.channel_id)
        archive = read('/api/v1/channels/'+args.channel_id+'/snapshots/overview')['archive_stats']
        pid = subprocess.check_output(['systemctl','show','ainvr-ai','-p','MainPID','--value'], text=True).strip()
        rss = int(next(line.split()[1] for line in Path('/proc/'+pid+'/status').read_text().splitlines() if line.startswith('VmRSS:')))
        configs.append(hashlib.sha256(json.dumps(channel['config'],sort_keys=True).encode()).hexdigest())
        samples.append({'time':time.monotonic(),'pid':pid,'rss_kib':rss,
            'gpu_dvfs':hardware_counter('/sys/kernel/debug/mali0/dvfs_utilization'),
            'jpu_loading':hardware_counter('/sys/kernel/debug/jpu/loading'),
            'bpu':float(Path('/sys/devices/system/bpu/ratio').read_text().strip().replace('%','')),
            'worker':channel['stats'],'archive':archive})
    first,last=samples[0],samples[-1]
    seconds=last['time']-first['time']
    continuous=len(set(configs))==1 and len({s['pid'] for s in samples})==1
    continuous=continuous and all(samples[i]['worker']['inference_count']>=samples[i-1]['worker']['inference_count'] for i in range(1,len(samples)))
    report={'continuous':continuous,'seconds':seconds,
        'inference_fps':(last['worker']['inference_count']-first['worker']['inference_count'])/seconds,
        'committed_targets_per_second':(last['archive']['delivery']['committed']-first['archive']['delivery']['committed'])/seconds,
        'bpu_mean':statistics.mean(s['bpu'] for s in samples),
        'peak_rss_kib':max(s['rss_kib'] for s in samples),
        'config_sha256':configs[0], 'snapshot_config':channel['config']['snapshot'],
        'binary_sha256':hashlib.sha256((root/'deploy/s100p/bin/ainvr_ai_service').read_bytes()).hexdigest(),
        'samples':samples}
    report['healthy']=continuous and all(s['worker']['last_error'] is None and s['archive']['healthy'] and s['archive']['dropped_count']==0 for s in samples)
    with args.output.open('x') as output:
        json.dump(report,output,indent=2)
    print(json.dumps({k:v for k,v in report.items() if k not in ('samples','snapshot_config')}))


if __name__=='__main__':
    main()
