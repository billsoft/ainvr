#!/usr/bin/env python3
"""Copyright AINVR. Verify real database access, persistence and RTMP/FLV.

Use --restart only when restarting these new database containers is intended.
This script does not benchmark AI, 8K throughput or WebRTC interoperability.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent
COMPOSE = ['docker', 'compose', '--project-directory', str(ROOT),
           '-f', str(ROOT / 'compose.yaml')]


def run(args, text=None, timeout=40):
    result = subprocess.run(args, input=text, text=True, capture_output=True,
                            check=True, timeout=timeout)
    return result.stdout.strip()


def pg(sql):
    return run(COMPOSE + ['exec', '-T', 'postgres', 'sh', '-c',
               'PGPASSWORD="$(cat /run/secrets/pg_app_password)" '
               'psql -h 127.0.0.1 -U ainvr_config -d ainvr_config '
               '-v ON_ERROR_STOP=1 -qAt'], sql)


def mongo(js):
    preamble = """
const password = require('fs').readFileSync('/run/secrets/mongo_app_password', 'utf8').trim();
db = db.getSiblingDB('ainvr_snapshots');
if (!db.auth('ainvr_ai', password).ok) throw Error('Application authentication failed');
"""
    return run(COMPOSE + ['exec', '-T', 'mongo', 'mongosh', '--quiet',
                         '--norc', '--file', '/dev/stdin'], preamble + js)


def http_json(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.load(response)


def stream_probe(protocol):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        return {'status': 'SKIP', 'reason': 'ffmpeg or ffprobe is unavailable'}
    name = 'ainvr_probe_' + uuid.uuid4().hex
    target = 'rtmp://127.0.0.1:1935/live/' + name
    output = ['-f', 'flv', target]
    if protocol == 'srt':
        target = 'srt://127.0.0.1:10080?streamid=#!::r=live/' + name + ',m=publish'
        output = ['-f', 'mpegts', target]
    cmd = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
           '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x320:rate=15',
           '-t', '15', '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
           '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '15'] + output
    process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        url = 'http://127.0.0.1:8080/live/' + name + '.flv'
        deadline = time.monotonic() + 10
        while True:
            if process.poll() is not None:
                raise RuntimeError('Synthetic publisher exited: ' + process.stderr.read().decode()[-2000:])
            try:
                with urllib.request.urlopen(url, timeout=2) as response:
                    if response.read(3) != b'FLV':
                        raise RuntimeError('Unexpected HTTP-FLV signature')
                break
            except (OSError, TimeoutError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.25)
        probe = json.loads(run(['ffprobe', '-v', 'error', '-rw_timeout', '5000000',
                               '-analyzeduration', '1000000', '-probesize', '262144',
                               '-show_entries', 'stream=codec_name,width,height',
                               '-of', 'json', url], timeout=12))
        assert any(s.get('codec_name') == 'h264' and s.get('width') == 640
                   and s.get('height') == 320 for s in probe['streams']), probe
        return {'status': 'PASS', 'input': protocol, 'output': 'http-flv',
                'probe': probe}
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        process.stderr.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--restart', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    token = uuid.uuid4().hex
    report = {'target': 'RDK S100P', 'database_restart_test': args.restart}
    pg_record = False
    mongo_record = False
    try:
        pg("CREATE TABLE IF NOT EXISTS _ainvr_infra_probe (id text PRIMARY KEY, value text NOT NULL);\n"
           f"INSERT INTO _ainvr_infra_probe VALUES ('{token}', 'persistent');\n")
        pg_record = True
        mongo(f"db.getCollection('_ainvr_infra_probe').insertOne({{_id:'{token}',value:'persistent'}});\n")
        mongo_record = True
        if args.restart:
            run(COMPOSE + ['restart', 'postgres', 'mongo'], timeout=150)
        deadline = time.monotonic() + 90
        while True:
            try:
                assert pg(f"SELECT value FROM _ainvr_infra_probe WHERE id='{token}';") == 'persistent'
                mongo(f"if(db.getCollection('_ainvr_infra_probe').findOne({{_id:'{token}'}})?.value !== 'persistent') throw Error('Persistence check failed');\n")
                break
            except (subprocess.CalledProcessError, AssertionError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(2)
        report['postgres'] = {'status': 'PASS', 'version': pg('SHOW server_version;'),
                              'application_auth_and_rw': True, 'persistent_after_restart': args.restart}
        report['mongo'] = {'status': 'PASS', 'version': mongo('print(db.version());\n'),
                           'application_auth_and_rw': True, 'persistent_after_restart': args.restart}
        # Sensitive collections must reject reads without authentication.
        rejected = run(COMPOSE + ['exec', '-T', 'mongo', 'mongosh', '--quiet', '--norc',
                       '--eval', "try { const r=db.getSiblingDB('ainvr_snapshots').runCommand({find:'_ainvr_infra_probe',limit:1}); if(r.code!==13) quit(1); } catch(e) { if(e.code!==13) throw e; } print('Unauthorized');"])
        assert rejected == 'Unauthorized', rejected
        report['mongo']['unauthenticated_read_rejected'] = True
        version = http_json('http://127.0.0.1:1985/api/v1/versions')
        assert version['code'] == 0, version
        report['srs'] = {'status': 'PASS', 'api': version}
        report['rtmp_to_flv'] = stream_probe('rtmp')
        report['srt_to_flv'] = stream_probe('srt')
        containers = run(COMPOSE + ['ps', '--format', 'json'])
        report['containers'] = (json.loads(containers) if containers.startswith('[')
                                else [json.loads(line) for line in containers.splitlines()])
        assert len(report['containers']) == 3
        assert all(c['State'] == 'running' for c in report['containers'])
        listeners = run(['ss', '-H', '-lntu']).splitlines()
        report['local_only_listeners'] = {}
        for port in (5432, 27017, 1985, 8080):
            addresses = [line.split()[4] for line in listeners
                         if line.split()[4].endswith(':' + str(port))]
            assert addresses and all(a.startswith('127.0.0.1:') for a in addresses), addresses
            report['local_only_listeners'][str(port)] = addresses
        report['docker_version'] = run(['docker', 'version', '--format', '{{.Server.Version}}'])
        report['compose_version'] = run(['docker', 'compose', 'version', '--short'])
        report['limitations'] = ['No high-resolution throughput benchmark',
                                 'No browser/WebRTC end-to-end validation',
                                 'Application services and HLS are not deployed']
    finally:
        if pg_record:
            pg(f"DELETE FROM _ainvr_infra_probe WHERE id='{token}';")
        if mongo_record:
            mongo(f"db.getCollection('_ainvr_infra_probe').deleteOne({{_id:'{token}'}});\n")
    encoded = json.dumps(report, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded + '\n')
    print(encoded)


if __name__ == '__main__':
    main()
