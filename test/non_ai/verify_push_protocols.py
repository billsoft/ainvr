#!/usr/bin/env python3
"""Actual SRT/WHIP -> SRS -> VPU -> reused SEI publisher acceptance.

Synthetic CPU encoders are source fixtures only. Empty SEI detections are
transport metadata, never user-model results or user history.
"""
import datetime
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import signal
import subprocess
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[2]
FFMPEG='/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg'
NODE='/opt/ainvr/node-v24.20.0-linux-arm64/bin/node'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def streams():
    with urllib.request.urlopen('http://127.0.0.1:1985/api/v1/streams',timeout=5) as f:
        return json.load(f)['streams']

def stream(name):
    return next((s for s in streams() if s['name']==name and s['app']=='live'),None)

def wait(predicate, seconds, message):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        value=predicate()
        if value:
            return value
        time.sleep(.2)
    raise AssertionError(message)

def stop(child):
    if child.poll() is None:
        os.killpg(child.pid,signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid,signal.SIGKILL)
            child.wait(timeout=5)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--protocols',nargs='+',choices=('srt','whip'),default=['srt','whip'])
    args=parser.parse_args()
    assert len(set(args.protocols))==len(args.protocols)
    assert ROOT.resolve()==Path('/home/sunrise/ainvr')
    assert os.geteuid()==0 and Path('/mnt/ainvr-ssd').is_mount()
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+str(os.getpid())
    result=ROOT/'test/results'/('push-protocols-'+stamp);result.mkdir()
    user=subprocess.check_output(['systemctl','show','ainvr-ai','-p','User','--value'],
                                 text=True,timeout=5).strip()
    account=pwd.getpwnam(user);os.chown(result,account.pw_uid,account.pw_gid)
    interfaces=json.loads(subprocess.check_output(['ip','-j','address','show','eth0'],
                                                  text=True,timeout=5))
    rtc_candidate=next(a['local'] for interface in interfaces for a in interface['addr_info']
                       if a['family']=='inet')
    work=Path('/mnt/ainvr-ssd/test-media')/result.name;work.mkdir(parents=True)
    build=ROOT/'out/build/ai-ffmpeg8'
    protected=[ROOT/'deploy/s100p/bin/ainvr_ai_service',ROOT/'data/ai/config_overlay.json',
               ROOT/'data/recorder/config.json',ROOT/'srs-web-console/deploy/srs-conf/srs.conf']
    original={str(p):digest(p) for p in protected}
    children=[];records=[];owned_streams=[];cleanup=False

    def cancelled(_signum,_frame):
        raise KeyboardInterrupt('Push protocol acceptance interrupted')
    signal.signal(signal.SIGTERM,cancelled)

    def launch(args, name, env=None):
        with (result/(name+'.log')).open('w') as log:
            child=subprocess.Popen(args,stdout=log,stderr=subprocess.STDOUT,
                                   env=env,start_new_session=True)
        children.append(child)
        return child

    def run(args,name,seconds,env=None):
        child=launch(args,name,env)
        try:
            code=child.wait(timeout=seconds)
            assert code==0, name+' failed; see '+str(result/(name+'.log'))
        finally:
            stop(child)

    try:
        run(['cmake','--build',str(build),'--target','ainvr_stream_source_sei_probe','-j2'],
            'build',180)
        for codec in (('h264','h265') if 'srt' in args.protocols else ()):
            fixture=work/(codec+'.mp4')
            args=['/usr/bin/ffmpeg','-nostdin','-hide_banner','-loglevel','error',
                  '-f','lavfi','-i','testsrc2=size=640x320:rate=15','-frames:v','45',
                  '-c:v','libx264' if codec=='h264' else 'libx265','-threads','2',
                  '-preset','ultrafast','-tune','zerolatency','-g','15','-bf','0']
            if codec=='h265':
                args+=['-x265-params','pools=1:frame-threads=1:open-gop=0:log-level=error']
            run(args+[str(fixture)],codec+'-fixture',45)

        for protocol in args.protocols:
            for codec in ('h264','h265'):
                name='ainvr-push-'+stamp+'-'+protocol+'-'+codec
                owned_streams.append(name)
                assert not stream(name)
                phases=[];previous_cid=None
                for phase in ('initial','republish'):
                    label=protocol+'-'+codec+'-'+phase
                    if protocol=='srt':
                        destination='srt://127.0.0.1:10080?streamid=#!::r=live/'+name+',m=publish'
                        sender=launch([FFMPEG,'-nostdin','-hide_banner','-loglevel','error',
                            '-re','-stream_loop','-1','-i',str(work/(codec+'.mp4')),
                            '-map','0:v:0','-an','-c:v','copy','-f','mpegts',destination],label+'-sender')
                    else:
                        # Native SRS WHIP is exercised directly on loopback. The
                        # console's authenticated channel/credential route is a
                        # distinct acceptance gate; it is neither replaced nor bypassed.
                        # libnice does not gather loopback candidates. Use the
                        # actual LAN address for ICE, even with loopback HTTP.
                        url='http://127.0.0.1:1985/rtc/v1/whip/?app=live&stream='+name+'&eip='+rtc_candidate
                        # Same selection as the original ingest.ts WHIP proxy.
                        # SRS otherwise selects H264 even for an H265-only offer.
                        if codec=='h265':
                            url+='&codec=hevc'
                        sender=launch(['/usr/bin/python3',str(ROOT/'ingest-service/tests/media_probe.py'),
                            'whip','--codec',codec,'--url',url,'--seconds','100',
                            '--result',str(result/(label+'-sender.json'))],label+'-sender')
                    def ready():
                        assert sender.poll() is None, label+' sender exited early'
                        s=stream(name)
                        if not s or not s['publish']['active']:
                            return False
                        if s['publish']['cid']==previous_cid or s.get('video_frames',0)<30:
                            return False
                        return s
                    current=wait(ready,30,label+' did not publish real video')
                    actual=current['video']['codec'].upper()
                    assert actual==('H264' if codec=='h264' else 'HEVC') or (codec=='h265' and actual=='H265')
                    assert (current['video']['width'],current['video']['height'])==(640,320)
                    transport=result/(label+'-transport.json')
                    run(['runuser','-u',user,'--',str(build/'ainvr_stream_source_sei_probe'),
                         'rtmp://127.0.0.1:1935/live/'+name,str(transport)],label+'-transport',75,
                        dict(os.environ,LD_LIBRARY_PATH='/usr/hobot/lib',GSETTINGS_BACKEND='memory'))
                    evidence=json.loads(transport.read_text())
                    assert evidence['passed'] and evidence['source_size']==[640,320]
                    assert evidence['source_hardware_decoded_frames']>=12
                    assert evidence['output_evidence']['verified_sei_frames']>=12
                    assert evidence['output_evidence']['vpu_decoded_frames']>=3
                    assert evidence['steady_state_metadata_strict'] and evidence['steady_frames_stamped']>=12
                    assert evidence['vcl_payloads_match_after_annexb_padding_normalization']
                    assert not evidence['video_reencoded'] and not evidence['inference_executed']
                    owned_streams.append(evidence['temporary_output_stream'])
                    parser_report=result/(label+'-browser-parser.json')
                    run([NODE,'--experimental-strip-types',str(ROOT/'test/ai_port/verify_browser_sei.mts'),
                         str(transport),str(parser_report)],label+'-browser-parser',20)
                    browser=json.loads(parser_report.read_text());assert browser['passed']
                    previous_cid=current['publish']['cid']
                    stop(sender)
                    wait(lambda: not ((s:=stream(name)) and s['publish']['active']),10,
                         label+' remained published after sender stop')
                    if protocol=='whip':
                        sender_report=json.loads((result/(label+'-sender.json')).read_text())
                        assert sender_report['status']==201 and sender_report['connection']=='connected'
                        assert sender_report['delete_status'] in (200,204)
                        assert not sender_report['errors']
                    p={'phase':phase,'passed':True,'publisher_cid':previous_cid,
                       'source_vpu_frames':evidence['source_hardware_decoded_frames'],
                       'output_vpu_frames':evidence['output_evidence']['vpu_decoded_frames'],
                       'sei_frames':evidence['output_evidence']['verified_sei_frames'],
                       'production_browser_parser':True,'compressed_vcl_unchanged':True,
                       'transport_evidence':str(transport)}
                    phases.append(p);print(json.dumps({'protocol':protocol,'codec':codec,**p}),flush=True)
                assert phases[0]['publisher_cid']!=phases[1]['publisher_cid']
                records.append({'protocol':protocol,'codec':codec,'passed':True,'phases':phases})
    finally:
        for child in children:
            stop(child)
        assert all(p.poll() is not None for p in children)
        wait(lambda: not any(s['name'] in owned_streams and s['publish']['active'] for s in streams()),
             10,'Owned test publishers did not stop')
        assert {str(p):digest(p) for p in protected}==original
        cleanup=True
        summary={'passed':len(records)==2*len(args.protocols) and all(r['passed'] for r in records),
                 'cases':records,'execution_user':user,'dimensions':[640,320],
                 'selected_protocols':args.protocols,'complete_protocol_coverage':len(records)==4,
                 'rtc_candidate':rtc_candidate,
                 'original_sei_publisher_used':True,'vpu_decode_used':True,
                 'test_metadata_has_empty_detections':True,'inference_executed':False,
                 'synthetic_cpu_encoder_is_fixture_only':True,'video_reencoded_by_pipeline':False,
                 'all_owned_processes_and_publishers_stopped':cleanup,
                 'production_files_unchanged':True,'actual_browser_playback_verified':False,
                 'console_ingest_routes_verified':False,'user_model_inference_verified':False,
                 'full_migration_completed':False,'runner_sha256':digest(Path(__file__))}
        (result/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        print('RESULT',result,flush=True)
    assert summary['passed']

if __name__=='__main__':
    main()
