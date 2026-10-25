#!/usr/bin/env python3
"""Bounded 2/4-channel soak with real-time remuxed PS and isolated SRS.

No video decode/encode, no production configuration edits. All child processes
belong to this fixture. Stops on missing streams, resource limits or timeout.
"""
import argparse
import configparser
import fcntl
import json
import os
import hashlib
from pathlib import Path
import secrets
import signal
import socket
import struct
import subprocess
import threading
import time
import urllib.request
from device_simulator import Device

ROOT=Path(__file__).resolve().parents[2]
BIN=ROOT/'out/gb28181/ffmpeg-runtime/bin'
GATEWAY=Path(os.environ.get('AINVR_GB_TEST_GATEWAY',str(ROOT/'out/gb28181/gateway'))).resolve()

class ContinuousDevice(Device):
    def __init__(self,index,version,signaling,video,audio,log):
        super().__init__(15060,[],version,signaling,'tcp-passive')
        self.id=f'3402000000132000{index*2+1:04d}'
        self.channel=f'3402000000132000{index*2+2:04d}'
        self.video=video;self.audio=audio;self.log=log;self.media_error=None
    def send_media(self):
        source=None;converter=None
        try:
            fixture=ROOT/f'out/gb28181/{self.video}-aac.ts' if self.audio=='aac' else ROOT/f'out/gb28181/{"video" if self.video=="h264" else "hevc"}.ts'
            source=subprocess.Popen([str(BIN/'ffmpeg'),'-hide_banner','-loglevel','error','-re','-stream_loop','-1','-i',str(fixture),'-map','0','-c','copy','-f','mpegts','pipe:1'],stdout=subprocess.PIPE,stderr=self.log)
            command=[str(ROOT/'out/gb28181/ps_fixture')]
            if self.audio in ('alaw','mulaw'):command += [str(ROOT/f'out/gb28181/tone.{self.audio}'),'144' if self.audio=='alaw' else '145']
            converter=subprocess.Popen(command,stdin=source.stdout,stdout=subprocess.PIPE,stderr=self.log);source.stdout.close()
            port,ssrc=self.media;seq=0;begin=time.monotonic();last=None;elapsed=0
            def read_exact(size):
                data=b''
                while len(data)<size:
                    chunk=converter.stdout.read(size-len(data))
                    if not chunk:raise EOFError('media generator ended')
                    data+=chunk
                return data
            with socket.create_connection(('127.0.0.1',port),timeout=3) as media:
                media.settimeout(3)
                while not self.stop.is_set():
                    pts,size=struct.unpack('!II',read_exact(8))
                    if size>1048576:raise ValueError('PS packet exceeds fixture limit')
                    payload=read_exact(size)
                    if last is not None:elapsed += ((pts-last+(1<<31))%(1<<32))-(1<<31)
                    last=pts
                    if self.stop.wait(max(0,elapsed/90000-(time.monotonic()-begin))):break
                    for offset in range(0,size,1200):
                        fragment=payload[offset:offset+1200]
                        packet=struct.pack('!BBHII',0x80,96|(128 if offset+1200>=size else 0),seq&65535,pts,ssrc)+fragment
                        media.sendall(struct.pack('!H',len(packet))+packet);seq+=1
        except Exception as error:
            if not self.stop.is_set():self.media_error=type(error).__name__
        finally:
            for proc in [converter,source]:
                if proc is not None:
                    proc.terminate()
                    try:proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:proc.kill();proc.wait()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--channels',type=int,choices=[2,4],required=True);parser.add_argument('--seconds',type=int,required=True)
    args=parser.parse_args();assert 30<=args.seconds<=86400
    out=ROOT/f'test/results/gb28181/soak-{args.channels}-{int(time.time())}';out.mkdir(parents=True)
    lock=(ROOT/'out/gb28181/media-test.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    for port in [19580,19554,11935,11985,19096,15060]:
        with socket.socket() as sock:sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);sock.bind(('127.0.0.1',port))
    token=secrets.token_hex(32);secret=secrets.token_hex(32);zlm=ROOT/'out/gb28181/ZLMediaKit'
    cfg=configparser.ConfigParser(interpolation=None,strict=False);cfg.optionxform=str;cfg.read(zlm/'conf/config.ini')
    for section,values in {'api':{'secret':secret},'general':{'listen_ip':'127.0.0.1'},'http':{'port':'19580','sslport':'0'},'rtsp':{'port':'19554','sslport':'0'},'rtmp':{'port':'0','sslport':'0'},'rtp_proxy':{'port':'0'},'srt':{'port':'0'},'rtc':{'port':'0','tcpPort':'0','enableTurn':'0'},'onvif':{'port':'0'},'shell':{'port':'0'},'hook':{'enable':'0'},'protocol':{'enable_mp4':'0','enable_hls':'0','enable_rtsp':'1'}}.items():
        if section not in cfg:cfg[section]={}
        cfg[section].update(values)
    with (out/'media.ini').open('w') as f:cfg.write(f,space_around_delimiters=False)
    (out/'media.ini').chmod(0o600)
    (out/'bootstrap.json').write_text(json.dumps({'listen':'127.0.0.1:19096','token':token}));(out/'bootstrap.json').chmod(0o600)
    (out/'srs.conf').write_text('listen 127.0.0.1:11935;\ndaemon off;\nsrs_log_tank console;\nmax_connections 32;\nhttp_api { enabled on; listen 127.0.0.1:11985; }\nvhost __defaultVhost__ { }\n')
    processes=[];logs=[];devices=[];srs=False;report={'passed':False,'channels':args.channels,'requestedSeconds':args.seconds,'realCameraVerified':False,'output':str(out)}
    def spawn(command,name):
        log=(out/name).open('wb');logs.append(log);proc=subprocess.Popen(command,stdout=log,stderr=log);processes.append(proc);return proc
    def api(path,body=None):
        req=urllib.request.Request('http://127.0.0.1:19096'+path,data=None if body is None else json.dumps(body).encode(),headers={'X-Service-Token':token,'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=20) as response:return json.load(response)
    def resources():
        table={}
        for p in Path('/proc').iterdir():
            if not p.name.isdigit():continue
            try:
                v=(p/'stat').read_text().rsplit(')',1)[1].split();table[int(p.name)]=(int(v[1]),int(v[11])+int(v[12]),int(v[21])*os.sysconf('SC_PAGE_SIZE'))
            except (OSError,ValueError,IndexError):pass
        members={os.getpid()}
        for _ in range(8):members |= {pid for pid,(parent,_,_) in table.items() if parent in members}
        usage=[table[pid] for pid in members if pid in table]
        return {'rssBytes':sum(v[2] for v in usage),'cpuTicks':sum(v[1] for v in usage),'processes':len(usage)}
    start=None
    try:
        subprocess.run(['docker','run','-d','--name','ainvr-gb-soak-srs','--network','host','--memory','256m','--cpus','1','--label','ainvr.task=gb28181-test','-v',str(out/'srs.conf')+':/usr/local/srs/conf/probe.conf:ro','ossrs/srs:7.0.162','./objs/srs','-c','conf/probe.conf'],check=True,capture_output=True,timeout=15);srs=True
        spawn([str(zlm/'release/linux/Release/MediaServer'),'-c',str(out/'media.ini'),'-t','2','--affinity','0','-l','4','--log-dir',str(out/'logs'),'--log-size','2','--log-slice','2'],'media.log')
        (out/'build.json').write_text(json.dumps({'gateway':str(GATEWAY),'sha256':hashlib.sha256(GATEWAY.read_bytes()).hexdigest()}))
        spawn([str(GATEWAY),'--bootstrap',str(out/'bootstrap.json')],'gateway.log')
        for _ in range(50):
            try:api('/v1/status');break
            except OSError:time.sleep(.1)
        for index in range(args.channels):
            log=(out/f'generator-{index}.log').open('wb');logs.append(log)
            devices.append(ContinuousDevice(index,'2.0' if index%2==0 else '3.0','udp' if index%2==0 else 'tcp','h264' if index%2==0 else 'hevc',['aac','alaw','mulaw','aac'][index],log))
        platform='34020000002000000001'
        api('/v1/config',{'revision':1,'enabled':True,'sip':{'serverId':platform,'realm':'3402000000','listen':'127.0.0.1:15060','advertiseIp':'127.0.0.1','maxDevices':4,'maxCatalogItems':100,'heartbeatTimeoutSec':60,'devices':[{'id':d.id,'password':d.password,'version':'auto','enabled':True} for d in devices]},'media':{'domainId':platform,'api':'http://127.0.0.1:19580','secret':secret,'listenIp':'127.0.0.1','advertiseIp':'127.0.0.1','portStart':32000,'portEnd':32020,'capacity':args.channels},'bridge':{'ffmpeg':str(BIN/'ffmpeg'),'httpBase':'http://127.0.0.1:19580','rtspBase':'rtsp://127.0.0.1:19554','rtmpBase':'rtmp://127.0.0.1:11935'},'srsApi':'http://127.0.0.1:11985','bindings':[{'id':f'fixture-{i}','deviceId':d.id,'channelId':d.channel,'app':'live','stream':f'gb_fixture_{i}','mode':'tcp-passive','enabled':True} for i,d in enumerate(devices)]})
        for _ in range(40):
            if api('/v1/status').get('ready'):break
            time.sleep(.1)
        for device in devices:device.start()
        deadline=time.monotonic()+40
        while True:
            status=api('/v1/status')
            if len(status.get('inputs',[]))==args.channels and all(i['state']=='streaming' for i in status['inputs']):break
            if time.monotonic()>deadline:raise RuntimeError('initial media readiness timeout')
            time.sleep(.5)
        start=time.monotonic();initial={i['id']:i['generation'] for i in status['inputs']};max_rss=0;samples=0
        with (out/'metrics.jsonl').open('w') as metrics:
            while time.monotonic()-start<args.seconds:
                status=api('/v1/status');usage=resources();samples+=1;max_rss=max(max_rss,usage['rssBytes'])
                sample={'seconds':round(time.monotonic()-start,2),**usage,'inputs':[{k:i.get(k) for k in ('id','state','reason','generation')} for i in status.get('inputs',[])]}
                metrics.write(json.dumps(sample)+'\n');metrics.flush()
                if len(sample['inputs'])!=args.channels or any(i['state']!='streaming' or i['generation']!=initial[i['id']] for i in sample['inputs']):raise RuntimeError('stream interrupted or restarted')
                if any(d.error or d.media_error for d in devices):raise RuntimeError('simulated device failed')
                if usage['rssBytes']>1024*1024*1024:raise RuntimeError('fixture resource budget exceeded')
                for log in logs:
                    if log.tell()>4*1024*1024:raise RuntimeError('fixture log budget exceeded')
                time.sleep(min(5,max(0,args.seconds-(time.monotonic()-start))))
        report.update(passed=True,elapsedSeconds=round(time.monotonic()-start,2),maxRssBytes=max_rss,samples=samples)
    except Exception as error:
        report.update(error=str(error),elapsedSeconds=None if start is None else round(time.monotonic()-start,2));raise
    finally:
        for d in devices:
            if d.thread.is_alive():d.close()
        for proc in reversed(processes):
            proc.terminate()
            try:proc.wait(timeout=8)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()
        for log in logs:log.close()
        if srs:
            subprocess.run(['docker','stop','-t','3','ainvr-gb-soak-srs'],capture_output=True,timeout=8)
            subprocess.run(['docker','rm','ainvr-gb-soak-srs'],capture_output=True,timeout=8)
        (out/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)

if __name__=='__main__':
    def interrupted(signum, frame):
        raise InterruptedError('bounded soak interrupted')
    signal.signal(signal.SIGTERM,interrupted)
    main()
