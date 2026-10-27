#!/usr/bin/env python3
"""Bounded external-gateway topology using an isolated IP namespace.

Actual compiled backend sync -> HTTPS -> actual gateway/ZLM; loopback media and
SRS API use authenticated, host-key-verified SSH forwards to isolated SRS.
Only the test benchmark IP link is created; production NICs, SSH, SRS and
configuration are untouched. This is not physical external-appliance acceptance.
"""
import argparse
import configparser
from contextlib import ExitStack
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT/'test/onvif'))
from fault_link import FaultLink, HOST, CAMERA, NAMESPACE
from av_content import compare
from soak import ContinuousDevice

NODE = '/opt/ainvr/node-v24.20.0-linux-arm64/bin/node'
BIN = ROOT/'out/gb28181/ffmpeg-runtime/bin'

SYNC_PEER = '''import {readFile,writeFile} from 'node:fs/promises';
const c=JSON.parse(await readFile(process.argv[2],'utf8'));
const {GB28181Sync}=await import(c.module);
const bindings=[{binding_id:'84f8e050-a5f4-4d04-846b-a6850f0cdd4c',device_id:c.device,
 channel_id:c.channel,input_id:'a6e1a7d7-9548-44ae-9173-b1860a9cec23',stream_name:'gb_external',
 enabled:true,transport:'tcp-passive',document:{name:'External fixture'}}];
const store={readSettings:async()=>({revision:1,tokenSet:true,settings:c.settings}),
 devices:async()=>[{id:c.device,version:'auto',enabled:true,mediaIPs:[]}],
 pg:{getSecret:async key=>key==='gb28181/gateway-token'?c.token:key==='gb28181/media-secret'?c.secret:c.password,
 pool:{query:async()=>({rows:bindings}),connect:async()=>({query:async()=>({rows:[]}),release(){}})}}};
const channels={listChannels:async()=>[{id:bindings[0].input_id,upstreamProtocol:'rtmp',app:'live',
 streamName:'gb_external',inputEnabled:true}],updateChannel:async()=>{throw Error('Unexpected channel edit')},
 createChannel:async()=>{throw Error('Unexpected channel create')}};
const sync=new GB28181Sync(store,channels);
while(true){await sync.synchronize();const s=sync.status();
 await writeFile(c.status,JSON.stringify({state:s.state,revision:s.revision,ready:s.ready,
 inputs:s.inputs??[],devices:(s.devices??[]).map(d=>({id:d.id,registered:d.registered,version:d.version}))}));
 await new Promise(resolve=>setTimeout(resolve,500));}
'''


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def private(path, value):
    path.write_text(value)
    path.chmod(0o600)


