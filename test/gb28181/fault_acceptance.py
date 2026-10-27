#!/usr/bin/env python3
"""Independent GB camera + real ZLM/SRS fault injection, isolated from production.

Uses real RTP sequence gaps/partial PS loss, not mocked receiver results. Existing
24-hour acceptance uses different ports and is never stopped by this runner.
"""
import argparse
import configparser
import hashlib
import json
import os
from pathlib import Path
import random
import secrets
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

from device_simulator import Device
from virtual_camera import load_records, shift_ps

ROOT = Path(__file__).resolve().parents[2]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
SRS = 'ainvr-gb-fault-srs'


class FaultCamera(Device):
    def __init__(self, records, version, signaling, mode, wrong_peer=False):
        super().__init__(27060, records, version, signaling, mode)
        self.drop = 0.0
        self.cut = False
        self.wrong_peer = wrong_peer
        self.sent = 0
        self.dropped = 0
        self.transport_errors = 0
        self.rtcp_reports = 0
        self.garbage_pending = False
        self.malformed_sent = 0
        self.fragment_tcp = False
        self.reorder_udp = False
        self.clock_offset = 0
        self.fragment_writes = 0
        self.coalesced_pairs = 0
        self.reordered_pairs = 0
        self.duplicates = 0

    def send_media(self):
        sock = None
        rtcp = None
        rng = random.Random(20261026)
        try:
            port, ssrc = self.media
            stamps = sorted(set(t for t, _ in self.records))
            span = stamps[-1] - stamps[0] + max(b-a for a, b in zip(stamps, stamps[1:]) if 0 < b-a < 90000)
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM if self.mode == 'udp' else socket.SOCK_STREAM)
            sock.settimeout(3)
            source = '127.0.0.2' if self.wrong_peer else self.local_ip
            sock.bind((source, 0))
            if self.mode == 'udp':
                rtcp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                rtcp.bind((source, sock.getsockname()[1]+1))
                rtcp.setblocking(False)
            elif self.mode == 'tcp-active':
                sock.close()
                sock, _ = self.media_listener.accept()
                sock.settimeout(3)
            else:
                sock.connect((self.media_host, port))
            if self.mode != 'udp' and self.fragment_tcp:
                sock.setsockopt(socket.IPPROTO_TCP,socket.TCP_NODELAY,1)
            cycle = seq = 0
            pending = None
            begin = time.monotonic()
            with sock:
                while not self.stop.is_set() and not self.media_stop.is_set():
                    for pts, raw in self.records:
                        elapsed = pts-stamps[0]+cycle*span
                        if self.media_stop.wait(max(0, elapsed/90000-(time.monotonic()-begin))) or self.stop.is_set():
                            return
                        shift = cycle*span+self.clock_offset
                        payload = shift_ps(raw, shift)
                        for offset in range(0, len(payload), 1200):
                            chunk = payload[offset:offset+1200]
                            packet = struct.pack('!BBHII', 0x80, 96 | (128 if offset+1200 >= len(payload) else 0), seq & 65535, (pts+shift) & 0xffffffff, ssrc)+chunk
                            seq += 1
                            if self.cut or rng.random() < self.drop:
                                self.dropped += 1
                                continue
                            if self.mode == 'udp':
                                if self.reorder_udp and pending is None and seq%5 == 1:
                                    pending = packet
                                    continue
                                sock.sendto(packet, (self.media_host, port))
                                if self.reorder_udp and pending is not None:
                                    sock.sendto(pending, (self.media_host, port))
                                    self.reordered_pairs += 1
                                    self.sent += 1
                                    pending = None
                                if self.reorder_udp and seq%7 == 0:
                                    sock.sendto(packet, (self.media_host, port))
                                    self.duplicates += 1
                                    self.sent += 1
                            else:
                                wire = struct.pack('!H', len(packet))+packet
                                if self.fragment_tcp and pending is None and seq%4 == 1:
                                    pending = wire
                                    continue
                                if self.fragment_tcp and pending is not None:
                                    sock.sendall(pending+wire)
                                    self.coalesced_pairs += 1
                                    self.sent += 1
                                    pending = None
                                elif self.fragment_tcp and seq%4 == 3:
                                    for piece in [wire[:1],wire[1:3],wire[3:]]:
                                        sock.sendall(piece)
                                        time.sleep(.002)
                                    self.fragment_writes += 3
                                else:
                                    sock.sendall(wire)
                            self.sent += 1
                            if self.garbage_pending and self.mode == 'udp':
                                self.garbage_pending = False
                                header = struct.pack('!BBHII',0x80,96,seq & 65535,(pts+cycle*span)&0xffffffff,ssrc)
                                for invalid in [b'\x80',header[:8],header,bytes([0x90])+header[1:]+b'\x00\x00\xff\xff',bytes([0xc0])+header[1:]+b'bad',bytes([0x80,127])+header[2:]+b'bad']:
                                    sock.sendto(invalid,(self.media_host,port))
                                    self.malformed_sent += 1
                            if rtcp:
                                try:
                                    response, _ = rtcp.recvfrom(2048)
                                    if len(response) >= 8 and response[0] >> 6 == 2 and response[1] == 201:
                                        self.rtcp_reports += 1
                                except BlockingIOError:
                                    pass
                    cycle += 1
        except OSError:
            if not self.stop.is_set() and not self.media_stop.is_set():
                self.transport_errors += 1
        finally:
            if rtcp:
                rtcp.close()
            if sock:
                sock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gateway', type=Path, required=True)
    parser.add_argument('--result', type=Path, required=True)
    parser.add_argument('--version', choices=['2.0', '3.0'], required=True)
    parser.add_argument('--signaling', choices=['udp', 'tcp'], required=True)
    parser.add_argument('--media', choices=['udp', 'tcp-passive', 'tcp-active'], required=True)
    parser.add_argument('--fixture', choices=['h264-aac', 'hevc-alaw', 'h264-aac-pmt2', 'hevc-alaw-pmt2'], required=True)
    parser.add_argument('--wrong-peer', action='store_true')
    parser.add_argument('--malformed-only', action='store_true', help='Inject malformed UDP media and verify recovery within 60 seconds')
    parser.add_argument('--fragmentation-only', action='store_true', help='Deliberately split TCP length prefixes and coalesce adjacent RTP packets')
    parser.add_argument('--reorder-only', action='store_true', help='Send out-of-order and duplicate UDP RTP packets')
    parser.add_argument('--timestamp-only', action='store_true', help='Move PS/RTP timestamps backwards two seconds, then restore the source clock')
    parser.add_argument('--ports-exhausted-only', action='store_true', help='Hold all configured TCP media ports, then release and verify recovery')
    parser.add_argument('--occupied-port-only',action='store_true',help='Hold an unrelated TCP listener at the first RTP port')
    parser.add_argument('--crash-only', action='store_true', help='Kill only the gateway, keep the old camera/media running, then replay configuration')
    args = parser.parse_args()
    assert sum([args.wrong_peer,args.malformed_only,args.fragmentation_only,args.reorder_only,args.timestamp_only,args.ports_exhausted_only,args.occupied_port_only,args.crash_only]) <= 1, 'Choose one focused fault mode'
    assert not args.fragmentation_only or args.media != 'udp'
    assert not args.reorder_only or args.media == 'udp'
    assert not args.ports_exhausted_only or args.media == 'tcp-passive'
    args.result = args.result.resolve()
    args.result.mkdir(parents=True, exist_ok=False)
    args.result.chmod(0o700)
    report = {'passed': False, 'productionChanged': False, 'version': args.version, 'signaling': args.signaling, 'media': args.media, 'fixture': args.fixture, 'gatewaySHA256': hashlib.sha256(args.gateway.read_bytes()).hexdigest(), 'phases': []}
    processes, handles = [], []
    orphan_bridges = []
    camera = None
    created = False
    occupied_socket = None
    occupied_ports = []
    token, secret = secrets.token_hex(32), secrets.token_hex(32)
    records = load_records(ROOT/'out/gb28181'/f'{args.fixture}.psrecords')
    zlm_binary = ROOT/'out/gb28181/ZLMediaKit/release/linux/Release/MediaServer'

    def spawn(command, label):
        handle = (args.result/(label+'.log')).open('wb')
        handles.append(handle)
        proc = subprocess.Popen(command, stdout=handle, stderr=handle, stdin=subprocess.DEVNULL, start_new_session=True)
        processes.append(proc)
        return proc

    def stop(proc):
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=3)

    def api(path, body=None):
        req = urllib.request.Request('http://127.0.0.1:29096'+path, data=None if body is None else json.dumps(body).encode(), headers={'X-Service-Token': token, 'Content-Type': 'application/json'})
        with OPENER.open(req, timeout=8) as response:
            return json.load(response)

    def srs_stream():
        with OPENER.open('http://127.0.0.1:27985/api/v1/streams/', timeout=3) as response:
            return next((s for s in json.load(response)['streams'] if s['app'] == 'live' and s['name'] == 'gb_fault'), None)

    def save():
        (args.result/'progress.json').write_text(json.dumps(report, indent=2)+'\n')

    def progress(timeout=60):
        start = time.monotonic()
        baseline = {}
        timeline = []
        last_state = None
        while time.monotonic()-start < timeout:
            try:
                states = api('/v1/status').get('inputs', [])
                stream = srs_stream()
            except OSError:
                time.sleep(.2)
                continue
            summary = [(s['state'], s.get('reason'), s.get('generation')) for s in states]
            if summary != last_state:
                timeline.append({'seconds': round(time.monotonic()-start, 3), 'inputs': summary})
                last_state = summary
            if stream:
                identity = stream['id']
                frames = stream.get('frames', 0)
                baseline.setdefault(identity, frames)
                if stream.get('publish', {}).get('active') and frames-baseline[identity] >= 8 and any(s['state'] == 'streaming' for s in states):
                    return round(time.monotonic()-start, 3)
            if camera.error:
                raise AssertionError('Independent camera signaling stopped')
            time.sleep(.2)
        report['failedRecovery'] = {'deadlineSeconds': timeout, 'timeline': timeline[-50:],
            'cameraSent': camera.sent, 'cameraDropped': camera.dropped,
            'cameraTransportErrors': camera.transport_errors,
            'malformedPacketsSent': camera.malformed_sent,
            'lastSRS': {k: stream.get(k) for k in ('id', 'frames', 'publish')} if stream else None}
        raise AssertionError('Media did not advance within recovery deadline')

    def new_camera():
        device = FaultCamera(records, args.version, args.signaling, args.media, args.wrong_peer)
        device.fragment_tcp = args.fragmentation_only
        device.reorder_udp = args.reorder_only
        device.start()
        return device

    def record_recovered():
        target = args.result/'recovered.mp4'
        subprocess.run([str(ROOT/'out/gb28181/ffmpeg-runtime/bin/ffmpeg'), '-hide_banner', '-loglevel', 'error', '-rw_timeout', '5000000', '-i', 'rtmp://127.0.0.1:27935/live/gb_fault', '-t', '4', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', str(target)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        result = json.loads(subprocess.check_output([str(ROOT/'out/gb28181/ffmpeg-runtime/bin/ffprobe'), '-v', 'error', '-show_entries', 'stream=codec_name:packet=stream_index,dts_time', '-of', 'json', str(target)], timeout=8))
        assert {s['codec_name'] for s in result['streams']} == ({'h264', 'aac'} if args.fixture.startswith('h264-') else {'hevc', 'aac'})
        stamps = {}
        for packet in result['packets']:
            if packet.get('dts_time') not in (None,'N/A'):
                stamps.setdefault(packet['stream_index'],[]).append(float(packet['dts_time']))
        assert len(stamps)==2 and all(len(v)>=2 and all(b>=a for a,b in zip(v,v[1:])) for v in stamps.values()), 'Recovered recording DTS is not monotonic'
        return {'streams':result['streams'],'monotonicDTS':True}

    try:
        for port in [27580, 27554, 27935, 27985, 29096, 27060, 28000, 28001]:
            with socket.socket() as probe:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:probe.bind(('127.0.0.1', port))
                except OSError as error:raise RuntimeError(f'Isolated test TCP port {port} is occupied; no existing service was changed') from error
        if subprocess.run(['docker', 'inspect', SRS], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            raise RuntimeError('Owned fault-test container is already in use')
        conf = configparser.ConfigParser(interpolation=None, strict=False)
        conf.optionxform = str
        conf.read(ROOT/'out/gb28181/ZLMediaKit/conf/config.ini')
        changes = {'api': {'secret': secret}, 'general': {'listen_ip': '127.0.0.1'}, 'http': {'port': '27580', 'sslport': '0'}, 'rtsp': {'port': '27554', 'sslport': '0'}, 'rtmp': {'port': '0', 'sslport': '0'}, 'rtp_proxy': {'port': '0'}, 'srt': {'port': '0'}, 'rtc': {'port': '0', 'tcpPort': '0', 'enableTurn': '0'}, 'onvif': {'port': '0'}, 'shell': {'port': '0'}, 'hook': {'enable': '0'}, 'protocol': {'modify_stamp': '0', 'enable_audio': '1', 'add_mute_audio': '0', 'enable_mp4': '0', 'enable_hls': '0', 'enable_rtsp': '1'}}
        for section, values in changes.items():
            if section not in conf:
                conf[section] = {}
            conf[section].update(values)
        media_ini = args.result/'media.ini'
        with media_ini.open('w') as output:
            conf.write(output, space_around_delimiters=False)
        media_ini.chmod(0o600)
        bootstrap = args.result/'bootstrap.json'
        bootstrap.write_text(json.dumps({'listen': '127.0.0.1:29096', 'token': token}))
        bootstrap.chmod(0o600)
        srs_conf = args.result/'srs.conf'
        srs_conf.write_text('listen 127.0.0.1:27935;\ndaemon off;\nsrs_log_tank console;\nsrs_log_level warn;\nmax_connections 32;\nhttp_api { enabled on; listen 127.0.0.1:27985; }\nvhost __defaultVhost__ {}\n')
        subprocess.run(['docker', 'run', '-d', '--name', SRS, '--network', 'host', '--memory', '256m', '--cpus', '1', '--log-opt', 'max-size=2m', '--log-opt', 'max-file=1', '-v', str(srs_conf)+':/usr/local/srs/conf/fault.conf:ro', 'ossrs/srs:7.0.162', './objs/srs', '-c', 'conf/fault.conf'], check=True, stdout=subprocess.DEVNULL, timeout=20)
        created = True

        def start_media():
            return spawn([str(zlm_binary), '-c', str(media_ini), '-t', '2', '--affinity', '0', '-l', '4', '--log-dir', str(args.result/'logs'), '--log-size', '2', '--log-slice', '2'], 'media-'+str(len(processes)))

        def start_gateway():
            proc = spawn([str(args.gateway.resolve()), '--bootstrap', str(bootstrap)], 'gateway-'+str(len(processes)))
            deadline = time.monotonic()+8
            while time.monotonic() < deadline:
                try:
                    api('/v1/status')
                    return proc
                except OSError:
                    time.sleep(.1)
            raise RuntimeError('Gateway startup timeout')

        if args.occupied_port_only:
            assert args.media == 'tcp-passive'
            occupied_socket = socket.socket()
            occupied_socket.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            occupied_socket.bind(('127.0.0.1',28000))
            occupied_socket.listen(1)
        if args.ports_exhausted_only:
            for port in range(28000,28010,2):
                listener=socket.socket()
                listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
                listener.bind(('127.0.0.1',port));listener.listen(1)
                occupied_ports.append(listener)
        media = start_media()
        gateway = start_gateway()
        platform = '34020000002000000001'
        config = {'revision': 1, 'enabled': True, 'sip': {'serverId': platform, 'realm': '3402000000', 'listen': '127.0.0.1:27060', 'advertiseIp': '127.0.0.1', 'maxDevices': 2, 'maxCatalogItems': 100, 'heartbeatTimeoutSec': 60, 'devices': [{'id': '34020000001320000001', 'password': 'independent-test-device', 'version': 'auto', 'enabled': True}]}, 'media': {'domainId': platform, 'api': 'http://127.0.0.1:27580', 'secret': secret, 'listenIp': '127.0.0.1', 'advertiseIp': '127.0.0.1', 'portStart': 28000, 'portEnd': 28010, 'capacity': 1}, 'bridge': {'ffmpeg': str(ROOT/'out/gb28181/ffmpeg-runtime/bin/ffmpeg'), 'httpBase': 'http://127.0.0.1:27580', 'rtspBase': 'rtsp://127.0.0.1:27554', 'rtmpBase': 'rtmp://127.0.0.1:27935'}, 'srsApi': 'http://127.0.0.1:27985', 'bindings': [{'id': 'fixture', 'deviceId': '34020000001320000001', 'channelId': '34020000001320000002', 'app': 'live', 'stream': 'gb_fault', 'mode': args.media, 'enabled': True}]}
        api('/v1/config', config)
        deadline = time.monotonic()+5
        while not api('/v1/status').get('ready'):
            assert time.monotonic() < deadline
            time.sleep(.1)
        camera = new_camera()
        assert camera.registered.wait(8), 'Registration failed'
        if args.ports_exhausted_only:
            observed=set();deadline=time.monotonic()+12
            while time.monotonic()<deadline:
                observed.update(s.get('reason') for s in api('/v1/status').get('inputs',[]) if s.get('reason'))
                assert not srs_stream(),'Input published while every media port was occupied'
                time.sleep(.2)
            assert 'media_receiver_unavailable' in observed,'Port exhaustion did not report unavailable'
            for listener in occupied_ports:listener.close()
            occupied_ports.clear()
            report['phases'].append({'fault':'all-media-ports-exhausted-then-released','recoverySeconds':progress()})
            report['recoveredRecording']=record_recovered()
            report['passed']=True
            return
        if args.wrong_peer:
            observed = set()
            deadline = time.monotonic()+25
            while time.monotonic() < deadline:
                states = api('/v1/status').get('inputs', [])
                observed.update(s.get('reason') for s in states if s.get('reason'))
                assert not any(s['state'] == 'streaming' for s in states), 'Wrong RTP peer was published'
                assert not srs_stream(), 'Wrong RTP peer reached SRS'
                if 'media_peer_mismatch' in observed:
                    break
                time.sleep(.2)
            assert 'media_peer_mismatch' in observed, 'Wrong peer was not diagnosed'
            report['wrongPeerRejected'] = True
        else:
            report['initialProgressSeconds'] = progress()
            if args.occupied_port_only:
                assert occupied_socket.fileno() >= 0
                report['firstOccupiedPortSkipped'] = True
                report['passed'] = True
                return
            if args.fragmentation_only or args.reorder_only or args.timestamp_only:
                if args.timestamp_only:
                    camera.clock_offset = -180000
                    time.sleep(6)
                    camera.clock_offset = 0
                recovery = progress()
                if args.fragmentation_only:
                    assert camera.fragment_writes>=3 and camera.coalesced_pairs>=1, 'TCP boundary fault was not exercised'
                    report['phases'].append({'fault':'TCP-split-prefix-and-coalesced-RTP','progressSeconds':recovery,'fragmentWrites':camera.fragment_writes,'coalescedPairs':camera.coalesced_pairs})
                elif args.reorder_only:
                    assert camera.reordered_pairs>0 and camera.duplicates>0, 'UDP ordering fault was not exercised'
                    report['phases'].append({'fault':'UDP-reordered-and-duplicate-RTP','progressSeconds':recovery,'reorderedPairs':camera.reordered_pairs,'duplicates':camera.duplicates})
                else:
                    report['phases'].append({'fault':'PS-and-RTP-clock-backwards-2s-then-restore','recoverySeconds':recovery})
                assert media.poll() is None and gateway.poll() is None, 'Malformed transport terminated a component'
                report['recoveredRecording'] = record_recovered()
                report['passed'] = True
                return
            if args.crash_only:
                assert args.signaling == 'udp', 'Live camera continues across the UDP signaling gateway crash'
                prior = srs_stream()['id']
                lease = api('/v1/status')['inputs'][0]['generation']
                for entry in Path('/proc').iterdir():
                    if not entry.name.isdigit(): continue
                    try:
                        stat = (entry/'stat').read_text().rsplit(')',1)[1].split()
                        command = (entry/'cmdline').read_bytes()
                        if int(stat[1]) == gateway.pid and lease.encode() in command and b'ffmpeg' in command:
                            orphan_bridges.append((int(entry.name),command))
                    except (OSError,ValueError,IndexError): pass
                assert orphan_bridges, 'Crash did not include a live bridge child'
                gateway.kill(); gateway.wait(timeout=5)
                gateway = start_gateway()
                api('/v1/config', config)
                deadline = time.monotonic()+5
                while not api('/v1/status').get('ready'):
                    assert time.monotonic()<deadline
                    time.sleep(.1)
                camera.request('REGISTER')
                recovery = progress()
                assert api('/v1/status')['inputs'][0]['generation'] != lease, 'Old receiver identity inherited'
                assert srs_stream()['id'] != prior, 'Old orphan publisher mistaken for recovery'
                for pid,_ in orphan_bridges:
                    state = Path('/proc')/str(pid)/'stat'
                    assert not state.exists() or state.read_text().rsplit(')',1)[1].split()[0]=='Z', 'Old bridge leaked after replacement'
                report['phases'].append({'fault':'ungraceful-gateway-crash-camera-kept-sending','recoverySeconds':recovery,'oldBridgeChildren':len(orphan_bridges)})
                report['passed'] = True
                return
            if args.media == 'udp':
                camera.garbage_pending = True
                time.sleep(2)
                report['phases'].append({'fault':'malformed-RTP-and-PS','progressSeconds':progress(),'packetsInjected':camera.malformed_sent})
                assert camera.malformed_sent == 6 and media.poll() is None, 'Malformed packets crashed the media receiver'
                if args.malformed_only:
                    report['passed'] = True
                    return

                for loss in [.01, .05, .10]:
                    camera.drop = loss
                    time.sleep(10)
                    report['phases'].append({'fault': 'RTP-packet-loss', 'rate': loss, 'progressSeconds': progress(30), 'dropped': camera.dropped})
                    save()
                camera.drop = 0
                report['rtcpReceiverReports'] = camera.rtcp_reports
                assert camera.rtcp_reports > 0, 'No real RTCP receiver report returned'
            old = api('/v1/status')['inputs'][0]['generation']
            camera.cut = True
            time.sleep(22)
            camera.cut = False
            recovery = progress()
            assert api('/v1/status')['inputs'][0]['generation'] != old, 'Dead media session was not replaced'
            report['phases'].append({'fault': 'media-cut-22s', 'recoverySeconds': recovery})
            save()
            stop(media)
            time.sleep(3)
            media = start_media()
            report['phases'].append({'fault': 'ZLM-restart', 'recoverySeconds': progress()})
            save()
            subprocess.run(['docker', 'restart', SRS], check=True, stdout=subprocess.DEVNULL, timeout=20)
            report['phases'].append({'fault': 'isolated-SRS-restart', 'recoverySeconds': progress()})
            save()
            camera.close()
            camera = new_camera()
            report['phases'].append({'fault': 'camera-restart-new-signaling-port', 'recoverySeconds': progress()})
            save()
            camera.close()
            stop(gateway)
            gateway = start_gateway()
            api('/v1/config', config)
            time.sleep(.3)
            camera = new_camera()
            report['phases'].append({'fault': 'gateway-restart-config-replay', 'recoverySeconds': progress()})
            save()
            report['recoveredRecording'] = record_recovered()
        report['passed'] = True
    except Exception as error:
        report['error'] = type(error).__name__ + ': ' + str(error)[:500]
        raise
    finally:
        if camera:
            camera.close()
        for proc in reversed(processes):
            stop(proc)
        for pid,command in orphan_bridges:
            try:
                current = Path('/proc')/str(pid)/'cmdline'
                if current.read_bytes() == command: os.kill(pid,signal.SIGTERM)
            except (FileNotFoundError,ProcessLookupError): pass
        for handle in handles:
            handle.close()
        if occupied_socket:
            occupied_socket.close()
        for listener in occupied_ports:listener.close()
        if created:
            subprocess.run(['docker', 'rm', '-f', SRS], stdout=subprocess.DEVNULL, check=True, timeout=15)
        (args.result/'report.json').write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
