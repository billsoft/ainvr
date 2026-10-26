#!/usr/bin/env python3
"""Bounded ingest capacity, independent RTSP/SRS fixtures, never production SRS.

Measures 4/16/32 stream-copy consumers at the declared fixture resolution;
this is not a claim of 32 high-bitrate physical-camera or AI capacity.
"""
import argparse,importlib.util,json,os,signal,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
NAME='ainvr-onvif-capacity-srs'

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--sample',type=Path,required=True);p.add_argument('--result',type=Path,required=True);p.add_argument('--hold-seconds',type=int,default=60);p.add_argument('--channels',default='4,16,32')
 p.add_argument('--restart-srs',action='store_true',help='Restart only the disposable SRS and verify bounded media recovery')
 a=p.parse_args();assert 30<=a.hold_seconds<=600;a.result=a.result.resolve();a.result.mkdir(parents=True,exist_ok=False)
 a.result.chmod(0o700);processes=[];logs=[];launcher=None;sup=None;created=False
 report={'passed':False,'productionChanged':False,'cases':[],'scope':'same low-resolution RTSP fixture with independent publishers; AAC copy; no AI load claim'}
 def launch(argv,label):
  h=(a.result/(label+'.log')).open('wb');logs.append(h);proc=subprocess.Popen(argv,cwd=a.result,stdin=subprocess.DEVNULL,stdout=h,stderr=h,start_new_session=True);processes.append(proc);return proc
 def stop(proc):
  if proc.poll() is None:
   os.killpg(proc.pid,signal.SIGTERM)
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=3)
 def metrics(pid):
  try:
   stat=(Path('/proc')/str(pid)/'status').read_text();rss=next(int(x.split()[1])*1024 for x in stat.splitlines() if x.startswith('VmRSS:'));fds=len(list((Path('/proc')/str(pid)/'fd').iterdir()));return rss,fds
  except (FileNotFoundError,StopIteration):return 0,0
 try:
  if subprocess.run(['docker','container','inspect',NAME],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:raise RuntimeError('Owned test container name is already in use')
  srs=a.result/'srs.conf';srs.write_text('listen 127.0.0.1:21935;\nmax_connections 512;\ndaemon off;\nsrs_log_tank console;\nsrs_log_level warn;\nhttp_api { enabled on; listen 127.0.0.1:21985; }\nvhost __defaultVhost__ { min_latency on; play { gop_cache on; } publish { mr off; } }\n')
  subprocess.run(['docker','run','-d','--name',NAME,'--network','host','--cpus','2','--memory','256m','--log-opt','max-size=2m','--log-opt','max-file=1','-v',str(srs)+':/usr/local/srs/conf/onvif-test.conf:ro','ossrs/srs:7.0.162','./objs/srs','-c','conf/onvif-test.conf'],check=True,stdout=subprocess.DEVNULL,timeout=15);created=True
  cfg=a.result/'mediamtx.yml';cfg.write_text('logLevel: warn\nrtsp: yes\nrtspAddress: :19454\nrtspTransports: [tcp]\nrtmp: no\nhls: no\nwebrtc: no\nsrt: no\nmoq: no\napi: no\nmetrics: no\nplayback: no\npaths:\n  camera:\n')
  launch([str(ROOT/'out/onvif-test-media/mediamtx'),str(cfg)],'rtsp');time.sleep(1)
  launch(['/usr/bin/ffmpeg','-hide_banner','-nostdin','-loglevel','error','-re','-stream_loop','-1','-i',str(a.sample.resolve()),'-map','0:v:0','-map','0:a:0','-c','copy','-rtsp_transport','tcp','-muxdelay','.1','-f','rtsp','rtsp://127.0.0.1:19454/camera'],'publisher');time.sleep(1)
  spec=importlib.util.spec_from_file_location('capacity_ingest',ROOT/'ingest-service/main.py');ingest=importlib.util.module_from_spec(spec);spec.loader.exec_module(ingest)
  base=ingest.command
  def command(c):
   args=base(c);args[-1]=args[-1].replace(':1935/',':21935/');return args
  ingest.command=command
  baseline=metrics(os.getpid())
  launcher=ingest.AsyncLauncher(ingest.CopyProcess);sup=ingest.Supervisor(launch=launcher.launch)
  counts=[int(value) for value in a.channels.split(',')]
  if not counts or len(counts)>3 or any(value not in (4,16,32) for value in counts):raise ValueError('Use channel counts 4,16,32')
  for count in counts:
   configs=[{'id':'capacity-'+str(i),'generation':'one','source':'rtsp://192.168.100.189:19454/camera','transport':'tcp','app':'test','stream':'capacity_'+str(i),'timeout':10,'audioMode':'auto'} for i in range(count)]
   start=time.monotonic();deadline=start+200
   while time.monotonic()<deadline:
    sup.reconcile(configs,True,count);status=sup.status()
    if len(status)==count and all(v['state']=='streaming' and v['frames']>=10 for v in status.values()):break
    time.sleep(.2)
   else:raise AssertionError('Capacity did not become ready: '+str(count))
   ready=time.monotonic()-start;minimum={k:v['frames'] for k,v in sup.status().items()};maxrss=0;maxfds=0;ticklatency=[];curve=[];until=time.monotonic()+a.hold_seconds
   while time.monotonic()<until:
    t=time.monotonic();sup.reconcile(configs,True,count);ticklatency.append(time.monotonic()-t)
    workers=[job['process']._process() for job in sup.jobs.values() if job['process']]
    assert len(workers)==count and all(w and w.poll() is None for w in workers),'Publisher stopped at capacity'
    values=[metrics(w.proc.pid) for w in workers]+[metrics(os.getpid())]
    maxrss=max(maxrss,sum(x[0] for x in values));maxfds=max(maxfds,sum(x[1] for x in values))
    if not curve or time.monotonic()-start-curve[-1]['atSeconds']>=5:curve.append({'atSeconds':round(time.monotonic()-start,3),'rssBytes':sum(x[0] for x in values),'fds':sum(x[1] for x in values)})
    time.sleep(.5)
   status=sup.status();assert all(v['frames']-minimum[k]>=a.hold_seconds*5 for k,v in status.items())
   assert all(not v.get('audioWarning') and v['audioCodec']=='aac' for v in status.values())
   item={'channels':count,'readySeconds':round(ready,3),'heldSeconds':a.hold_seconds,'rssPeakBytes':maxrss,'fileDescriptorsPeak':maxfds,'supervisionTickMaxSeconds':round(max(ticklatency),4),'minimumFramesAdvanced':min(v['frames']-minimum[k] for k,v in status.items()),'resourceCurve':curve}
   report['cases'].append(item);(a.result/'progress.json').write_text(json.dumps(report,indent=2));print(json.dumps(item),flush=True)
  if a.restart_srs:
   subprocess.run(['docker','restart',NAME],check=True,stdout=subprocess.DEVNULL,timeout=20)
   start=time.monotonic();seen={};deadline=start+60
   while time.monotonic()<deadline:
    sup.reconcile(configs,True,count)
    states=sup.status()
    ready=True
    for key, job in sup.jobs.items():
     worker=job['process']._process() if job['process'] else None
     if not worker or worker.poll() is not None:ready=False;continue
     identity=(key,worker.proc.pid);seen.setdefault(identity,worker.frames)
     if worker.frames-seen[identity]<10 or states[key]['state']!='streaming':ready=False
    if ready and len(states)==count:break
    time.sleep(.2)
   else:raise AssertionError('Disposable SRS restart did not recover within 60 seconds')
   report['srsRecoverySeconds']=round(time.monotonic()-start,3)
  sup.reconcile([],False);launcher.close();sup=None;launcher=None
  assert ingest.AUDIO_BUDGET.used==0
  report['parentMemoryBeforeBytes']=baseline[0];report['parentMemoryAfterBytes']=metrics(os.getpid())[0];report['parentFdsBefore']=baseline[1];report['parentFdsAfter']=metrics(os.getpid())[1];assert report['parentFdsAfter']<=baseline[1]+2
  report['passed']=True
 finally:
  if sup:sup.reconcile([],False)
  if launcher:launcher.close()
  for proc in reversed(processes):stop(proc)
  for log in logs:log.close()
  if created:subprocess.run(['docker','rm','-f',NAME],check=True,stdout=subprocess.DEVNULL,timeout=15)
  (a.result/'report.json').write_text(json.dumps(report,indent=2)+'\n')
if __name__=='__main__':main()