def require_certificate_rejection(opener, url):
    """An HTTP rejection or a broken connection is not proof of TLS validation."""
    try:
        with opener.open(url, timeout=3):
            pass
    except urllib.error.URLError as error:
        if not isinstance(error.reason, ssl.SSLCertVerificationError):
            raise AssertionError('Expected certificate verification failure, got '+type(error.reason).__name__) from error
        return
    raise AssertionError('Unknown HTTPS certificate accepted')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gateway', type=Path, required=True)
    parser.add_argument('--console', type=Path, required=True)
    parser.add_argument('--source-dir', type=Path, required=True)
    parser.add_argument('--references', type=Path, required=True)
    parser.add_argument('--remuxer', type=Path, default=ROOT/'out/gb28181/ps_fixture-pmt2')
    parser.add_argument('--network-profile', choices=['none', 'bounded-lan'], default='none',
                        help='Optional isolated 0.1%% IP loss, 150ms one-way relay delay and +/-25ms jitter; not physical network certification')
    parser.add_argument('--result', type=Path, required=True)
    args = parser.parse_args()
    args.result = args.result.resolve()
    args.result.mkdir(parents=True, exist_ok=False)
    args.result.chmod(0o700)
    lock = (ROOT/'out/gb28181/media-test.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # Use the exact continuous source/clock already validated by the long
    # tests. A one-cycle MP4 cannot identify an 8s clip spanning a loop boundary.
    for name in ['h264-aac.ts', 'hevc-aac.ts', 'video.ts', 'hevc.ts', 'tone.alaw', 'tone.mulaw']:
        assert sha(args.source_dir/name) == sha(args.references.parent/name), 'Reference source differs: '+name
    os.environ['AINVR_GB_TEST_REMUXER'] = str(args.remuxer.resolve(strict=True))
    os.environ.pop('AINVR_GB_TEST_VIDEO_CONCAT', None)
    os.environ.pop('AINVR_GB_TEST_SOURCE_FFMPEG', None)
    deployed_sync = ROOT/'srs-web-console/backend/dist/services/gb28181Sync.js'
    assert sha(deployed_sync) == sha(args.console/'backend/services/gb28181Sync.js'), 'Backend mapper differs from the frozen candidate'
    assert sha(Path('/opt/ainvr/gb28181/ffmpeg/bin/ffmpeg')) == sha(BIN/'ffmpeg'), 'Fixed bridge runtime differs'
    report = {'passed': False, 'productionChanged': False, 'physicalExternalGatewayVerified': False,
              'gatewaySHA256': sha(args.gateway), 'backendMapperSHA256': sha(deployed_sync),
              'remuxerSHA256': sha(args.remuxer),
              'scope': 'Real routed namespace, production compiled configuration mapper, verified HTTPS control and restricted SSH media/API transport; fake parameter-store adapter, not production database',
              'networkProfile': args.network_profile, 'cases': []}
    logs, processes = [], []
    created_srs = False
    camera = None
    name = 'ainvr-gb-external-probe'

    def spawn(command, label, env=None):
        log = (args.result/(label+'.log')).open('wb')
        logs.append(log)
        p = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             env=env, start_new_session=True)
        processes.append(p)
        return p

    def stop(p):
        if p.poll() is None:
            os.killpg(p.pid, signal.SIGTERM)
            try:
                p.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait(timeout=3)

    def command(argv):
        return subprocess.run(argv, check=True, capture_output=True, timeout=15).stdout

    def in_namespace(argv):
        return ['ip', 'netns', 'exec', NAMESPACE, *map(str, argv)]

    def interrupted(*_):
        raise InterruptedError('bounded external test interrupted')

    def cleanup_namespace():
        nonlocal camera
        try:
            if camera:
                camera.close()
        finally:
            camera = None
            for proc in reversed(processes):
                stop(proc)

    signal.signal(signal.SIGTERM, interrupted)
    try:
        for port in [11935, 11985]:
            with socket.socket() as s:
                s.bind(('127.0.0.1', port))
        command(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(args.result/'host-key')])
        command(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(args.result/'client-key')])
        private(args.result/'authorized-keys', (args.result/'client-key.pub').read_text())
        private(args.result/'known-hosts', '['+HOST+']:2222 '+(args.result/'host-key.pub').read_text())
        command(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
                 '-nodes', '-days', '1', '-subj', '/CN=AINVR isolated external test',
                 '-addext', 'subjectAltName=IP:'+CAMERA, '-keyout', str(args.result/'https-key.pem'),
                 '-out', str(args.result/'https-cert.pem')])
        (args.result/'https-key.pem').chmod(0o600)
        (args.result/'srs.conf').write_text('listen 127.0.0.1:11935;\ndaemon off;\nsrs_log_tank console;\nmax_connections 32;\nhttp_api { enabled on; listen 127.0.0.1:11985; }\nvhost __defaultVhost__ { }\n')
        command(['docker', 'run', '-d', '--name', name, '--network', 'host', '--memory', '256m', '--cpus', '1',
                 '--label', 'ainvr.task=gb28181-test', '-v', str(args.result/'srs.conf')+':/usr/local/srs/conf/probe.conf:ro',
                 'ossrs/srs:7.0.162', './objs/srs', '-c', 'conf/probe.conf'])
        created_srs = True
        with FaultLink() as link, ExitStack() as cleanup:
            cleanup.callback(cleanup_namespace)
            sshd_config = f'''ListenAddress {HOST}
Port 2222
HostKey {args.result/'host-key'}
PidFile {args.result/'sshd.pid'}
AuthorizedKeysFile none
AuthorizedKeysCommand /usr/bin/cat {args.result/'authorized-keys'}
AuthorizedKeysCommandUser root
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowTcpForwarding local
PermitOpen 127.0.0.1:11935 127.0.0.1:11985
AllowAgentForwarding no
X11Forwarding no
PermitTTY no
MaxSessions 0
MaxStartups 3:100:3
LogLevel VERBOSE
'''
            private(args.result/'sshd.conf', sshd_config)
            sshd = spawn(['/usr/sbin/sshd', '-D', '-f', str(args.result/'sshd.conf'), '-E', str(args.result/'sshd-errors.log')], 'sshd')
            tunnel_command = in_namespace(['/usr/bin/ssh', '-F', '/dev/null', '-N', '-T', '-p', '2222',
                                         '-i', args.result/'client-key', '-o', 'IdentitiesOnly=yes',
                                         '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                                         '-o', 'UserKnownHostsFile='+str(args.result/'known-hosts'),
                                         '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=3',
                                         '-o', 'ServerAliveInterval=3', '-o', 'ServerAliveCountMax=2',
                                         '-L', '127.0.0.1:1935:127.0.0.1:11935',
                                         '-L', '127.0.0.1:1985:127.0.0.1:11985', 'root@'+HOST])
            time.sleep(.3)
            assert sshd.poll() is None, 'isolated SSH server failed'
            tunnel = spawn(tunnel_command, 'ssh-forward-initial')
            # Test results live below a developer-owned repository, so the
            # isolated daemon uses a fixed key command rather than weakening
            # StrictModes on an AuthorizedKeysFile beneath that ancestry.
            for _ in range(30):
                assert tunnel.poll() is None, 'isolated SSH authentication failed'
                check = subprocess.run(in_namespace(['python3', '-c',
                    "import urllib.request; urllib.request.urlopen('http://127.0.0.1:1985/api/v1/versions',timeout=2).read()"]),
                    capture_output=True, timeout=4)
                if check.returncode == 0:
                    break
                time.sleep(.1)
            else:
                raise AssertionError('Restricted media/API tunnel did not become ready')
            # Verify restrictions over the actual authenticated transport, not
            # just by reading sshd_config. A failed TCP connection is insufficient.
            ssh_common = in_namespace(['/usr/bin/ssh', '-F', '/dev/null', '-T', '-p', '2222',
                                      '-i', args.result/'client-key', '-o', 'IdentitiesOnly=yes',
                                      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                                      '-o', 'UserKnownHostsFile='+str(args.result/'known-hosts'),
                                      '-o', 'ConnectTimeout=3'])
            denied = subprocess.run([*ssh_common, 'root@'+HOST, 'true'], capture_output=True, timeout=8)
            # MaxSessions=0 is reported as "no more sessions" by sshd; some
            # clients receive SSH_OPEN_CONNECT_FAILED instead of ADMIN_PROHIBITED.
            # Require the authenticated server-side reason as well as client failure.
            shell_reason = (args.result/'sshd-errors.log').read_text()
            report['sshShellNegative'] = {'returnCode': denied.returncode,
                                          'clientReason': denied.stderr.decode(errors='replace')[:400],
                                          'serverDeniedSessions': 'no more sessions' in shell_reason}
            assert denied.returncode == 255 and b'open failed' in denied.stderr and 'no more sessions' in shell_reason, 'SSH shell restriction not proved'
            report['sshShellDenied'] = True
            denied = subprocess.run([*ssh_common, '-W', '127.0.0.1:22', 'root@'+HOST], capture_output=True, timeout=8)
            report['sshDestinationNegative'] = {'returnCode': denied.returncode,
                                               'clientReason': denied.stderr.decode(errors='replace')[:400]}
            assert denied.returncode == 255 and b'administratively prohibited' in denied.stderr, 'SSH destination restriction not proved'
            report['sshUnlistedDestinationDenied'] = True
            token, secret = secrets.token_hex(32), secrets.token_hex(32)
            private(args.result/'bootstrap.json', json.dumps({'listen': '127.0.0.1:8096', 'token': token}))
            cfg = configparser.ConfigParser(interpolation=None, strict=False)
            cfg.optionxform = str
            cfg.read(ROOT/'out/gb28181/ZLMediaKit/conf/config.ini')
            for section, values in {'api': {'secret': secret}, 'general': {'listen_ip': '127.0.0.1'},
                'http': {'port': '8097', 'sslport': '0'}, 'rtsp': {'port': '8556', 'sslport': '0'},
                'rtmp': {'port': '0', 'sslport': '0'}, 'rtp_proxy': {'port': '0'}, 'srt': {'port': '0'},
                'rtc': {'port': '0', 'tcpPort': '0', 'enableTurn': '0'}, 'onvif': {'port': '0'},
                'shell': {'port': '0'}, 'hook': {'enable': '0'},
                'protocol': {'modify_stamp': '0', 'enable_audio': '1', 'add_mute_audio': '0',
                             'enable_mp4': '0', 'enable_hls': '0', 'enable_rtsp': '1'}}.items():
                if section not in cfg:
                    cfg[section] = {}
                cfg[section].update(values)
            with (args.result/'media.ini').open('w') as f:
                cfg.write(f, space_around_delimiters=False)
            (args.result/'media.ini').chmod(0o600)
            media = spawn(in_namespace([ROOT/'out/gb28181/ZLMediaKit/release/linux/Release/MediaServer',
                                       '-c', args.result/'media.ini', '-t', '45', '--affinity', '0', '-l', '4',
                                       '--log-dir', args.result/'logs', '--log-size', '2', '--log-slice', '2']), 'media')
            nginx_config = f'''daemon off;
master_process off;
error_log stderr warn;
pid {args.result/'nginx.pid'};
events {{ worker_connections 32; }}
http {{ access_log off; client_max_body_size 4m;
 server {{ listen {CAMERA}:24496 ssl;
 ssl_certificate {args.result/'https-cert.pem'};
 ssl_certificate_key {args.result/'https-key.pem'};
 ssl_protocols TLSv1.2 TLSv1.3;
 location / {{ proxy_pass http://127.0.0.1:8096; proxy_read_timeout 20s; proxy_connect_timeout 2s; }}
 }} }}
'''
            (args.result/'nginx.conf').write_text(nginx_config)
            nginx = spawn(in_namespace(['/usr/sbin/nginx', '-p', str(args.result)+'/', '-c', args.result/'nginx.conf']), 'https')
            context = ssl.create_default_context(cafile=str(args.result/'https-cert.pem'))
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))

            def api(path='/v1/status', auth=token):
                request = urllib.request.Request('https://'+CAMERA+':24496'+path, headers={'X-Service-Token': auth})
                with opener.open(request, timeout=5) as response:
                    return json.load(response)

            for version, video, audio in [('2016', 'h264', 'aac'), ('2022', 'hevc', 'alaw')]:
                case = {'version': version, 'video': video, 'audio': audio, 'passed': False}
                report['cases'].append(case)
                gateway = spawn(in_namespace([args.gateway.resolve(), '--bootstrap', args.result/'bootstrap.json']), 'gateway-'+version)
                for _ in range(60):
                    try:
                        api()
                        break
                    except OSError:
                        assert gateway.poll() is None and nginx.poll() is None and media.poll() is None, 'external component failed'
                        time.sleep(.1)
                else:
                    raise AssertionError('HTTPS gateway did not start')
                try:
                    api(auth='wrong-fixture-token')
                    raise AssertionError('Unauthenticated management request accepted')
                except urllib.error.HTTPError as error:
                    assert error.code == 401
                bad = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
                require_certificate_rejection(bad, 'https://'+CAMERA+':24496/v1/status')
                case['httpsCertificateAndTokenNegativesPassed'] = True
                peer = args.result/('sync-'+version+'.mjs')
                peer.write_text(SYNC_PEER)
                private(args.result/('sync-'+version+'.json'), json.dumps({'module': deployed_sync.as_uri(), 'status': str(args.result/('sync-'+version+'-status.json')),
                    'device': '34020000001320000001', 'channel': '34020000001320000002', 'password': 'independent-test-device',
                    'token': token, 'secret': secret, 'settings': {'enabled': True, 'gatewayUrl': 'https://'+CAMERA+':24496',
                    'serverId': '34020000002000000001', 'realm': '3402000000', 'listenIp': '0.0.0.0', 'sipPort': 5060,
                    'advertiseIp': CAMERA, 'mediaAdvertiseIp': CAMERA, 'mediaPortStart': 30000, 'mediaPortEnd': 30010,
                    'capacity': 1, 'heartbeatTimeoutSec': 60}}))
                environment = {k: v for k, v in os.environ.items() if k.upper() not in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_OPTIONS']}
                environment['NODE_EXTRA_CA_CERTS'] = str(args.result/'https-cert.pem')
                sync = spawn([NODE, str(peer), str(args.result/('sync-'+version+'.json'))], 'sync-'+version, env=environment)
                # The HTTP management listener exists before the backend has
                # applied configuration and opened UDP/TCP SIP listeners.
                # A one-shot fixture must not race that real desired-state step.
                for _ in range(100):
                    if api().get('ready'):
                        break
                    assert sync.poll() is None and gateway.poll() is None, 'configuration peer stopped'
                    time.sleep(.1)
                else:
                    raise AssertionError('Compiled backend did not apply the external gateway configuration')
                source_log = (args.result/('camera-source-'+version+'.log')).open('wb')
                logs.append(source_log)
                camera = ContinuousDevice(0, '2.0' if version == '2016' else '3.0',
                                          'tcp' if version == '2016' else 'udp', video, audio, source_log,
                                          port=5060, server_host=CAMERA, local_ip=HOST, source_dir=args.source_dir)
                camera.start()

                def advancing(deadline=60):
                    start = time.monotonic()
                    first = {}
                    while time.monotonic()-start < deadline:
                        status = api()
                        with urllib.request.urlopen('http://127.0.0.1:11985/api/v1/streams/', timeout=3) as response:
                            stream = next((s for s in json.load(response)['streams'] if s['name'] == 'gb_external'), None)
                        if stream and stream.get('publish', {}).get('active'):
                            frames = stream.get('frames', 0)
                            first.setdefault(stream['id'], frames)
                            if frames-first[stream['id']] >= 8 and any(s['state'] == 'streaming' for s in status.get('inputs', [])):
                                return round(time.monotonic()-start, 3)
                        assert not camera.error and gateway.poll() is None and sync.poll() is None and tunnel.poll() is None, 'external session stopped: '+str({'camera':camera.error,'gateway':gateway.poll(),'sync':sync.poll(),'tunnel':tunnel.poll()})
                        time.sleep(.2)
                    raise AssertionError('External media did not advance in 60 seconds')

                def record(label):
                    sys.path.insert(0, str(ROOT/'recording-service/src'))
                    from recorder.ffmpeg_recorder import build_reader_command, build_writer_command
                    target = args.result/(version+'-'+label+'.mp4')
                    codec = 'h265' if video == 'hevc' else 'h264'
                    reader_args = build_reader_command('rtmp://127.0.0.1:11935/live/gb_external', codec)
                    reader_args[-1:-1] = ['-t', '8']
                    log = (args.result/(version+'-'+label+'-recorder.log')).open('wb')
                    logs.append(log)
                    reader = subprocess.Popen(reader_args, stdout=subprocess.PIPE, stderr=log, start_new_session=True)
                    processes.append(reader)
                    writer = subprocess.Popen(build_writer_command(str(target), True, codec), stdin=reader.stdout, stdout=log, stderr=log, start_new_session=True)
                    processes.append(writer)
                    reader.stdout.close()
                    assert reader.wait(timeout=25) == 0 and writer.wait(timeout=8) == 0
                    reference = args.references/(video+('-aac' if audio == 'aac' else '')+'.mp4')
                    timing = compare(reference, target)
                    assert timing['maximum_content_offset_seconds'] <= .2 and timing['content_drift_seconds'] <= .05
                    return {'recordingSHA256': sha(target), 'referenceSHA256': sha(reference), 'contentTiming': timing}

                case['initialReadySeconds'] = advancing()
                case['initial'] = record('initial')
                if args.network_profile == 'bounded-lan':
                    before = link.snapshot()
                    link.configure(drop=.001, delay=.15, jitter=.025, seed=28181+int(version))
                    began = time.monotonic()
                    # Confirm actual packet loss, not merely configuration.
                    # Keep the bound independent of a particular fixture bitrate.
                    while link.snapshot()['dropped'] == before['dropped'] and time.monotonic()-began < 60:
                        assert api().get('ready') and tunnel.poll() is None, 'Impaired management or protected media transport stopped'
                        time.sleep(.2)
                    impaired = link.snapshot()
                    assert impaired['dropped'] > before['dropped'], 'No actual loss occurred in the bounded network phase'
                    case['impairedNetwork'] = {'policy': impaired['policy'], 'packetLossObserved': True,
                                               'recording': record('impaired')}
                    impaired = link.snapshot()
                    case['impairedNetwork']['observedSeconds'] = round(time.monotonic()-began, 3)
                    case['impairedNetwork']['packets'] = impaired['packets']-before['packets']
                    case['impairedNetwork']['injectedDrops'] = impaired['dropped']-before['dropped']
                    assert impaired['queueDrops'] == before['queueDrops'] and not impaired['error'], 'Fault relay overflowed or stopped'
                    link.configure()
                stop(tunnel)
                for _ in range(30):
                    with urllib.request.urlopen('http://127.0.0.1:11985/api/v1/streams/', timeout=3) as response:
                        active = any(s['name'] == 'gb_external' and s.get('publish', {}).get('active') for s in json.load(response)['streams'])
                    if not active:
                        break
                    time.sleep(.1)
                else:
                    raise AssertionError('SSH tunnel outage was not actually observed at SRS')
                case['srsPublishLostDuringTunnelOutage'] = True
                assert api().get('revision') == 1, 'HTTPS management failed with media tunnel down'
                case['managementAvailableDuringTunnelOutage'] = True
                tunnel = spawn(tunnel_command, 'ssh-forward-recovered-'+version)
                case['tunnelRecoverySeconds'] = advancing()
                case['recovered'] = record('recovered')
                case['passed'] = True
                stop(sync)
                stop(gateway)
                camera.close()
                camera = None
                (args.result/'progress.json').write_text(json.dumps(report, indent=2)+'\n')
            report['link'] = link.snapshot()
            report['passed'] = True
            # Reap all namespace members before releasing its network identity.
            for proc in reversed(processes):
                stop(proc)
    except Exception as error:
        report['error'] = type(error).__name__+': '+str(error)[:500]
        raise
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if camera:
            camera.close()
        for proc in reversed(processes):
            stop(proc)
        if created_srs:
            subprocess.run(['docker', 'stop', '-t', '3', name], capture_output=True, timeout=10)
            subprocess.run(['docker', 'rm', name], capture_output=True, timeout=10)
        for log in logs:
            log.close()
        (args.result/'report.json').write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
