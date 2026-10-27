"""Independent socket GB device fixture. No gateway/SIP library imports."""
import hashlib
import re
import secrets
import socket
import struct
import threading
import time

class Device:
    def __init__(self,port,records,version='3.0',signaling='udp',mode='udp', *, server_host='127.0.0.1', local_ip='127.0.0.1'):
        self.id='34020000001320000001';self.channel='34020000001320000002'
        self.server='34020000002000000001';self.realm='3402000000'
        self.password='independent-test-device';self.version=version;self.signaling=signaling;self.mode=mode;self.buffer=b''
        self.destination=(server_host,port);self.local_ip=local_ip;self.records=records
        self.media_host=server_host;self.media_stop=threading.Event();self.send_lock=threading.Lock()
        self.sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM if signaling=='udp' else socket.SOCK_STREAM);self.sock.bind((local_ip,0));self.sock.settimeout(.2)
        self.local=f'{local_ip}:{self.sock.getsockname()[1]}'
        self.seq=0;self.stop=threading.Event();self.registered=threading.Event();self.error=None
        self.media=None;self.thread=threading.Thread(target=self.run);self.media_thread=None
        self.media_listener=None
        self.invited_at=None
    def send(self,data):
        with self.send_lock:
            if self.signaling=='udp':self.sock.sendto(data,self.destination)
            else:self.sock.sendall(data)
    def receive(self):
        if self.signaling=='udp':
            packet,source=self.sock.recvfrom(262144)
            if source!=self.destination:raise socket.timeout()
            return packet
        while True:
            pos=self.buffer.find(b'\r\n\r\n')
            if pos>=0:
                match=re.search(br'(?im)^Content-Length:\s*(\d+)',self.buffer[:pos]);length=int(match[1]) if match else 0
                if len(self.buffer)>=pos+4+length:
                    packet=self.buffer[:pos+4+length];self.buffer=self.buffer[pos+4+length:];return packet
            chunk=self.sock.recv(65536)
            if not chunk:raise ConnectionError('SIP connection closed')
            self.buffer+=chunk
            if len(self.buffer)>262144:raise ValueError('SIP fixture buffer exceeded')
    def request(self,method,body='',extra=''):
        self.seq+=1;uri=f'sip:{self.server}@{self.realm}'
        packet=(f'{method} {uri} SIP/2.0\r\nVia: SIP/2.0/{self.signaling.upper()} {self.local};branch=z9hG4bK-{secrets.token_hex(8)};rport\r\n'
          f'From: <sip:{self.id}@{self.realm}>;tag=independent-device\r\nTo: <{uri}>\r\nCall-ID: fixture-{self.seq}\r\nCSeq: {self.seq} {method}\r\n'
          f'Max-Forwards: 70\r\nContact: <sip:{self.id}@{self.local}>\r\nExpires: 3600\r\nX-GB-Ver: {self.version}\r\n{extra}'
          f'Content-Type: Application/MANSCDP+xml\r\nContent-Length: {len(body.encode())}\r\n\r\n{body}')
        self.send(packet.encode())
    def answer(self,headers,body=''):
        result='SIP/2.0 200 OK\r\n'
        for name in ['via','from','to','call-id','cseq']:
            value=headers[name]
            if name=='to' and ';tag=' not in value:value+=';tag=fixture-dialog'
            result+=f'{name}: {value}\r\n'
        result+=f'Contact: <sip:{self.id}@{self.local}>\r\nContent-Type: application/sdp\r\nContent-Length: {len(body.encode())}\r\n\r\n{body}'
        self.send(result.encode())
    def start(self):self.thread.start()
    def close(self):
        self.stop.set();self.media_stop.set();self.thread.join(timeout=3)
        if self.media_thread:self.media_thread.join(timeout=3)
        if self.media_listener:self.media_listener.close()
        self.sock.close()
    def run(self):
        try:
            if self.signaling=='tcp':self.sock.connect(self.destination)
            self.request('REGISTER');last=time.monotonic();next_register=last+1800
            while not self.stop.is_set():
                if time.monotonic()>=next_register:
                    self.request('REGISTER');next_register=time.monotonic()+1800
                try:data=self.receive()
                except socket.timeout:
                    if self.registered.is_set() and time.monotonic()-last>10:
                        self.request('MESSAGE',f'<Notify><CmdType>Keepalive</CmdType><SN>10</SN><DeviceID>{self.id}</DeviceID><Status>OK</Status></Notify>');last=time.monotonic()
                    continue
                head,body=data.decode().split('\r\n\r\n',1);lines=head.split('\r\n')
                headers={k.lower():v.strip() for k,v in (line.split(':',1) for line in lines[1:])}
                if lines[0].startswith('SIP/2.0 401'):
                    nonce=re.search('nonce="([^"]+)"',headers['www-authenticate'])[1]
                    md5=lambda s:hashlib.md5(s.encode()).hexdigest()
                    uri=f'sip:{self.server}@{self.realm}'
                    value=md5(md5(f'{self.id}:{self.realm}:{self.password}')+':'+nonce+':00000001:fixture:auth:'+md5('REGISTER:'+uri))
                    self.request('REGISTER',extra=f'Authorization: Digest username="{self.id}", realm="{self.realm}", nonce="{nonce}", uri="{uri}", response="{value}", algorithm=MD5, qop=auth, nc=00000001, cnonce="fixture"\r\n')
                elif lines[0].startswith('SIP/2.0 200') and headers['cseq'].endswith('REGISTER'):self.registered.set()
                elif lines[0].startswith('MESSAGE '):
                    self.answer(headers)
                    if '<CmdType>Catalog</CmdType>' in body:
                        sn=re.search(r'<SN>(\d+)</SN>',body)[1]
                        self.request('MESSAGE',f'<Response><CmdType>Catalog</CmdType><SN>{sn}</SN><DeviceID>{self.id}</DeviceID><SumNum>1</SumNum><DeviceList Num="1"><Item><DeviceID>{self.channel}</DeviceID><Name>Independent fixture</Name><Status>ON</Status></Item></DeviceList></Response>')
                    elif '<CmdType>DeviceInfo</CmdType>' in body or '<CmdType>DeviceStatus</CmdType>' in body:
                        sn=re.search(r'<SN>(\d+)</SN>',body)[1]
                        command=re.search(r'<CmdType>(\w+)</CmdType>',body)[1]
                        extra='<DeviceName>Independent fixture</DeviceName><Manufacturer>Socket fixture</Manufacturer><Model>Test</Model><Firmware>1</Firmware>' if command=='DeviceInfo' else '<Online>ONLINE</Online><Status>OK</Status>'
                        self.request('MESSAGE',f'<Response><CmdType>{command}</CmdType><SN>{sn}</SN><DeviceID>{self.id}</DeviceID><Result>OK</Result>{extra}</Response>')
                elif lines[0].startswith('INVITE '):
                    self.invited_at=time.monotonic()
                    port=int(re.search(r'm=video (\d+)',body)[1]);ssrc=int(re.search(r'y=(\d+)',body)[1])
                    host=re.search(r'c=IN IP4 ([0-9.]+)',body)[1]
                    if host!=self.destination[0]:raise ValueError('unexpected media destination')
                    self.media_host=host
                    self.media=(port,ssrc)
                    protocol='RTP/AVP' if self.mode=='udp' else 'TCP/RTP/AVP'
                    setup='' if self.mode=='udp' else ('a=setup:active\r\na=connection:new\r\n' if self.mode=='tcp-passive' else 'a=setup:passive\r\na=connection:new\r\n')
                    if self.mode=='tcp-active' and self.media_listener is None:
                        self.media_listener=socket.socket();self.media_listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);self.media_listener.bind((self.local_ip,0));self.media_listener.listen(1);self.media_listener.settimeout(5)
                    answer_port=self.media_listener.getsockname()[1] if self.mode=='tcp-active' else 33000
                    answer=f'v=0\r\no={self.channel} 0 0 IN IP4 {self.local_ip}\r\ns=Play\r\nc=IN IP4 {self.local_ip}\r\nt=0 0\r\nm=video {answer_port} {protocol} 96\r\na=sendonly\r\na=rtpmap:96 PS/90000\r\n{setup}y={ssrc:010d}\r\n'
                    self.answer(headers,answer)
                elif lines[0].startswith('ACK ') and self.media and not self.media_thread:
                    self.media_stop.clear();self.media_thread=threading.Thread(target=self.send_media);self.media_thread.start()
                elif lines[0].startswith('BYE '):
                    self.answer(headers);self.media_stop.set()
                    if self.media_thread:self.media_thread.join(timeout=3)
                    self.media_thread=None;self.media=None
        except Exception as error:self.error=repr(error)
    def send_media(self):
        port,ssrc=self.media;seq=0;begin=time.monotonic();base=self.records[0][0]
        connection=socket.socket(socket.AF_INET,socket.SOCK_DGRAM if self.mode=='udp' else socket.SOCK_STREAM)
        if self.mode=='tcp-active':connection.close();connection,_=self.media_listener.accept()
        elif self.mode=='tcp-passive':connection.settimeout(5);connection.connect((self.media_host,port))
        with connection as sock:
            for pts,payload in self.records:
                if self.media_stop.wait(max(0,(pts-base)/90000-(time.monotonic()-begin))) or self.stop.is_set():return
                for offset in range(0,len(payload),1200):
                    fragment=payload[offset:offset+1200]
                    packet=struct.pack('!BBHII',0x80,96|(128 if offset+1200>=len(payload) else 0),seq&65535,pts,ssrc)+fragment
                    if self.mode=='udp':sock.sendto(packet,(self.media_host,port))
                    else:sock.sendall(struct.pack('!H',len(packet))+packet)
                    seq+=1
