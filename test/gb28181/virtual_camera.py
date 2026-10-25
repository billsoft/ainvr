#!/usr/bin/env python3
"""Bounded Windows/Linux GB camera: SIP + RTP/PS, no gateway code imports.

Prepared PS records contain compressed video/audio, not raw images. This tool
never decodes or encodes video. Password is prompted, never a command argument.
"""
import argparse
import getpass
import ipaddress
import json
from pathlib import Path
import socket
import statistics
import struct
import time
from device_simulator import Device

MASK = (1 << 33) - 1

def shift_pts(data, offset, delta):
    b = data[offset:offset+5]
    if len(b) != 5 or not all(b[i] & 1 for i in (0,2,4)):
        raise ValueError('invalid PES timestamp')
    value = (((b[0] >> 1) & 7) << 30) | (b[1] << 22) | ((b[2] >> 1) << 15) | (b[3] << 7) | (b[4] >> 1)
    value = (value + delta) & MASK
    data[offset:offset+5] = bytes([(b[0] & 0xf1) | ((value >> 29) & 14), (value >> 22) & 255, ((value >> 14) & 254) | 1, (value >> 7) & 255, ((value << 1) & 254) | 1])

def shift_ps(payload, delta):
    data = bytearray(payload)
    pos = 0
    while pos < len(data):
        if data[pos:pos+3] != b'\x00\x00\x01' or pos+4 > len(data):
            raise ValueError('invalid PS packet boundary')
        code = data[pos+3]
        if code == 0xba:
            if pos+14 > len(data) or data[pos+4] & 0xc0 != 0x40:
                raise ValueError('expected MPEG2 pack')
            b = data[pos+4:pos+10]
            scr = (((b[0] >> 3) & 7) << 30) | ((b[0] & 3) << 28) | (b[1] << 20) | ((b[2] >> 3) << 15) | ((b[2] & 3) << 13) | (b[3] << 5) | (b[4] >> 3)
            scr = (scr + delta) & MASK
            data[pos+4:pos+9] = bytes([(b[0] & 0xc4) | ((scr >> 27) & 0x38) | ((scr >> 28) & 3), (scr >> 20) & 255, (b[2] & 4) | ((scr >> 12) & 0xf8) | ((scr >> 13) & 3), (scr >> 5) & 255, (b[4] & 7) | ((scr << 3) & 0xf8)])
            pos += 14 + (data[pos+13] & 7)
        elif code == 0xb9:
            pos += 4
        else:
            if pos+6 > len(data): raise ValueError('truncated PS header')
            length = int.from_bytes(data[pos+4:pos+6], 'big')
            end = pos+6+length
            if not length or end > len(data): raise ValueError('truncated PS payload')
            if 0xc0 <= code <= 0xef or code == 0xbd:
                if pos+9 > end: raise ValueError('truncated PES header')
                flags = data[pos+7] & 0xc0
                if flags in (0x80,0xc0):
                    if pos+14 > end: raise ValueError('truncated PTS')
                    shift_pts(data,pos+9,delta)
                if flags == 0xc0:
                    if pos+19 > end: raise ValueError('truncated DTS')
                    shift_pts(data,pos+14,delta)
            pos = end
    if pos != len(data): raise ValueError('truncated PS pack')
    return bytes(data)

def load_records(path):
    if path.stat().st_size > 128*1024*1024: raise ValueError('sample exceeds 128 MiB')
    records=[]
    with path.open('rb') as source:
        while header := source.read(8):
            if len(header)!=8: raise ValueError('truncated record header')
            pts,size=struct.unpack('!II',header)
            if not 0 < size <= 1048576: raise ValueError('invalid record size')
            payload=source.read(size)
            if len(payload)!=size: raise ValueError('truncated record')
            shift_ps(payload,0)
            records.append((pts,payload))
    if not records: raise ValueError('empty sample')
    return records

