#!/usr/bin/env python3
"""Disposable independent ONVIF camera for browser/production integration acceptance.

Private credentials stay in this runner's restricted result directory. Does not
create production records. Maximum lifetime 20 minutes; all actors cleaned up.
"""
import argparse,json,os,secrets,signal,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--result',type=Path,required=True);p.add_argument('--sample',type=Path,required=True);p.add_argument('--host',required=True);a=p.parse_args();a.result=a.result.resolve();a.result.mkdir(parents=True,exist_ok=False);a.result.chmod(0o700)
 children=[];handles=[];stopped=False
 def stop(*_):
  nonlocal stopped
  stopped=True
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 def launch(args,name):
  h=(a.result/(name+'.log')).open('wb');handles.append(h);child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=h,stderr=h,start_new_session=True,cwd=a.result);children.append(child);return child
 password=secrets.token_hex(24)
 cfg=a.result/'camera.json';cfg.write_text(json.dumps({'listen_host':a.host,'listen_port':18892,'base_url':f'http://{a.host}:18892','username':'acceptance','password':password,'authentication':'digest','clock_offset_seconds':120,'profiles':[{'token':'main','name':'验收主码流','video_source':'source-a','rtsp_uri':f'rtsp://{a.host}:18556/camera','video_codec':'H264','audio_codec':'AAC','width':320,'height':240,'fps':10}]}));cfg.chmod(0o600)
 media=a.result/'media.yml';media.write_text(f"""logLevel: warn
rtsp: yes
rtspAddress: :18556
rtspTransports: [tcp]
rtmp: no
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
  - user: acceptance
    pass: {password}
    permissions:
      - action: read
        path: camera
paths:
  camera:
""");media.chmod(0o600)
 try:
  launch([str(ROOT/'out/onvif-test-media/mediamtx'),str(media)],'rtsp');time.sleep(1)
  launch([sys.executable,str(ROOT/'test/onvif/virtual_camera.py'),'--config',str(cfg)],'onvif')
  launch(['/usr/bin/ffmpeg','-hide_banner','-nostdin','-loglevel','error','-re','-stream_loop','-1','-i',str(a.sample.resolve()),'-map','0:v:0','-map','0:a:0','-c','copy','-rtsp_transport','tcp','-muxdelay','.1','-f','rtsp','rtsp://127.0.0.1:18556/camera'],'publisher')
  (a.result/'owner.json').write_text(json.dumps({'pid':os.getpid(),'children':[x.pid for x in children]}))
  end=time.monotonic()+1200
  while not stopped and time.monotonic()<end:
   if any(x.poll() is not None for x in children):raise RuntimeError('Fixture actor stopped')
   time.sleep(.5)
 finally:
  for child in reversed(children):
   if child.poll() is None:
    os.killpg(child.pid,signal.SIGTERM)
    try:child.wait(timeout=4)
    except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=3)
  for h in handles:h.close()
  (a.result/'stopped.json').write_text(json.dumps({'childrenStopped':all(x.poll() is not None for x in children)}))
if __name__=='__main__':main()
