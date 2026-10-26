"""Bounded RTSP copy pipeline. Configuration and secrets belong to the console."""
from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import logging
import os
from pathlib import Path
import random
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import urllib.error
from urllib.parse import urlsplit, urlunsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'shared/python'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from media_policy import AUDIO_BUDGET, MediaError, audio_policy, error_code, probe
from async_launch import AsyncLauncher, ConnectionCapacity
LOG = logging.getLogger('ingest')
IDENTIFIER = re.compile(r'^[a-zA-Z0-9_-]{1,128}$')


def validate_source(value, resolve=False, allowed_cidrs=None):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 32 for c in value):
        raise ValueError('invalid video source')
    p = urlsplit(value)
    if p.scheme != 'rtsp' or not p.hostname or p.fragment:
        raise ValueError('invalid video source')
    port = p.port or 554
    if port < 1 or port > 65535:
        raise ValueError('invalid port')
    if p.hostname.lower() in ('localhost', 'metadata.google.internal'):
        raise ValueError('invalid video host')
    addresses = []
    try:
        addresses.append(ipaddress.ip_address(p.hostname))
    except ValueError:
        if resolve:
            result = subprocess.run(['/usr/bin/getent', 'ahosts', p.hostname], capture_output=True,
                                    text=True, timeout=3, check=True)
            addresses = list({ipaddress.ip_address(line.split()[0]) for line in result.stdout.splitlines()})
            if not addresses:
                raise ValueError('video host not found')
    for addr in addresses:
        effective = addr.ipv4_mapped if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped else addr
        if allowed_cidrs is not None and not any(effective in ipaddress.ip_network(cidr,strict=False) for cidr in allowed_cidrs):
            raise MediaError('address_not_allowed')
        if effective.is_loopback or effective.is_link_local or effective.is_unspecified or effective.is_multicast:
            raise ValueError('invalid video host')
    if resolve and addresses:
        # Pin the checked address, so a second DNS query cannot redirect FFmpeg.
        addr = addresses[0]
        host = f'[{addr}]' if addr.version == 6 else str(addr)
        credentials = p.netloc.rsplit('@', 1)[0] + '@' if '@' in p.netloc else ''
        return urlunsplit((p.scheme, credentials + host + ':' + str(port), p.path, p.query, ''))
    return value


def command(c):
    source = validate_source(c['source'])
    if not IDENTIFIER.fullmatch(c['app']) or not IDENTIFIER.fullmatch(c['stream']):
        raise ValueError('invalid stream identity')
    transport = c.get('transport', 'tcp')
    if transport not in ('tcp', 'udp'):
        raise ValueError('invalid transport')
    timeout = max(3, min(30, int(c.get('timeout', 10))))
    return [os.environ.get('INGEST_FFMPEG', '/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg'),
            '-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats',
            '-progress', 'pipe:1', '-rtsp_transport', transport,
            '-rw_timeout', str(timeout * 1000000), '-timeout', str(timeout * 1000000),
            '-i', source, '-map', '0:v:0', '-an', '-c:v', 'copy',
            '-f', 'flv', 'rtmp://127.0.0.1:1935/' + c['app'] + '/' + c['stream']]


def private_input(c, fd):
    """Use the concat demuxer's per-input options; works with the shipped build."""
    args = command(c)
    start = args.index('-rtsp_transport')
    end = args.index('-map')
    timeout = max(3, min(30, int(c.get('timeout', 10)))) * 1000000
    escaped = c['source'].replace("'", "'\\''")
    manifest = ("ffconcat version 1.0\nfile '" + escaped + "'\n"
                + 'option rtsp_transport ' + c.get('transport', 'tcp') + '\n'
                + f'option timeout {timeout}\noption rw_timeout {timeout}\n')
    # concat's default H.264 Annex-B conversion would mismatch AVCC extradata
    # in the FLV output. Preserve packet framing for the destination muxer.
    args[start:end] = ['-f', 'concat', '-safe', '0', '-auto_convert', '0', '-protocol_whitelist',
                       'file,rtsp,tcp,udp,rtp', '-i', f'/proc/self/fd/{fd}']
    return args, manifest.encode()