class Camera(Device):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.media_error=None; self.packets=0; self.bytes_sent=0
    def send_media(self):
        try:
            port,ssrc=self.media
            values=sorted(set(pts for pts,_ in self.records))
            steps=[b-a for a,b in zip(values,values[1:]) if 0 < b-a < 90000]
            if not steps: raise ValueError('sample must contain multiple timestamps')
            span=values[-1]-values[0]+max(steps)
            if span > 90000*600: raise ValueError('sample exceeds ten minutes')
            sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM if self.mode=='udp' else socket.SOCK_STREAM)
            sock.settimeout(3)
            if self.mode=='tcp-active':
                sock.close();sock,_=self.media_listener.accept();sock.settimeout(3)
            elif self.mode=='tcp-passive': sock.connect((self.media_host,port))
            cycle=0;seq=0;start=time.monotonic()
            with sock:
                while not self.stop.is_set() and not self.media_stop.is_set():
                    for pts,payload in self.records:
                        elapsed=pts-values[0]+cycle*span
                        if self.media_stop.wait(max(0,elapsed/90000-(time.monotonic()-start))) or self.stop.is_set(): return
                        payload=shift_ps(payload,cycle*span)
                        for offset in range(0,len(payload),1200):
                            chunk=payload[offset:offset+1200]
                            packet=struct.pack('!BBHII',0x80,96|(128 if offset+1200>=len(payload) else 0),seq&65535,(pts+cycle*span)&0xffffffff,ssrc)+chunk
                            if self.mode=='udp': sock.sendto(packet,(self.media_host,port))
                            else: sock.sendall(struct.pack('!H',len(packet))+packet)
                            seq+=1;self.packets+=1;self.bytes_sent+=len(packet)
                    cycle+=1
        except Exception as error:
            if not self.stop.is_set() and not self.media_stop.is_set(): self.media_error=type(error).__name__

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server',required=True,type=ipaddress.IPv4Address)
    parser.add_argument('--local-ip',required=True,type=ipaddress.IPv4Address)
    parser.add_argument('--port',type=int,default=5060)
    parser.add_argument('--server-id',default='34020000002000000001')
    parser.add_argument('--device-id',default='34020000001320000001')
    parser.add_argument('--channel-id',default='34020000001320000002')
    parser.add_argument('--realm',default='3402000000')
    parser.add_argument('--version',choices=['2016','2022'],default='2016')
    parser.add_argument('--signaling',choices=['udp','tcp'],default='tcp')
    parser.add_argument('--media',choices=['udp','tcp-passive','tcp-active'],default='tcp-passive',help='gateway role for TCP')
    parser.add_argument('--sample',type=Path,required=True)
    parser.add_argument('--seconds',type=int,default=300)
    parser.add_argument('--report',type=Path)
    parser.add_argument('--isolated-test',action='store_true',help='use public fixture credential ONLY with isolated test gateway')
    args=parser.parse_args()
    if not 1<=args.port<=65535 or not 10<=args.seconds<=86400: parser.error('invalid port or duration (10..86400 seconds)')
    for value in (args.server_id,args.device_id,args.channel_id):
        if len(value)!=20 or not value.isascii() or not value.isdigit(): parser.error('IDs must contain exactly 20 digits')
    if not args.realm.isascii() or not args.realm.isdigit(): parser.error('realm must be numeric')
    records=load_records(args.sample)
    password='independent-test-device' if args.isolated_test else getpass.getpass('Device password: ')
    camera=Camera(args.port,records,'2.0' if args.version=='2016' else '3.0',args.signaling,args.media,server_host=str(args.server),local_ip=str(args.local_ip))
    camera.server=args.server_id;camera.id=args.device_id;camera.channel=args.channel_id;camera.realm=args.realm;camera.password=password
    began=time.monotonic();camera.start();report={}
    try:
        if not camera.registered.wait(15): raise RuntimeError('registration timed out; check device identity, password and network')
        print('Registered; waiting for platform invitation.',flush=True)
        while time.monotonic()-began<args.seconds:
            if camera.error or camera.media_error: raise RuntimeError(camera.media_error or 'SIP connection failed')
            time.sleep(.2)
        if not camera.packets: raise RuntimeError('no media invitation or packets sent')
        report['passed']=True
    except KeyboardInterrupt:
        report['passed']=False;report['reason']='user stopped'
    except Exception as error:
        report['passed']=False;report['reason']=str(error)
    finally:
        camera.close();report.update(registered=camera.registered.is_set(),packets=camera.packets,bytes=camera.bytes_sent,seconds=round(time.monotonic()-began,2),receiverVerified=False)
        if args.report: args.report.write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps(report),flush=True)
    return 0 if report.get('passed') else 1

if __name__=='__main__': raise SystemExit(main())
