#!/usr/bin/env python3
"""Production binary integration. Sign exchanged requests OFF BOARD; never copy a private key here."""
import argparse
import concurrent.futures
import json
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'shared/python'))
from license_client import LicenseSignalClient

def run(binary,work,exchange):
    exchange.mkdir(parents=True,exist_ok=False)
    code=subprocess.check_output([binary,'--machine-code'],text=True).strip().replace('-','')
    with tempfile.TemporaryDirectory(prefix='v3-',dir=work) as directory:
        d=Path(directory);admin=secrets.token_hex(32)
        keys={k:secrets.token_hex(32) for k in ['recorder','ai-service','console-backend','enforcer']}
        probe=socket.socket();probe.bind(('127.0.0.1',0));port=probe.getsockname()[1];probe.close()
        cfg=dict(host='127.0.0.1',port=port,uds_path=str(d/'s'),machine_code=code,
                 device_key=secrets.token_hex(32),admin_api_key=admin,signal_keys=keys,
                 installation_path=str(d/'identity'),state=dict(primary=str(d/'state'),replica2=str(d/'copy1'),replica3=str(d/'copy2')))
        config=d/'config';config.write_text(json.dumps(cfg));config.chmod(0o600)
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def call(path,data=None,auth=admin):
            req=urllib.request.Request(f'http://127.0.0.1:{port}'+path,
                data=None if data is None else json.dumps(data).encode(),headers={'X-API-Key':auth,'Content-Type':'application/json'})
            return json.load(opener.open(req,timeout=3))
        def start():
            p=subprocess.Popen([binary,'--config',str(config)],stdout=log,stderr=log)
            for _ in range(100):
                if p.poll() is not None:raise RuntimeError('test daemon exited')
                try:call('/healthz');return p
                except OSError:time.sleep(.1)
            p.terminate();p.wait(10);raise RuntimeError('test daemon not ready')
        def reject(token,auth=admin):
            try:call('/api/v1/license/activate',{'key':token},auth)
            except urllib.error.HTTPError as e:assert e.code in [401,409];return
            raise AssertionError('invalid activation accepted')
        def exchange_token(stage):
            req=call('/api/v1/license/machine-code')
            (exchange/f'request-{stage}.txt').write_text(req['activation_request']+'\n')
            print('WAITING_FOR_OFFBOARD_SIGNATURE',stage,flush=True)
            token=exchange/f'token-{stage}.txt';deadline=time.monotonic()+600
            while time.monotonic()<deadline:
                if token.exists():return token.read_text().strip()
                time.sleep(.25)
            raise TimeoutError('offboard signature not supplied')
        with (exchange/'daemon.log').open('w') as log:
            process=start()
            try:
                token=exchange_token('activate');reject(token,'invalid-admin')
                assert call('/api/v1/license/preview',{'key':token})['operation']=='replace'
                assert call('/api/v1/license/status')['state']=='unlicensed'
                assert call('/api/v1/license/activate',{'key':token})['state']=='valid'
                assert call('/api/v1/license/activate',{'key':token})['activation_result']=='already_active'
                reject(token[:-1]+('A' if token[-1]!='A' else 'B'))
                def check_client(cid):
                    c=LicenseSignalClient(cid,bytes.fromhex(keys[cid]),device_id=code,uds_path=cfg['uds_path'],verify_peer=False)
                    c.challenge_once();assert c.is_licensed()
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(check_client,keys))
                process.terminate();process.wait(15)
                for name in ['state','copy1','copy2']:(d/name).unlink(missing_ok=True)
                process=start();assert call('/api/v1/license/status')['state']=='recovery_required';reject(token)
                recovery=exchange_token('recover')
                assert call('/api/v1/license/activate',{'key':recovery})['state']=='valid'
                process.terminate();process.wait(15)
                for name in ['state','copy1','copy2']:(d/name).unlink(missing_ok=True)
                process=start();reject(recovery)
                print('PASS: production Ed25519 verifier, four v2 consumers, preview, idempotency, tamper rejection, missing-state recovery, spent recovery challenge',flush=True)
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:process.wait(15)
                    except subprocess.TimeoutExpired:process.kill();process.wait()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--work',type=Path,required=True);p.add_argument('--exchange',type=Path,required=True)
    a=p.parse_args();run(a.binary,a.work,a.exchange)