def resolve_source(config, deadline):
    """Fetch a generation-bound runtime URI; never expose it in argv or logs."""
    root=urlsplit(os.environ.get('INGEST_CONFIG_URL','http://127.0.0.1:3001/internal/ingest/config'))
    url=urlunsplit((root.scheme,root.netloc,'/internal/ingest/source','',''))
    body=json.dumps({'id':config['id'],'generation':config['generation']}).encode()
    request=urllib.request.Request(url,data=body,headers={'X-Service-Token':os.environ.get('INGEST_SERVICE_TOKEN',''),'Content-Type':'application/json'})
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request,timeout=max(1,min(48,deadline-time.monotonic()))) as response:
            data=response.read(8193)
        if len(data)>8192:raise MediaError('invalid_source_response')
        lease=json.loads(data)
        if lease.get('generation')!=config['generation'] or not isinstance(lease.get('source'),str) or type(lease.get('refreshAfterProbe')) is not bool or not isinstance(lease.get('allowedCIDRs'),list) or not 0<len(lease['allowedCIDRs'])<=32:raise MediaError('invalid_source_response')
        for cidr in lease['allowedCIDRs']:ipaddress.ip_network(cidr,strict=False)
        return lease
    except urllib.error.HTTPError as error:
        try:code=json.loads(error.read(8192)).get('error','control_service_unavailable')
        except Exception:code='control_service_unavailable'
        raise MediaError(code if isinstance(code,str) and re.fullmatch('[a-z_]{1,80}',code) else 'control_service_unavailable') from None
    except (OSError,ValueError,TypeError):raise MediaError('control_service_unavailable') from None


class CopyProcess:
    def __init__(self, c, resolver=resolve_source):
        original=c
        deadline=time.monotonic()+60
        lease=resolver(c,deadline) if c.get('onvif') else None
        c = {**c, 'source': validate_source(lease['source'] if lease else c['source'], resolve=True,allowed_cidrs=lease['allowedCIDRs'] if lease else None)}
        self.started = time.monotonic()
        self.last_video = self.started
        self.frames = 0
        # Error text may contain camera passwords. Read it continuously, never publish it.
        self.errors = 0
        self.error_code = None
        self.audio_warning = 'audio_processing_failed' if c.get('audioFallback') else None
        self.audio_codec = None
        self._audio_acquired = False
        self._closed = False
        # Credentials live only in an inherited anonymous memory file.
        fd = os.memfd_create('camera-source', os.MFD_CLOEXEC)
        try:
            args, manifest = private_input(c, fd)
            os.write(fd, manifest)
            os.lseek(fd, 0, os.SEEK_SET)
            if c.get('audioMode', 'off') == 'auto':
                _video, self.audio_codec = probe(args, fd,timeout=max(1,min(15,deadline-time.monotonic())))
                if lease and lease['refreshAfterProbe']:
                    # One-use/expiring URIs must be renewed after ffprobe,
                    # which opens and closes its own RTSP session.
                    fresh=resolver(original,deadline)
                    c['source']=validate_source(fresh['source'],resolve=True,allowed_cidrs=fresh['allowedCIDRs'])
                    _,manifest=private_input(c,fd)
                    os.ftruncate(fd,0);os.lseek(fd,0,os.SEEK_SET);os.write(fd,manifest);os.lseek(fd,0,os.SEEK_SET)
                audio_args, self.audio_warning, needs_slot = audio_policy(self.audio_codec)
                if needs_slot:
                    self._audio_acquired = AUDIO_BUDGET.acquire()
                    if not self._audio_acquired:
                        audio_args, self.audio_warning = ['-an'], 'audio_capacity_exceeded'
                index = args.index('-an')
                args[index:index+1] = audio_args
                os.lseek(fd, 0, os.SEEK_SET)
            self.proc = subprocess.Popen(args, stdin=subprocess.DEVNULL,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         pass_fds=(fd,), start_new_session=True, text=True, bufsize=1)
            # Audio probing and ONVIF URI renewal have their own deadline.
            # Start media-idle accounting when the publisher actually launches,
            # otherwise a slow successful probe immediately kills a fresh stream.
            self.started = time.monotonic()
            self.last_video = self.started
        except BaseException:
            if self._audio_acquired:
                AUDIO_BUDGET.release()
                self._audio_acquired = False
            raise
        finally:
            os.close(fd)
        self.readers = [threading.Thread(target=self._progress, daemon=True),
                        threading.Thread(target=self._errors, daemon=True)]
        for t in self.readers:
            t.start()

    def _progress(self):
        for line in self.proc.stdout:
            if line.startswith('frame='):
                try:
                    n = int(line.split('=', 1)[1])
                    if n > self.frames:
                        self.frames = n
                        self.last_video = time.monotonic()
                except ValueError:
                    pass

    def _errors(self):
        tail = ''
        while True:
            chunk = self.proc.stderr.read(1024)
            if not chunk:
                break
            self.errors += 1
            tail = (tail + chunk)[-4096:]
            code = error_code(tail)
            if code != 'source_unavailable':
                self.error_code = code

    def poll(self):
        return self.proc.poll()

    def stop(self):
        if self._closed:
            return
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
                self.proc.wait(timeout=2)
        for t in self.readers:
            t.join(timeout=.2)
        self.proc.stdout.close()
        self.proc.stderr.close()
        if self._audio_acquired:
            AUDIO_BUDGET.release()
            self._audio_acquired = False
        self._closed = True


