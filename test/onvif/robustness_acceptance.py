#!/usr/bin/env python3
"""Real IP loss/recovery on a private TUN/namespace, with production ingest.

Uses no production channel records, physical NIC modifications or SRS restart.
All child processes and the private link are owned and cleaned by this runner.
"""
import argparse, importlib.util, json, os, secrets, signal, socket, subprocess, sys, time, urllib.parse, urllib.request
from pathlib import Path
from fault_link import FaultLink, HOST, CAMERA, NAMESPACE
ROOT=Path(__file__).resolve().parents[2]
OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}))

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--sample',type=Path,required=True)
 p.add_argument('--audio',choices=['aac','alaw','mulaw','g726'],default='aac')
 p.add_argument('--result',type=Path,required=True)
 a=p.parse_args();a.result=a.result.resolve();a.result.mkdir(parents=True,exist_ok=False);a.result.chmod(0o700)
 processes=[];handles=[];supervisor=None;launcher=None
 report={'passed':False,'productionConfigurationChanged':False,'phases':[]}
 password=secrets.token_hex(24);token=secrets.token_hex(32)
 def launch(argv,label,namespace=False):
  h=(a.result/(label+'.log')).open('wb');handles.append(h)
  proc=subprocess.Popen((['ip','netns','exec',NAMESPACE] if namespace else [])+argv,stdout=h,stderr=h,stdin=subprocess.DEVNULL,start_new_session=True,cwd=a.result)
  processes.append(proc);return proc
 def stop(proc):
  if proc.poll() is None:
   os.killpg(proc.pid,signal.SIGTERM)
   try:proc.wait(timeout=4)
   except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=3)
 def call(path,body=None,method=None):
  req=urllib.request.Request('http://127.0.0.1:18150'+path,data=json.dumps(body).encode() if body is not None else None,headers={'X-Service-Token':token,'Content-Type':'application/json'},method=method)
  with OPENER.open(req,timeout=15) as r:return json.load(r)
 def wait_tcp(host,port):
  end=time.monotonic()+15
  while time.monotonic()<end:
   try:
    with socket.create_connection((host,port),timeout=.3):return
   except OSError:time.sleep(.2)
  raise RuntimeError('Fixture endpoint not ready')
 try:
  with FaultLink() as link:
   bootstrap=a.result/'control.json';bootstrap.write_text(json.dumps({'listen':'127.0.0.1:18150','token':token}));bootstrap.chmod(0o600)
   control=launch([str(ROOT/'out/onvif/ainvr_onvif'),str(bootstrap)],'control')
   cfg=a.result/'camera.json';cfg.write_text(json.dumps({'listen_host':CAMERA,'listen_port':18890,'base_url':f'http://{CAMERA}:18890','username':'fixture','password':password,'authentication':'digest','clock_offset_seconds':120,'profiles':[{'token':'main','name':'camera','video_source':'source-a','video_codec':'H264','audio_codec':'AAC','rtsp_uri':f'rtsp://{CAMERA}:18554/camera'}]}));cfg.chmod(0o600)
   launch([sys.executable,str(ROOT/'test/onvif/virtual_camera.py'),'--config',str(cfg)],'camera',True)
   media=a.result/'media.yml';media.write_text(f"""logLevel: warn
rtsp: yes
rtspAddress: :18554
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
  - user: fixture
    pass: {password}
    permissions:
      - action: read
        path: camera
paths:
  camera:
""");media.chmod(0o600)
   def start_server():return launch([str(ROOT/'out/onvif-test-media/mediamtx'),str(media)],'rtsp-'+str(len(processes)),True)
   def start_publisher():
    audio=['-map','0:a:0','-c:a','copy'] if a.audio=='aac' else ['-map','0:a:0','-c:a',{'alaw':'pcm_alaw','mulaw':'pcm_mulaw','g726':'g726'}[a.audio],'-ar','8000','-ac','1']
    if a.audio=='g726':audio+=['-b:a','32k']
    return launch(['/usr/bin/ffmpeg','-hide_banner','-nostdin','-loglevel','error','-re','-stream_loop','-1','-i',str(a.sample.resolve()),'-map','0:v:0','-c:v','copy',*audio,'-rtsp_transport','tcp','-muxdelay','.1','-f','rtsp','rtsp://127.0.0.1:18554/camera'],'publisher-'+str(len(processes)),True)
   server=start_server();wait_tcp(CAMERA,18554);publisher=start_publisher();wait_tcp(CAMERA,18890);wait_tcp('127.0.0.1',18150)
   call('/v1/config',{'revision':1,'enabled':True,'policy':{'allowedCIDRs':['198.18.0.0/30'],'timeoutSeconds':3},'interfaces':[]},'PUT')
   device={'url':f'http://{CAMERA}:18890/device','username':'fixture','password':password}
   caps=call('/v1/probe',{'device':device});assert caps['clockVerified']
   profile=caps['profiles'][0]
   uri=call('/v1/resolve',{'device':device,'service':profile['service'],'token':'main','videoSource':'source-a'})['uri']
   parsed=urllib.parse.urlsplit(uri);uri=urllib.parse.urlunsplit((parsed.scheme,'fixture:'+password+'@'+parsed.netloc,parsed.path,parsed.query,''))
   spec=importlib.util.spec_from_file_location('fault_ingest',ROOT/'ingest-service/main.py');ingest=importlib.util.module_from_spec(spec);spec.loader.exec_module(ingest)
   import media_policy
   original_classifier=media_policy.error_code
   def classify(text):
    code=original_classifier(text)
    safe=text.replace(password,'[REDACTED]')
    import re
    safe=re.sub(r'rtsp://[^\s]+','[PRIVATE RTSP URI]',safe)
    (a.result/'media-diagnostic.log').write_text(safe[-8192:])
    return code
   media_policy.error_code=classify;ingest.error_code=classify
   def factory(c):
    import threading
    path=Path('/proc/self/task')/str(threading.get_native_id())/'ns/net'
    report['workerNetworkNamespace']=os.readlink(path)
    report['mainNetworkNamespace']=os.readlink('/proc/self/ns/net')
    # Connection positive control inside the actual connection worker.
    with socket.create_connection(('127.0.0.1',1935),timeout=2):pass
    return ingest.CopyProcess(c)
   launcher=ingest.AsyncLauncher(factory);supervisor=ingest.Supervisor(launch=launcher.launch)
   config={'id':'onvif-fault-fixture','generation':'fault-generation','source':uri,'app':'live','stream':'onvif_robustness','transport':'tcp','timeout':3,'audioMode':'auto'}
   def tick():supervisor.reconcile([config],True,4)
   def current():
    deferred=supervisor.jobs[config['id']]['process']
    return deferred._process() if deferred else None
   def until_progress(timeout):
    end=time.monotonic()+timeout;baseline={}
    while time.monotonic()<end:
     tick();proc=current()
     if proc:
      baseline.setdefault(proc.proc.pid,proc.frames)
      if proc.frames-baseline[proc.proc.pid]>=8:return proc
     time.sleep(.2)
    raise AssertionError('Media did not recover before deadline')
   first=until_progress(25);report['firstFrameSeconds']=round(first.last_video-first.started,3)
   def phase(name,seconds,**faults):
    link.configure(**faults);begin=time.monotonic();seen=set();frames={};samples=[]
    while time.monotonic()-begin<seconds:
     tick();proc=current()
     if proc:
      pid=proc.proc.pid;seen.add(pid);frames.setdefault(pid,[proc.frames,proc.frames]);frames[pid][1]=proc.frames
     samples.append(supervisor.status()[config['id']]['state']);time.sleep(.2)
    item={'name':name,'seconds':round(time.monotonic()-begin,2),'processes':len(seen),'framesAdvanced':sum(max(0,b-a) for a,b in frames.values()),'states':sorted(set(samples)),'link':link.snapshot()}
    report['phases'].append(item);(a.result/'progress.json').write_text(json.dumps(report,indent=2))
    return item
   assert phase('baseline',10)['framesAdvanced']>=30
   # Loss is applied to actual TCP/IP packets, not simulated process results.
   for loss in [.01,.03,.05,.10]:
    item=phase('packet-loss-'+str(loss),15,drop=loss,delay=.005,jitter=.01,seed=20261026+int(loss*100))
    assert item['framesAdvanced']>0,'No progress under packet loss'
   link.configure();until_progress(30)
   stable=current();pid=stable.proc.pid;stop(control)
   assert phase('control-service-down',8)['framesAdvanced']>=20
   assert current().proc.pid==pid,'Healthy stream restarted on control failure'
   control=launch([str(ROOT/'out/onvif/ainvr_onvif'),str(bootstrap)],'control-restored');wait_tcp('127.0.0.1',18150)
   phase('hard-network-cut',22,cut=True)
   link.configure();start=time.monotonic();recovered=until_progress(60)
   report['networkRecoverySeconds']=round(time.monotonic()-start,3);assert recovered.proc.pid!=pid
   # Restart only the disposable camera media server and publisher, never SRS.
   stop(publisher);stop(server);phase('camera-restarting',8)
   server=start_server();wait_tcp(CAMERA,18554);publisher=start_publisher();start=time.monotonic();until_progress(60)
   report['cameraRecoverySeconds']=round(time.monotonic()-start,3)
   assert phase('post-recovery-stability',12)['framesAdvanced']>=30
   proc=current();assert proc.audio_warning is None
   target=a.result/'recovered.mp4'
   subprocess.run([str(ROOT/'out/media-bridge/runtime/bin/ffmpeg'),'-hide_banner','-nostdin','-loglevel','error','-i','rtmp://127.0.0.1:1935/live/onvif_robustness','-t','4','-map','0:v:0','-map','0:a:0','-c','copy','-y',str(target)],check=True,timeout=20,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   info=json.loads(subprocess.check_output(['/opt/ainvr/ffmpeg-8.1.2/bin/ffprobe','-v','error','-show_entries','stream=codec_type,codec_name','-of','json',str(target)],timeout=5));assert any(s['codec_name']=='aac' for s in info['streams'])
   report['recording']=info;report['link']=link.snapshot();assert not report['link']['error'] and report['link']['queueDrops']==0
   supervisor.reconcile([],False);launcher.close();supervisor=None;launcher=None
   assert ingest.AUDIO_BUDGET.used==0,'Audio slot leaked'
   report['audioSlotsAfterStop']=0;report['passed']=True
 finally:
  if supervisor:supervisor.reconcile([],False)
  if launcher:launcher.close()
  for proc in reversed(processes):stop(proc)
  for handle in handles:handle.close()
  report['privateNamespaceRemoved']=not Path('/run/netns',NAMESPACE).exists()
  (a.result/'report.json').write_text(json.dumps(report,indent=2)+'\n')
  print(json.dumps(report))
if __name__=='__main__':main()
