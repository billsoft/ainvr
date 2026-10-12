"""Manual eight-way media acceptance. Uses only explicitly named probe channels.

Run on the maintenance board after media_probe.py and test registrations exist.
Never part of an automatic unit-test or installation path.
"""
import copy
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'out/protocol-implementation-20261009'
FFMPEG = '/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(path, method='GET', data=None):
    key = json.loads((ROOT / 'ai-service/data/config_overlay.json').read_text())['server']['api_key']
    request = urllib.request.Request('http://127.0.0.1:8000/api/v1/channels' + path,
        method=method, headers={'X-Api-Key': key, 'Content-Type': 'application/json'},
        data=json.dumps(data).encode() if data is not None else None)
    with opener.open(request, timeout=40) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def main():
    os.chdir(ROOT)
    os.umask(0o077)
    children = []
    results = []
    initial = api('')['channels']
    # Stop only the two explicitly known production AI channels; restore below.
    restore = [c['id'] for c in initial if c['id'] in ('demo-detect', 'xm_ai')
               and c['state'] in ('running', 'reconnecting', 'starting')]
    base = next(c['config'] for c in initial if c['id'] == 'demo-detect')
    test_id = None
    try:
        for cid in restore: api('/' + cid + '/stop', 'POST')
        # Stop previous *test* senders, not arbitrary producers or service workers.
        for p in Path('/proc').glob('[0-9]*/cmdline'):
            try:
                command = p.read_bytes()
                if b'ingest-service/tests/media_probe.py' in command and b'/usr/bin/python3\x00' in command:
                    os.kill(int(p.parent.name), signal.SIGTERM)
            except (OSError, ValueError): pass
        for protocol in ('rtmp', 'srt'):
            for codec in ('264', '265'):
                marker = OUT / f'{protocol}{codec}-sender.pid'
                if marker.exists():
                    pid = int(marker.read_text())
                    try:
                        if ('probe_' + protocol + codec).encode() in Path(f'/proc/{pid}/cmdline').read_bytes():
                            os.kill(pid, signal.SIGTERM)
                    except OSError: pass
        time.sleep(2)
        for protocol in ('rtsp', 'webrtc', 'rtmp', 'srt'):
            for codec in ('264', '265'):
                name = protocol + codec
                log = open(OUT / (name + '-accept-sender.log'), 'w')
                if protocol in ('rtsp', 'webrtc'):
                    args = ['/usr/bin/python3', 'ingest-service/tests/media_probe.py',
                        'rtsp' if protocol == 'rtsp' else 'whip', '--codec', 'h'+codec,
                        '--seconds', '300', '--image', str(OUT/'face-fixture.jpg'),
                        '--result', str(OUT/(name+'-accept-sender.json'))]
                    if protocol == 'rtsp': args += ['--port', '18554' if codec == '264' else '18555']
                    else:
                        channel = json.loads((OUT/(name+'-channel.json')).read_text())['channel']
                        args += ['--url', 'http://192.168.100.183/ingest/whip/'+channel['id'],
                            '--credential-file', str(OUT/(name+'-key'))]
                else:
                    destination = (f'rtmp://127.0.0.1:1935/live/probe_{name}' if protocol == 'rtmp'
                        else f'srt://127.0.0.1:10080?streamid=#!::r=live/probe_{name},m=publish')
                    args = [FFMPEG, '-hide_banner', '-nostdin', '-loglevel', 'error',
                        '-re', '-loop', '1', '-i', str(OUT/'face-fixture.jpg'), '-t', '300',
                        '-vf', 'scale=640:320', '-r', '15', '-pix_fmt', 'yuv420p', '-an',
                        '-c:v', 'libx'+codec, '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '15']
                    if codec == '265': args += ['-x265-params','pools=1:frame-threads=1:open-gop=0']
                    args += ['-f', 'flv' if protocol == 'rtmp' else 'mpegts', destination]
                children.append(subprocess.Popen(args, stdin=subprocess.DEVNULL,
                    stdout=log, stderr=subprocess.STDOUT, start_new_session=True))
                log.close()
        time.sleep(12)
        for protocol in ('rtmp', 'srt', 'rtsp', 'webrtc'):
            for codec in ('264', '265'):
                name = protocol+codec
                record = {'protocol': protocol, 'codec': 'h'+codec}
                source = f'rtmp://127.0.0.1:1935/live/probe_{name}'
                path = OUT/(name+'-capture.mp4')
                args = [FFMPEG, '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
                    '-i', source, '-t', '3', '-map', '0:v:0', '-an', '-c:v', 'copy',
                    '-movflags', '+frag_keyframe+empty_moov+default_base_moof', str(path)]
                captured = subprocess.run(args, capture_output=True, timeout=15)
                record['record_copy_ok'] = captured.returncode == 0
                decode = subprocess.run([FFMPEG,'-hide_banner','-nostdin','-loglevel','error',
                    '-i',str(path),'-progress','pipe:1','-an','-f','null','-'],capture_output=True,timeout=15)
                frames = [int(x[6:]) for x in decode.stdout.decode().splitlines() if x.startswith('frame=')]
                record['decoded_frames'] = max(frames,default=0)
                record['decode_ok'] = decode.returncode == 0 and record['decoded_frames'] >= 30
                test_id = 'protocol_accept_' + name
                config = {'id': test_id, 'name': '协议验收 '+name, 'enabled': True,
                    'inference_fps': 3, 'model': copy.deepcopy(base['model']),
                    'preprocess': copy.deepcopy(base['preprocess']),
                    'postprocess': copy.deepcopy(base['postprocess']),
                    'stream': {**copy.deepcopy(base['stream']), 'url': source},
                    'snapshot': {**copy.deepcopy(base['snapshot']), 'max_count':500,
                        'min_interval_ms':0,'projection_mode':'erp_equirect' if name == 'rtsp264' else 'none',
                        'max_crop_dimension':160,
                        'brightness_enabled': True},
                    'publish': {**copy.deepcopy(base['publish']),
                        'target_url':f'rtmp://127.0.0.1:1935/live/probe_ai_{name}'}}
                config['publish'].pop('effective_target_url',None)
                api('', 'POST', config); api('/'+test_id+'/start','POST')
                time.sleep(15)
                status = api('/'+test_id)
                (OUT/(name+'-ai-status.json')).write_text(json.dumps(status,indent=2))
                record['ai_state'] = status.get('state')
                record['ai_fps'] = status.get('stats',{}).get('inference_fps_actual')
                sei_path = OUT/(name+'-ai-sei.mp4')
                subprocess.run([FFMPEG,'-hide_banner','-nostdin','-loglevel','error','-y',
                    '-i',f'rtmp://127.0.0.1:1935/live/probe_ai_{name}',
                    '-t','3','-an','-c:v','copy','-movflags','+frag_keyframe+empty_moov+default_base_moof',str(sei_path)],capture_output=True,timeout=15,check=True)
                sys.path.insert(0,str(ROOT/'recording-service/src'))
                from recorder.sei_worker import scan_frames
                metadata = scan_frames(str(sei_path),0,10000)
                record['sei_frames'] = len(metadata)
                record['sei_with_targets'] = sum(bool(x['payload']['det']) for x in metadata)
                # Finish accepted work, while keeping the stream/publisher alive.
                api('/'+test_id+'/config','PUT',{'snapshot':{'enabled':False}})
                deadline = time.monotonic()+20
                while True:
                    archive = api('/'+test_id+'/snapshots/overview')['archive_stats']
                    if not archive['delivery']['outstanding'] or time.monotonic()>=deadline:break
                    time.sleep(.5)
                record['delivery'] = archive['delivery']
                record['archive_healthy'] = archive['healthy']
                record['enhanced_count'] = archive.get('enhanced_count', 0)
                record['brightness_corrected_count'] = archive.get('brightness_corrected_count', 0)
                record['archive_ok'] = archive['delivery']['committed']>0 and archive['delivery']['accepted']==archive['delivery']['committed'] and not archive['delivery']['outstanding'] and not archive['delivery']['quarantined']
                record['passed'] = record['record_copy_ok'] and record['decode_ok'] and record['ai_state']=='running' and record['sei_with_targets']>0 and record['archive_ok']
                results.append(record)
                (OUT/'acceptance-matrix.json').write_text(json.dumps(results,indent=2))
                print(name,'PASS' if record['passed'] else 'FAIL',record['decoded_frames'],record['ai_fps'],record['sei_with_targets'],flush=True)
                api('/'+test_id,'DELETE');test_id=None
    finally:
        if test_id:
            try:api('/'+test_id,'DELETE')
            except Exception:pass
        for p in children:
            if p.poll() is None:
                os.killpg(p.pid,signal.SIGTERM)
                try:p.wait(timeout=8)
                except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=3)
        for cid in restore:
            try:api('/'+cid+'/start','POST')
            except Exception as e:print('RESTORE FAILED',cid,type(e).__name__,flush=True)
    if len(results)!=8 or not all(x['passed'] for x in results):raise SystemExit(1)


if __name__=='__main__':main()
