#!/usr/bin/env python3
"""One bounded independent UDP camera -> gateway -> ZLM -> SRS A/V test."""
import configparser
import os
import hashlib
import argparse
import json
from pathlib import Path
import secrets
import socket
import struct
import subprocess
import sys
import time
import urllib.request
from device_simulator import Device

ROOT=Path(__file__).resolve().parents[2]
OUT=Path(os.environ.get('AINVR_GB_TEST_RESULTS',str(ROOT/'test/results/gb28181')))/'pipeline-probe'
GATEWAY=Path(os.environ.get('AINVR_GB_TEST_GATEWAY',str(ROOT/'out/gb28181/gateway'))).resolve()
ZLM=ROOT/'out/gb28181/ZLMediaKit'
BIN=ROOT/'out/gb28181/ffmpeg-runtime/bin'

def main():
 global OUT
 parser=argparse.ArgumentParser();parser.add_argument('--version',choices=['2.0','3.0'],default='3.0');parser.add_argument('--signaling',choices=['udp','tcp'],default='udp');parser.add_argument('--media',choices=['udp','tcp-passive','tcp-active'],default='udp');parser.add_argument('--fixture',default='fixture');parser.add_argument('--video',choices=['h264','hevc'],default='h264');parser.add_argument('--silent',action='store_true');parser.add_argument('--recorder',action='store_true');args=parser.parse_args()
 assert args.fixture.replace('-','').isalnum()
 OUT=OUT/f'{args.version}-{args.signaling}-{args.media}-{args.fixture}'
 if args.recorder:OUT=OUT/'recorder'
 OUT.mkdir(parents=True,exist_ok=True)
 records=[]
 with (ROOT/f'out/gb28181/{args.fixture}.psrecords').open('rb') as f:
  while header:=f.read(8):
   pts,size=struct.unpack('!II',header);records.append((pts,f.read(size)))
 for port in [19580,19554,11935,11985,19096,15060]:
  with socket.socket() as s:s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',port))
 token=secrets.token_hex(32);media=secrets.token_hex(32)
 cfg=configparser.ConfigParser(interpolation=None,strict=False);cfg.optionxform=str;cfg.read(ZLM/'conf/config.ini')
 for section,values in {'api':{'secret':media},'general':{'listen_ip':'127.0.0.1'},'http':{'port':'19580','sslport':'0'},'rtsp':{'port':'19554','sslport':'0'},'rtmp':{'port':'0','sslport':'0'},'rtp_proxy':{'port':'0'},'srt':{'port':'0'},'rtc':{'port':'0','tcpPort':'0','enableTurn':'0'},'onvif':{'port':'0'},'shell':{'port':'0'},'hook':{'enable':'0'},'protocol':{'enable_mp4':'0','enable_hls':'0','enable_rtsp':'1'}}.items():
  if section not in cfg:cfg[section]={}
  cfg[section].update(values)
 with (OUT/'media.ini').open('w') as f:cfg.write(f,space_around_delimiters=False)
 (OUT/'media.ini').chmod(0o600)
 (OUT/'bootstrap.json').write_text(json.dumps({'listen':'127.0.0.1:19096','token':token}));(OUT/'bootstrap.json').chmod(0o600)
 (OUT/'srs.conf').write_text('listen 127.0.0.1:11935;\ndaemon off;\nsrs_log_tank console;\nmax_connections 32;\nhttp_api { enabled on; listen 127.0.0.1:11985; }\nvhost __defaultVhost__ { }\n')
 name='ainvr-gb-srs-probe';processes=[];logs=[];device=None;srs_started=False
 def spawn(args,logname):
  log=(OUT/logname).open('wb');logs.append(log);p=subprocess.Popen(args,stdout=log,stderr=log);processes.append(p)
 def api(path,body=None):
  req=urllib.request.Request('http://127.0.0.1:19096'+path,data=None if body is None else json.dumps(body).encode(),headers={'X-Service-Token':token,'Content-Type':'application/json'})
  with urllib.request.urlopen(req,timeout=20) as response:return json.load(response)
 try:
  subprocess.run(['docker','run','-d','--name',name,'--network','host','--memory','256m','--cpus','1','--label','ainvr.task=gb28181-test','-v',str(OUT/'srs.conf')+':/usr/local/srs/conf/probe.conf:ro','ossrs/srs:7.0.162','./objs/srs','-c','conf/probe.conf'],check=True,capture_output=True,timeout=15);srs_started=True
  spawn([str(ZLM/'release/linux/Release/MediaServer'),'-c',str(OUT/'media.ini'),'-t','2','--affinity','0','-l','4','--log-dir',str(OUT/'logs'),'--log-size','2','--log-slice','2'],'media.log')
  (OUT/'build.json').write_text(json.dumps({'gateway':str(GATEWAY),'sha256':hashlib.sha256(GATEWAY.read_bytes()).hexdigest()}))
  spawn([str(GATEWAY),'--bootstrap',str(OUT/'bootstrap.json')],'gateway.log')
  for attempt in range(50):
   try:api('/v1/status');break
   except OSError:time.sleep(.1)
  platform='34020000002000000001'
  device=Device(15060,records,args.version,args.signaling,args.media)
  api('/v1/config',{'revision':1,'enabled':True,'sip':{'serverId':platform,'realm':'3402000000','listen':'127.0.0.1:15060','advertiseIp':'127.0.0.1','maxDevices':4,'maxCatalogItems':100,'heartbeatTimeoutSec':60,'devices':[{'id':device.id,'password':device.password,'version':'auto','enabled':True}]},
   'media':{'domainId':platform,'api':'http://127.0.0.1:19580','secret':media,'listenIp':'127.0.0.1','advertiseIp':'127.0.0.1','portStart':32000,'portEnd':32010,'capacity':1},
   'bridge':{'ffmpeg':str(BIN/'ffmpeg'),'httpBase':'http://127.0.0.1:19580','rtspBase':'rtsp://127.0.0.1:19554','rtmpBase':'rtmp://127.0.0.1:11935'},'srsApi':'http://127.0.0.1:11985',
   'bindings':[{'id':'fixture','deviceId':device.id,'channelId':device.channel,'app':'live','stream':'gb_fixture','mode':args.media,'enabled':True}]})
  for attempt in range(40):
   if api('/v1/status').get('ready'):break
   time.sleep(.1)
  device.start()
  assert device.registered.wait(4),'device registration failed'
  start=time.monotonic();status={};timeline=[]
  for attempt in range(100):
   status=api('/v1/status')
   snapshot=[(s['state'],s.get('reason')) for s in status.get('inputs',[])]
   if not timeline or timeline[-1]['state']!=snapshot:timeline.append({'at':round(time.monotonic()-start,2),'state':snapshot})
   if any(s['state']=='streaming' for s in status.get('inputs',[])):break
   if device.error:raise RuntimeError(device.error)
   time.sleep(.2)
  (OUT/'timeline.json').write_text(json.dumps(timeline,indent=2)+'\n')
  assert any(s['state']=='streaming' for s in status.get('inputs',[])),timeline
  first=time.monotonic()-start
  invite_seconds=time.monotonic()-device.invited_at
  assert invite_seconds<=10, f'first publishing exceeded 10 seconds: {invite_seconds}'
  if args.recorder:
   sys.path.insert(0,str(ROOT/'recording-service/src'))
   from recorder.ffmpeg_recorder import build_reader_command,build_writer_command
   path=OUT/'recording.mp4'
   if path.exists():path.rename(OUT/f'recording-{time.time_ns()}.mp4')
   codec='h265' if args.video=='hevc' else 'h264'
   reader=build_reader_command('rtmp://127.0.0.1:11935/live/gb_fixture',codec)
   reader[-1:-1]=['-t','3']
   log=(OUT/'recorder.log').open('wb');logs.append(log)
   source=subprocess.Popen(reader,stdout=subprocess.PIPE,stderr=log);processes.append(source)
   sink=subprocess.Popen(build_writer_command(str(path),not args.silent,codec),stdin=source.stdout,stdout=log,stderr=log);processes.append(sink);source.stdout.close()
   assert source.wait(timeout=18)==0,'recorder reader failed'
   assert sink.wait(timeout=8)==0,'recorder writer failed'
  else:
   subprocess.run([str(BIN/'ffmpeg'),'-hide_banner','-loglevel','error','-rw_timeout','5000000','-i','rtmp://127.0.0.1:11935/live/gb_fixture','-t','2','-map','0:v:0','-map','0:a:0?','-c','copy','-y',str(OUT/'recording.mp4')],check=True,capture_output=True,timeout=12)
  result=subprocess.run([str(BIN/'ffprobe'),'-v','error','-show_streams','-of','json',str(OUT/'recording.mp4')],check=True,capture_output=True,timeout=5)
  streams=json.loads(result.stdout)['streams'];assert ({args.video} if args.silent else {args.video,'aac'})<={s['codec_name'] for s in streams}
  report={'passed':True,'version':args.version,'signaling':args.signaling,'media':args.media,'fixture':args.fixture,'scope':'independent SIP camera; gateway -> ZLM -> bridge -> isolated SRS -> MP4','productionRecorderCommands':args.recorder,'secondsFromRegistration':round(first,3),'secondsFromInviteToPublishing':round(invite_seconds,3),'realCameraVerified':False,'longRunVerified':False}
  (OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
 finally:
  if device and device.thread.is_alive():device.close()
  for p in reversed(processes):
   p.terminate()
   try:p.wait(timeout=8)
   except subprocess.TimeoutExpired:p.kill();p.wait()
  for log in logs:log.close()
  if srs_started:
   subprocess.run(['docker','stop','-t','3',name],capture_output=True,timeout=8)
   subprocess.run(['docker','rm',name],capture_output=True,timeout=8)

if __name__=='__main__':main()
