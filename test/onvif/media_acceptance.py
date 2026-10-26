#!/usr/bin/env python3
"""Bounded ONVIF -> authenticated RTSP -> AINVR ingest -> real SRS smoke.

Uses an independent Python SOAP device and a checksummed MediaMTX test process.
Does not change production channel/configuration records. All owned processes
are stopped in finally. Output is a sanitized machine-readable evidence report.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
FFMPEG = '/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg'
FFPROBE = '/opt/ainvr/ffmpeg-8.1.2/bin/ffprobe'


def call(url, body=None, token=None, method=None):
    headers = {'Content-Type': 'application/json'} if body is not None else {}
    if token:
        headers['X-Service-Token'] = token
    request = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                     headers=headers, method=method)
    with OPENER.open(request, timeout=48) as response:
        return json.load(response)


def stop(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publisher',choices=['rtsp','rtmp'],default='rtsp',help='Independent fixture publisher only')
    parser.add_argument('--aac-rate',type=int,choices=[8000,16000,44100,48000])
    parser.add_argument('--aac-channels',type=int,choices=[1,2],default=1)
    parser.add_argument('--publisher-muxdelay', type=float, default=.1)
    parser.add_argument('--diagnose-source',action='store_true')
    parser.add_argument('--budget-check',action='store_true')
    parser.add_argument('--recorder', action='store_true', help='Exercise the existing recorder pipeline')
    parser.add_argument('--host', required=True)
    parser.add_argument('--interface', default='', help='Explicit board NIC for real multicast acceptance')
    parser.add_argument('--sample', type=Path, required=True)
    parser.add_argument('--audio', choices=['aac', 'alaw', 'mulaw', 'g726', 'g726le', 'opus', 'silent'], default='aac')
    parser.add_argument('--result', type=Path, required=True)
    args = parser.parse_args()
    args.result = args.result.resolve()
    args.sample = args.sample.resolve()
    args.result.mkdir(parents=True, exist_ok=False)
    os.chmod(args.result, 0o700)
    processes, handles = [], []
    pipeline = None
    extra_pipelines = []
    def launch(command, filename):
        handle = (args.result / filename).open('wb')
        handles.append(handle)
        process = subprocess.Popen(command, cwd=args.result, stdout=handle, stderr=handle, stdin=subprocess.DEVNULL, start_new_session=True)
        processes.append(process)
        return process
    token, password = secrets.token_hex(32), secrets.token_hex(16)
    sample_info = json.loads(subprocess.check_output([FFPROBE, '-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height,sample_rate,channels', '-of', 'json', str(args.sample)], timeout=10))
    sample_video = next(s for s in sample_info['streams'] if s['codec_type'] == 'video')
    video_codec = sample_video['codec_name']
    assert video_codec in ('h264', 'hevc')
    media_services = ['media1', 'media2'] if video_codec == 'h264' else ['media2']
    report = {'passed': False, 'protocol_cases': [], 'production_configuration_changed': False}
    try:
        bootstrap = args.result / 'control.json'
        bootstrap.write_text(json.dumps({'listen': '127.0.0.1:18150', 'token': token}))
        bootstrap.chmod(0o600)
        device_file = args.result / 'camera.json'
        camera = {'listen_host': args.host, 'listen_port': 18890, 'base_url': f'http://{args.host}:18890',
                  'username': 'fixture', 'password': password, 'authentication': 'wsse', 'clock_offset_seconds': 120,
                  'profiles': [{'token': 'main', 'name': 'Input A', 'video_source': 'source-a',
                                'rtsp_uri': f'rtsp://{args.host}:18554/camera', 'video_codec': 'H264', 'audio_codec': 'AAC'},
                               {'token': 'other', 'name': 'Input B', 'video_source': 'source-b',
                                'rtsp_uri': f'rtsp://{args.host}:18554/second', 'video_codec': 'H264', 'audio_codec': 'AAC'}]}
        if args.interface: camera['discovery_interface_address']=args.host
        device_file.write_text(json.dumps(camera)); device_file.chmod(0o600)
        camera['media_services'] = media_services
        for profile in camera['profiles']:
            profile.update(video_codec='H264' if video_codec == 'h264' else 'H265', width=sample_video['width'], height=sample_video['height'], audio_codec='' if args.audio == 'silent' else 'AAC' if args.audio == 'aac' else 'OPUS' if args.audio=='opus' else 'G726' if args.audio in ('g726','g726le') else 'G711')
        device_file.write_text(json.dumps(camera))
        media = args.result / 'mediamtx.yml'
        media.write_text(f'''logLevel: warn
rtsp: yes
rtspAddress: :18554
rtspTransports: [tcp]
rtmp: {'yes' if args.publisher=='rtmp' else 'no'}
rtmpAddress: :19535
hls: no
webrtc: no
srt: no
moq: no
api: no
metrics: no
playback: no
authMethod: internal
authInternalUsers:
  - user: any
    ips: [127.0.0.1]
    permissions:
      - action: publish
        path: camera
      - action: read
        path: camera
  - user: fixture
    pass: {password}
    permissions:
      - action: read
        path: camera
paths:
  camera:
  second:
''')
        media.chmod(0o600)
        launch([str(ROOT / 'out/onvif-test-media/mediamtx'), str(media)], 'rtsp-server.log')
        launch([str(ROOT / 'out/onvif/ainvr_onvif'), str(bootstrap)], 'onvif-control.log')
        launch([sys.executable, str(ROOT / 'test/onvif/virtual_camera.py'), '--config', str(device_file)], 'virtual-camera.log')
        for _ in range(75):
            try:
                call('http://127.0.0.1:18150/health', token=token)
                break
            except Exception:
                time.sleep(.2)
        else:
            raise RuntimeError('control_service_start_failed')
        for _ in range(75):
            try:
                with socket.create_connection((args.host, 18890), timeout=.5):
                    break
            except OSError:
                time.sleep(.2)
        else:
            raise RuntimeError('virtual_camera_start_failed')
        call('http://127.0.0.1:18150/v1/config', {'revision': 1, 'enabled': True, 'policy': {'allowedCIDRs': [args.host + '/32'], 'timeoutSeconds': 3}, 'interfaces': [args.interface] if args.interface else []}, token, 'PUT')
        if args.interface:
            found=call('http://127.0.0.1:18150/v1/discover',{'interface':args.interface},token)['items']
            assert sum(item['url']==f'http://{args.host}:18890/device' for item in found)==1, 'discovery_missing_or_duplicate'
            report['multicast_discovery_verified']=True
        device = {'url': f'http://{args.host}:18890/device', 'username': 'fixture', 'password': password}
        for authentication in ('wsse', 'digest'):
            camera['authentication'] = authentication
            device_file.write_text(json.dumps(camera))
            caps = call('http://127.0.0.1:18150/v1/probe', {'device': device}, token)
            assert caps['clockVerified'] and abs(caps['clockOffsetSeconds'] - 120) <= 2
            assert len(caps['profiles']) == 2 * len(media_services)
            for service in media_services:
                resolved = call('http://127.0.0.1:18150/v1/resolve', {'device': device, 'service': service, 'token': 'main', 'videoSource': 'source-a'}, token)
                assert resolved['uri'] == f'rtsp://{args.host}:18554/camera'
                report['protocol_cases'].append({'authentication': authentication, 'service': service, 'resolved': True})
            try:
                call('http://127.0.0.1:18150/v1/probe', {'device': {**device, 'password': 'wrong-test-password'}}, token)
                raise AssertionError('wrong_password_accepted')
            except urllib.error.HTTPError as error:
                assert json.load(error)['error'] == 'authentication_failed'
        # The production FFmpeg intentionally lacks the RTSP output muxer.
        # The fixture publisher uses the OS tool with stream copy only.
        audio_args = ['-an'] if args.audio == 'silent' else ['-map', '0:a:0', '-c:a', 'copy'] if args.audio == 'aac' else ['-map', '0:a:0', '-c:a', {'alaw':'pcm_alaw','mulaw':'pcm_mulaw','g726':'g726','g726le':'g726le','opus':'libopus'}[args.audio], '-ar', '48000' if args.audio=='opus' else '8000', '-ac', '1']
        if args.audio in ('g726','g726le'): audio_args+=['-b:a','32k']
        if args.aac_rate:
            assert args.audio=='aac'
            audio_args=['-map','0:a:0','-c:a','aac','-ar',str(args.aac_rate),'-ac',str(args.aac_channels),'-b:a','96k']
        publisher_args=['-rtsp_transport','tcp','-muxdelay',str(args.publisher_muxdelay),'-f','rtsp','rtsp://127.0.0.1:18554/camera'] if args.publisher=='rtsp' else ['-f','flv','rtmp://127.0.0.1:19535/camera']
        publisher_tool='/usr/bin/ffmpeg' if args.publisher=='rtsp' else str(ROOT/'out/media-bridge/runtime/bin/ffmpeg')
        launch([publisher_tool, '-hide_banner', '-nostdin', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', str(args.sample), '-map', '0:v:0', '-c:v', 'copy', *audio_args, *publisher_args], 'publisher.log')
        time.sleep(2)
        direct=None
        if args.diagnose_source:
            direct=launch(['/usr/bin/ffmpeg','-hide_banner','-nostdin','-loglevel','error','-rtsp_transport','tcp','-i','rtsp://127.0.0.1:18554/camera','-t','6','-map','0:v:0','-map','0:a:0','-c','copy','-f','mp4','-y',str(args.result/'direct-source.mp4')],'direct-source.log')
        spec = importlib.util.spec_from_file_location('onvif_ingest_acceptance', ROOT / 'ingest-service/main.py')
        ingest = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ingest)
        uri = f'rtsp://fixture:{urllib.parse.quote(password)}@{args.host}:18554/camera'
        target = args.result / 'capture.mp4'
        capture = launch([FFMPEG, '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', 'rtmp://127.0.0.1:1935/live/onvif_acceptance', '-t', '6', '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-y', str(target)], 'capture.log')
        time.sleep(.5)
        pipeline = ingest.CopyProcess({'source': uri, 'app': 'live', 'stream': 'onvif_acceptance', 'transport': 'tcp', 'timeout': 5, 'audioMode': 'auto'})
        deadline = time.monotonic() + 20
        while pipeline.frames < 10 and time.monotonic() < deadline and pipeline.poll() is None:
            time.sleep(.2)
        assert pipeline.frames >= 10, 'no_video_progress'
        expected_audio = {'aac': 'aac', 'alaw': 'pcm_alaw', 'mulaw': 'pcm_mulaw', 'g726':'adpcm_g726', 'g726le':'adpcm_g726le', 'opus':'opus', 'silent': None}[args.audio]
        assert pipeline.audio_codec == expected_audio
        assert pipeline.audio_warning == ('no_audio' if args.audio == 'silent' else 'unsupported_audio_codec' if args.audio=='opus' else None)
        assert capture.wait(timeout=25) == 0, 'recording_capture_failed'
        info = json.loads(subprocess.check_output([FFPROBE, '-v', 'error', '-show_entries', 'stream=codec_name,codec_type,start_time,duration,sample_rate,channels', '-of', 'json', str(target)], timeout=5))
        video = next(s for s in info['streams'] if s['codec_type'] == 'video')
        audio = next((s for s in info['streams'] if s['codec_type'] == 'audio'), None)
        assert video['codec_name'] == video_codec
        offset = None
        if args.audio in ('silent','opus'):
            assert audio is None
        else:
            assert audio and audio['codec_name'] == 'aac'
            if args.aac_rate:
                assert int(audio['sample_rate'])==args.aac_rate and audio['channels']==args.aac_channels
            elif args.audio=='aac':
                source_audio=next(s for s in sample_info['streams'] if s['codec_type']=='audio')
                assert int(audio['sample_rate'])==int(source_audio['sample_rate']) and audio['channels']==source_audio['channels']
            offset = abs(float(video['start_time']) - float(audio['start_time']))
            report['av_start_offset_seconds'] = offset
            # A late-join GOP may begin before the first audio packet. Validate
            # content timing instead of confusing first-packet metadata with sync.
            synchronization=json.loads(subprocess.check_output(['/usr/bin/python3',str(ROOT/'test/onvif/av_content.py'),str(args.sample),str(target)],timeout=30))
            report['synchronization']=synchronization
            if direct:
                assert direct.wait(timeout=15)==0
                report['source_synchronization']=json.loads(subprocess.check_output(['/usr/bin/python3',str(ROOT/'test/onvif/av_content.py'),str(args.sample),str(args.result/'direct-source.mp4')],timeout=30))
            assert synchronization['maximum_content_offset_seconds']<=.2, 'av_content_offset_exceeded'
            assert synchronization['content_drift_seconds']<=.05, 'av_content_drift_exceeded'
        if args.budget_check:
            assert args.audio in ('alaw','mulaw','g726','g726le')
            for number in (2,3):
                extra=ingest.CopyProcess({'source':uri,'app':'live','stream':'onvif_quota_'+str(number),'transport':'tcp','timeout':5,'audioMode':'auto'})
                extra_pipelines.append(extra)
                deadline=time.monotonic()+20
                while extra.frames<10 and extra.poll() is None and time.monotonic()<deadline:time.sleep(.2)
                assert extra.frames>=10,'quota_degradation_stopped_video'
            assert extra_pipelines[0].audio_warning is None
            assert extra_pipelines[1].audio_warning=='audio_capacity_exceeded'
            assert ingest.AUDIO_BUDGET.used==2
            for extra in extra_pipelines:extra.stop()
            assert ingest.AUDIO_BUDGET.used==1
            report['audioQuota']={'thirdInputKeptVideo':True,'thirdInputReason':'audio_capacity_exceeded','slotsAfterExtraStop':1}
        if args.recorder:
            command=[sys.executable,str(ROOT/'test/onvif/recording_acceptance.py'),'--codec',video_codec,'--result',str(args.result/'recorder')]
            if args.audio not in ('silent','opus'):command+=['--audio']
            subprocess.run(command,check=True,timeout=45,stdout=subprocess.DEVNULL)
            report['recorder']=json.loads((args.result/'recorder/report.json').read_text())
        report.update(passed=True, media={'video': video_codec, 'source_audio': expected_audio, 'audio': 'aac' if audio else None, 'audioSampleRate':audio.get('sample_rate') if audio else None, 'audioChannels':audio.get('channels') if audio else None, 'frames': pipeline.frames, 'captured_bytes': target.stat().st_size, 'av_start_offset_seconds': offset})
    except Exception as error:
        report['error'] = type(error).__name__
        if isinstance(error, urllib.error.HTTPError):
            try:
                detail = json.load(error).get('error', '')
                if isinstance(detail, str) and detail.replace('_', '').isalpha():
                    report['protocol_error'] = detail
            except Exception:
                pass
        raise
    finally:
        for extra in extra_pipelines:extra.stop()
        if pipeline is not None:
            pipeline.stop()
        for process in reversed(processes):
            stop(process)
        for handle in handles:
            handle.close()
        (args.result / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))


if __name__ == '__main__':
    main()
