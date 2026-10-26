#!/usr/bin/env python3
"""Independent ONVIF test device. Media is supplied by a separate RTSP server.

This fixture never imports the AINVR client or its message builders. Config is
loaded from a private JSON file; credentials are not printed or accepted in argv.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import socket
import uuid
from pathlib import Path
import threading
import time
from urllib.request import parse_http_list, parse_keqv_list
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

SOAP = 'http://www.w3.org/2003/05/soap-envelope'
DEVICE = 'http://www.onvif.org/ver10/device/wsdl'
MEDIA1 = 'http://www.onvif.org/ver10/media/wsdl'
MEDIA2 = 'http://www.onvif.org/ver20/media/wsdl'
SCHEMA = 'http://www.onvif.org/ver10/schema'
WSSE = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd'
WSU = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd'


class Camera:
    def __init__(self, config):
        self.config = config
        self.key = os.urandom(32)
        self.replays = {}
        self.lock = threading.Lock()
        self.requests = {}
        self.auth_failures = 0

    def config_now(self):
        return json.loads(self.config.read_text())

    def nonce(self):
        bucket = str(int(time.time() // 60))
        return bucket + ':' + hmac.new(self.key, bucket.encode(), 'sha256').hexdigest()

    def authenticate(self, root, header, path, config):
        # Reject dual authentication, exercising Core 5.9.1 independently.
        token = root.find('.//{%s}UsernameToken' % WSSE)
        if header and token is not None:
            return False
        mode = config.get('authentication', 'wsse')
        if mode == 'none':
            return True
        if mode == 'digest' and header.startswith('Digest '):
            try:
                fields = parse_keqv_list(parse_http_list(header[7:]))
                if fields['nonce'] != self.nonce() or fields['uri'] != path or fields['realm'] != 'fixture':
                    return False
                if fields['username'] != config['username'] or fields['qop'] != 'auth':
                    return False
                md5 = lambda x: hashlib.md5(x.encode()).hexdigest()
                a1 = md5(config['username'] + ':fixture:' + config['password'])
                a2 = md5('POST:' + path)
                expected = md5(':'.join((a1, fields['nonce'], fields['nc'], fields['cnonce'], 'auth', a2)))
                if not hmac.compare_digest(expected, fields['response']):
                    return False
                key = ('digest', fields['nonce'], fields['cnonce'])
                count = int(fields['nc'], 16)
                with self.lock:
                    self.trim()
                    if count <= self.replays.get(key, (0, 0))[1]:
                        return False
                    self.replays[key] = (time.time(), count)
                return True
            except (KeyError, ValueError):
                return False
        if mode != 'wsse' or token is None:
            return False
        try:
            username = token.findtext('{%s}Username' % WSSE)
            nonce_text = token.findtext('{%s}Nonce' % WSSE)
            created = token.findtext('{%s}Created' % WSU)
            password = token.findtext('{%s}Password' % WSSE)
            when = datetime.fromisoformat(created.replace('Z', '+00:00')).timestamp()
            if abs(time.time() + config.get('clock_offset_seconds', 0) - when) > 60:
                return False
            nonce = base64.b64decode(nonce_text, validate=True)
            expected = base64.b64encode(hashlib.sha1(nonce + created.encode() + config['password'].encode()).digest()).decode()
            if username != config['username'] or not hmac.compare_digest(expected, password):
                return False
            with self.lock:
                self.trim()
                key = ('wsse', username, nonce_text)
                if key in self.replays:
                    return False
                self.replays[key] = (time.time(), 1)
            return True
        except (ValueError, TypeError, AttributeError):
            return False

    def trim(self):
        self.replays = {key: value for key, value in self.replays.items() if time.time() - value[0] < 120}
        if len(self.replays) >= 2048:
            self.replays.pop(next(iter(self.replays)))


class Handler(BaseHTTPRequestHandler):
    server_version = 'AINVR-ONVIF-Test-Device'
    def log_message(self, *_args):
        pass

    def send_xml(self, action, namespace, content, status=200):
        body = ('<env:Envelope xmlns:env="%s"><env:Body><r:%sResponse xmlns:r="%s" xmlns:t="%s">%s</r:%sResponse></env:Body></env:Envelope>' %
                (SOAP, action, namespace, SCHEMA, content, action)).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/soap+xml; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def fault(self, reason):
        body = ('<env:Envelope xmlns:env="%s"><env:Body><env:Fault><env:Code><env:Value>env:Sender</env:Value><env:Subcode><env:Value xmlns:err="http://www.onvif.org/ver10/error">err:%s</env:Value></env:Subcode></env:Code><env:Reason><env:Text xml:lang="en">Fixture operation rejected</env:Text></env:Reason></env:Fault></env:Body></env:Envelope>' % (SOAP, reason)).encode()
        self.send_response(400)
        self.send_header('Content-Type', 'application/soap+xml')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.connection.settimeout(5)
        camera = self.server.camera
        config = camera.config_now()
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 32768:
                self.send_error(413)
                return
            body = self.rfile.read(length)
            if b'<!DOCTYPE' in body or b'<!ENTITY' in body:
                raise ValueError()
            root = ET.fromstring(body)
            soap_body = root.find('{%s}Body' % SOAP)
            if root.tag != '{%s}Envelope' % SOAP or soap_body is None or len(soap_body) != 1:
                raise ValueError()
            request = soap_body[0]
            namespace, action = request.tag[1:].split('}')
        except (ValueError, ET.ParseError):
            self.send_error(400)
            return
        with camera.lock:
            camera.requests[action] = camera.requests.get(action, 0) + 1
        if action != 'GetSystemDateAndTime' and not camera.authenticate(root, self.headers.get('Authorization', ''), self.path, config):
            if config.get('authentication') == 'digest':
                self.send_response(401)
                self.send_header('WWW-Authenticate', 'Digest realm="fixture", nonce="%s", algorithm=MD5, qop="auth"' % camera.nonce())
                self.send_header('Content-Length', '0')
                self.end_headers()
            else:
                camera.auth_failures += 1
                self.fault('NotAuthorized')
            return
        base = config['base_url'].rstrip('/')
        media_services = config.get('media_services', ['media1', 'media2'])
        profiles = config['profiles']
        if namespace == DEVICE and action == 'GetSystemDateAndTime':
            at = datetime.fromtimestamp(time.time() + config.get('clock_offset_seconds', 0), timezone.utc)
            self.send_xml(action, namespace, '<r:SystemDateAndTime><t:UTCDateTime><t:Time><t:Hour>%s</t:Hour><t:Minute>%s</t:Minute><t:Second>%s</t:Second></t:Time><t:Date><t:Year>%s</t:Year><t:Month>%s</t:Month><t:Day>%s</t:Day></t:Date></t:UTCDateTime></r:SystemDateAndTime>' % (at.hour, at.minute, at.second, at.year, at.month, at.day))
        elif namespace == DEVICE and action == 'GetDeviceInformation':
            self.send_xml(action, namespace, '<r:Manufacturer>AINVR independent fixture</r:Manufacturer><r:Model>Virtual two-source NVR</r:Model><r:FirmwareVersion>1</r:FirmwareVersion><r:SerialNumber>simulator-1</r:SerialNumber><r:HardwareId>test-only</r:HardwareId>')
        elif namespace == DEVICE and action == 'GetServices':
            services = ''.join('<r:Service><r:Namespace>%s</r:Namespace><r:XAddr>%s/%s</r:XAddr><r:Version><t:Major>%s</t:Major><t:Minor>0</t:Minor></r:Version></r:Service>' % (MEDIA1 if service == 'media1' else MEDIA2, escape(base), service, 1 if service == 'media1' else 2) for service in media_services)
            self.send_xml(action, namespace, services)
        elif namespace in (MEDIA1, MEDIA2) and action == 'GetProfiles':
            version = 'media1' if namespace == MEDIA1 else 'media2'
            if version not in media_services:
                self.fault('ActionNotSupported')
                return
            result = []
            for p in profiles:
                resolution = '<t:Encoding>%s</t:Encoding><t:Resolution><t:Width>%s</t:Width><t:Height>%s</t:Height></t:Resolution><t:RateControl><t:FrameRateLimit>%s</t:FrameRateLimit></t:RateControl>' % (escape(p.get('video_codec', 'H264')), p.get('width', 640), p.get('height', 360), p.get('fps', 10))
                if namespace == MEDIA1:
                    configs = '<t:VideoSourceConfiguration token="vsc"><t:SourceToken>%s</t:SourceToken></t:VideoSourceConfiguration><t:VideoEncoderConfiguration token="vec">%s</t:VideoEncoderConfiguration>' % (escape(p['video_source']), resolution)
                    if p.get('audio_codec'):
                        configs += '<t:AudioEncoderConfiguration token="aec"><t:Encoding>%s</t:Encoding></t:AudioEncoderConfiguration>' % escape(p['audio_codec'])
                else:
                    configs = '<r:Configurations><r:VideoSource token="vsc"><t:SourceToken>%s</t:SourceToken></r:VideoSource><r:VideoEncoder token="vec">%s</r:VideoEncoder>' % (escape(p['video_source']), resolution)
                    if p.get('audio_codec'):
                        configs += '<r:AudioEncoder token="aec"><t:Encoding>%s</t:Encoding></r:AudioEncoder>' % escape(p['audio_codec'])
                    configs += '</r:Configurations>'
                result.append('<r:Profiles token="%s"><r:Name>%s</r:Name>%s</r:Profiles>' % (escape(p['token']), escape(p.get('name', p['token'])), configs))
            self.send_xml(action, namespace, ''.join(result))
        elif namespace in (MEDIA1, MEDIA2) and action == 'GetStreamUri':
            token = request.findtext('{%s}ProfileToken' % namespace)
            profile = next((p for p in profiles if p['token'] == token), None)
            if not profile:
                self.fault('InvalidArgVal')
                return
            if namespace == MEDIA2 and request.findtext('{%s}Protocol' % MEDIA2) != 'RTSP':
                self.fault('InvalidArgVal')
                return
            if namespace == MEDIA1 and request.find('{%s}StreamSetup' % MEDIA1) is None:
                self.fault('InvalidArgVal')
                return
            uri = escape(profile['rtsp_uri'])
            content = '<r:Uri>%s</r:Uri>' % uri if namespace == MEDIA2 else '<r:MediaUri><t:Uri>%s</t:Uri><t:InvalidAfterConnect>false</t:InvalidAfterConnect><t:InvalidAfterReboot>false</t:InvalidAfterReboot><t:Timeout>PT0S</t:Timeout></r:MediaUri>' % uri
            self.send_xml(action, namespace, content)
        else:
            self.fault('ActionNotSupported')


class DiscoveryResponder:
    """Independent WS-Discovery wire fixture, only on an explicit IPv4 NIC."""
    def __init__(self, camera, interface_address):
        self.camera=camera
        self.stopped=threading.Event()
        self.socket=socket.socket(socket.AF_INET,socket.SOCK_DGRAM,socket.IPPROTO_UDP)
        self.socket.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        self.socket.bind(('',3702))
        self.socket.setsockopt(socket.IPPROTO_IP,socket.IP_ADD_MEMBERSHIP,socket.inet_aton('239.255.255.250')+socket.inet_aton(interface_address))
        self.socket.settimeout(.5)
        self.thread=threading.Thread(target=self.run,daemon=True)
        self.thread.start()
    def run(self):
        addressing='http://schemas.xmlsoap.org/ws/2004/08/addressing'
        discovery='http://schemas.xmlsoap.org/ws/2005/04/discovery'
        while not self.stopped.is_set():
            try: data,peer=self.socket.recvfrom(8193)
            except socket.timeout: continue
            except OSError: return
            if len(data)>8192 or b'<!' in data: continue
            try:
                request=ET.fromstring(data)
                message=request.findtext('.//{%s}MessageID'%addressing)
                action=request.findtext('.//{%s}Action'%addressing)
                if action!=discovery+'/Probe' or not message or len(message)>128: continue
                config=self.camera.config_now()
                epr=config.get('epr','urn:uuid:64ba8893-e346-45ee-8465-c15fd7084d6d')
                wire=('<s:Envelope xmlns:s="%s" xmlns:a="%s" xmlns:d="%s" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><s:Header><a:MessageID>urn:uuid:%s</a:MessageID><a:RelatesTo>%s</a:RelatesTo><a:Action>%s/ProbeMatches</a:Action></s:Header><s:Body><d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>%s</a:Address></a:EndpointReference><d:Types>dn:NetworkVideoTransmitter</d:Types><d:Scopes>onvif://www.onvif.org/type/video_encoder</d:Scopes><d:XAddrs>%s/device</d:XAddrs><d:MetadataVersion>1</d:MetadataVersion></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>'%(SOAP,addressing,discovery,uuid.uuid4(),escape(message),discovery,escape(epr),escape(config['base_url'].rstrip('/')))).encode()
                # A wrong correlation plus duplicate valid responses exercise
                # consumer filtering and deduplication through real UDP sockets.
                self.socket.sendto(wire.replace(escape(message).encode(),b'urn:uuid:old-session'),peer)
                self.socket.sendto(wire,peer)
                self.socket.sendto(wire,peer)
            except (ET.ParseError,ValueError,KeyError,OSError): continue
    def close(self):
        self.stopped.set()
        self.socket.close()
        self.thread.join(timeout=2)


class CameraHTTPServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer otherwise performs a blocking reverse-DNS lookup while
        # binding a numeric LAN address. A fixture must not depend on site DNS.
        import socketserver
        socketserver.TCPServer.server_bind(self)
        self.server_name=str(self.server_address[0])
        self.server_port=int(self.server_address[1])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    camera = Camera(args.config)
    config = camera.config_now()
    server = CameraHTTPServer((config['listen_host'], int(config['listen_port'])), Handler)
    server.daemon_threads = True
    server.camera = camera
    discovery=DiscoveryResponder(camera,config['discovery_interface_address']) if config.get('discovery_interface_address') else None
    print('ONVIF test device ready', flush=True)
    try: server.serve_forever()
    finally:
        server.server_close()
        if discovery: discovery.close()


if __name__ == '__main__':
    main()