class Supervisor:
    def __init__(self, launch=CopyProcess, clock=time.monotonic):
        self.launch = launch
        self.clock = clock
        self.jobs = {}

    def reconcile(self, configs, allowed, max_channels=8):
        now = self.clock()
        desired = {c['id']: c for c in configs if c.get('enabled', True)} if allowed else {}
        for cid in list(self.jobs):
            job = self.jobs[cid]
            if cid not in desired or desired[cid]['generation'] != job['config']['generation']:
                if job['process']:
                    job['process'].stop()
                del self.jobs[cid]
        for cid, c in desired.items():
            job = self.jobs.setdefault(cid, {'config': c, 'process': None, 'failures': 0,
                                           'next_retry': 0, 'state': 'waiting', 'error': None})
            p = job['process']
            if p:
                timeout = max(10, min(60, int(c.get('timeout', 10)) * 2))
                if p.poll() is not None or now - p.last_video > timeout:
                    code = p.poll()
                    p.stop()
                    reason = getattr(p, 'error_code', None)
                    job['process'] = None
                    if reason == 'audio_processing_failed' and c.get('audioMode') == 'auto' and not job.get('audio_fallback'):
                        job['audio_fallback'] = True
                        job['audio_warning'] = reason
                        job['next_retry'] = now
                        job['state'] = 'reconnecting'
                        job['error'] = None
                        continue
                    job['failures'] += 1
                    job['next_retry'] = now + min(60, 2 ** min(job['failures'], 6)) + random.random()
                    blocked = reason in ('authentication_failed', 'unsupported_video_codec','profile_not_found','address_not_allowed','media_host_changed','service_host_changed','redirect_not_allowed')
                    job['state'] = 'blocked' if blocked else 'reconnecting'
                    job['error'] = reason or 'source_unavailable'
                    if blocked:
                        job['next_retry'] = float('inf')
                    LOG.warning('input_retry channel=%s failures=%s exit=%s', cid, job['failures'], code)
                else:
                    job['state'] = 'streaming' if p.frames else 'connecting'
                    job['audio_warning'] = getattr(p, 'audio_warning', None)
                    job['audio_codec'] = getattr(p, 'audio_codec', None)
                    if p.frames and now - p.started > 60:
                        job['failures'] = 0
                    continue
            if now < job['next_retry']:
                continue
            if sum(j['process'] is not None for j in self.jobs.values()) >= max_channels:
                job['state'] = 'waiting'
                job['error'] = '已达到接入并发上限'
                continue
            try:
                job['process'] = self.launch({**c, 'audioMode': 'off', 'audioFallback': True} if job.get('audio_fallback') else c)
                job['state'] = 'connecting'
                job['error'] = None
                LOG.info('input_start channel=%s generation=%s', cid, c['generation'])
            except ConnectionCapacity:
                # No camera connection was attempted. A busy bounded connector
                # must not create fake failures and exponential retry penalties.
                job['state'] = 'waiting'
                job['error'] = None
                job['next_retry'] = now + .2
            except Exception as e:
                job['failures'] += 1
                job['next_retry'] = now + min(60, 2 ** min(job['failures'], 6))
                job['state'] = 'error'
                job['error'] = '无法建立视频接入，请检查地址、凭据和接入组件'
                LOG.warning('input_start_failed channel=%s category=%s', cid, type(e).__name__)

    def status(self):
        return {cid: {'generation': j['config']['generation'], 'state': j['state'],
                      'error': j['error'], 'retries': j['failures'],
                      'audioWarning': j.get('audio_warning'), 'audioCodec': j.get('audio_codec'),
                      'frames': j['process'].frames if j['process'] else 0}
                for cid, j in self.jobs.items()}


