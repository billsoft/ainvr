#!/usr/bin/env python3
"""Bounded RTP/PS -> ZLM -> FFmpeg file probe. Does not certify SIP or SRS."""
import configparser
import json
from pathlib import Path
import secrets
import socket
import struct
import subprocess
import threading
import time
import urllib.parse
import urllib.request

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test/results/gb28181/media-probe'
ZLM=ROOT/'out/gb28181/ZLMediaKit'
BIN=ROOT/'out/gb28181/ffmpeg-runtime/bin'

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    records=[]
    with (ROOT/'out/gb28181/fixture.psrecords').open('rb') as source:
        while header:=source.read(8):
            pts,size=struct.unpack('!II',header)
            assert size<1048576
            records.append((pts,source.read(size)))
    config=configparser.ConfigParser(interpolation=None,strict=False)
    config.optionxform=str
    config.read(ZLM/'conf/config.ini')
    token=secrets.token_hex(32)
    for section,values in {'api':{'secret':token},'general':{'listen_ip':'127.0.0.1'},
      'http':{'port':'19580','sslport':'0'},'rtsp':{'port':'19554','sslport':'0'},
      'rtmp':{'port':'0','sslport':'0'},'rtp_proxy':{'port':'0'},'srt':{'port':'0'},
      'rtc':{'port':'0','tcpPort':'0','enableTurn':'0'},'onvif':{'port':'0'},'shell':{'port':'0'},
      'hook':{'enable':'0'},'protocol':{'enable_mp4':'0','enable_hls':'0','enable_hls_fmp4':'0','enable_rtsp':'1'}}.items():
        if section not in config:config[section]={}
        config[section].update(values)
    configpath=OUT/'private.ini'
    with configpath.open('w') as output:config.write(output,space_around_delimiters=False)
    configpath.chmod(0o600)
    for port,kind in [(19580,socket.SOCK_STREAM),(19554,socket.SOCK_STREAM),(32000,socket.SOCK_DGRAM)]:
        with socket.socket(socket.AF_INET,kind) as probe:
            probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            probe.bind(('127.0.0.1',port))
    def call(method,**params):
        data=urllib.parse.urlencode({'secret':token,**params}).encode()
        with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:19580/index/api/{method}',data=data),timeout=2) as response:
            result=json.load(response)
        assert result['code']==0,(method,result.get('msg'))
        return result
    stop=threading.Event()
    def send():
        seq=0;begin=time.monotonic();base=records[0][0]
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
            for pts,payload in records:
                if stop.wait(max(0,(pts-base)/90000-(time.monotonic()-begin))):return
                for offset in range(0,len(payload),1200):
                    fragment=payload[offset:offset+1200]
                    header=struct.pack('!BBHII',0x80,96|(128 if offset+1200>=len(payload) else 0),seq&65535,pts,123456)
                    sock.sendto(header+fragment,('127.0.0.1',32000));seq+=1
    with (OUT/'zlm.log').open('wb') as log:
        process=subprocess.Popen([str(ZLM/'release/linux/Release/MediaServer'),'-c',str(configpath),'-t','2','--affinity','0','-l','4','--log-dir',str(OUT/'logs'),'--log-size','2','--log-slice','2'],stdout=log,stderr=log)
        sender=None
        try:
            for attempt in range(50):
                try:call('getApiList');break
                except OSError:time.sleep(.1)
            call('openRtpServer',port=32000,stream_id='media_probe',tcp_mode=0,local_ip='127.0.0.1',ssrc=123456,re_use_port=0)
            sender=threading.Thread(target=send);sender.start()
            for attempt in range(40):
                try:
                    tracks=call('getMediaInfo',schema='rtsp',vhost='__defaultVhost__',app='rtp',stream='media_probe')
                    if len(tracks.get('tracks',[]))>=2:break
                except (AssertionError,OSError):pass
                time.sleep(.1)
            result=subprocess.run([str(BIN/'ffmpeg'),'-hide_banner','-loglevel','error','-rtsp_transport','tcp','-i','rtsp://127.0.0.1:19554/rtp/media_probe','-t','2','-map','0:v:0','-map','0:a:0','-c','copy','-y',str(OUT/'capture.mp4')],capture_output=True,timeout=12)
            if result.returncode:raise RuntimeError(result.stderr.decode()[-1500:])
            check=subprocess.run([str(BIN/'ffprobe'),'-v','error','-show_streams','-of','json',str(OUT/'capture.mp4')],capture_output=True,check=True,timeout=5)
            streams=json.loads(check.stdout)['streams']
            assert any(s['codec_name']=='h264' for s in streams)
            assert any(s['codec_name']=='aac' for s in streams)
            report={'passed':True,'scope':'UDP RTP/PS -> ZLM RTSP -> bridge MP4; H264/AAC','sipVerified':False,'srsVerified':False,'streams':[{'codec':s['codec_name'],'type':s['codec_type']} for s in streams]}
            (OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
        finally:
            stop.set()
            if sender:sender.join(timeout=2)
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait()

if __name__=='__main__':main()