def main():
    from internal_network import NetworkPolicy
    from license_client import client_from_env
    argparse.ArgumentParser(description=__doc__).parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    token = os.environ.get('INGEST_SERVICE_TOKEN', '')
    if len(token) < 32:
        raise RuntimeError('ingest service credential missing')
    license_client = client_from_env('recorder')
    license_client.start()
    stopped = threading.Event()
    launcher = AsyncLauncher(CopyProcess)
    sup = Supervisor(launch=launcher.launch)
    config = []
    settings = {}
    state = {'channels': {}, 'config_connected': False}
    policy = NetworkPolicy()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def controller():
        nonlocal config, settings
        while not stopped.is_set():
            try:
                req = urllib.request.Request(os.environ.get('INGEST_CONFIG_URL', 'http://127.0.0.1:3001/internal/ingest/config'),
                                             headers={'X-Service-Token': token})
                with opener.open(req, timeout=4) as response:
                    raw = response.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise ValueError('config size')
                data = json.loads(raw)
                config, settings = data['channels'], data.get('settings', {})
                AUDIO_BUDGET.configure(settings.get('maxAudioTranscodes', 2))
                state['config_connected'] = True
            except Exception:
                state['config_connected'] = False
            try:
                sup.reconcile(config, license_client.is_licensed(), settings.get('maxPullChannels', 4))
            except Exception as e:
                LOG.error('supervisor_error category=%s', type(e).__name__)
            state['channels'] = sup.status()
            stopped.wait(2)
        sup.reconcile([], False)
    thread = threading.Thread(target=controller, name='input-supervisor')
    thread.start()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def do_GET(self):
            if not policy.allows(self.client_address[0]) or not hmac.compare_digest(self.headers.get('X-Service-Token', ''), token):
                self.send_error(403)
                return
            if self.path != '/status':
                self.send_error(404)
                return
            body = json.dumps({**state, 'license_allowed': license_client.is_licensed(),
                               'ready': Path(os.environ.get('INGEST_FFMPEG', '/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg')).is_file()}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    server = ThreadingHTTPServer((os.environ.get('INGEST_BIND_HOST', '127.0.0.1'), int(os.environ.get('INGEST_PORT', '8120'))), Handler)
    server.timeout = .5
    def stop(*_args):
        stopped.set()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not stopped.is_set():
            server.handle_request()
    finally:
        stopped.set()
        thread.join(timeout=40)
        launcher.close()
        server.server_close()
        license_client.stop()


if __name__ == '__main__':
    main()
