#!/usr/bin/env python3
"""Bounded, signaling-only interop with an unmodified external Python camera.
No media bindings, production services, or production configuration are used.
"""
import argparse, hashlib, importlib.util, json, os, secrets, subprocess, sys, time
from pathlib import Path
from urllib.request import Request, urlopen

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--source',type=Path,required=True)
    p.add_argument('--gateway',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args()
    if hashlib.sha256(a.source.read_bytes()).hexdigest() != 'ab3469718b873037c05a5db302883cfdf8b4fd143c4b654ea2725c935e37cd8a':
        p.error('external camera differs from the audited pinned source')
    a.output.mkdir(parents=True,exist_ok=False)
    token=secrets.token_hex(32)
    password=secrets.token_hex(16)
    bootstrap=a.output/'bootstrap.json'
    bootstrap.write_text(json.dumps({'listen':'127.0.0.1:19196','token':token}))
    bootstrap.chmod(0o600)
    def api(path,body=None):
        request=Request('http://127.0.0.1:19196'+path,data=None if body is None else json.dumps(body).encode(),headers={'X-Service-Token':token,'Content-Type':'application/json'})
        with urlopen(request,timeout=3) as response:return json.load(response)
    results=[]
    log=(a.output/'gateway.log').open('wb');os.chmod(log.name,0o600)
    gateway=subprocess.Popen([str(a.gateway),'--bootstrap',str(bootstrap)],stdout=log,stderr=log)
    try:
        for i in range(40):
            try:api('/v1/status');break
            except OSError:time.sleep(.1)
        platform='34020000002000000001';device='34020000001320000001';channel='34020000001320000002'
        for revision,transport in enumerate(['udp','tcp'],1):
            api('/v1/config',{'revision':revision,'enabled':True,'sip':{'serverId':platform,'realm':'3402000000','listen':'127.0.0.1:15160','advertiseIp':'127.0.0.1','maxDevices':2,'maxCatalogItems':10,'heartbeatTimeoutSec':60,'devices':[{'id':device,'password':password,'version':'auto','enabled':True}]},'media':{'domainId':platform,'api':'http://127.0.0.1:19980','secret':secrets.token_hex(16),'listenIp':'127.0.0.1','advertiseIp':'127.0.0.1','portStart':33000,'portEnd':33004,'capacity':1},'srsApi':'http://127.0.0.1:19985','bindings':[]})
            for i in range(40):
                if api('/v1/status').get('ready'):break
                time.sleep(.1)
            # Fresh subprocess contains the upstream's socket/event threads.
            child_code="import importlib.util,sys,json; s=importlib.util.spec_from_file_location('camera',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.GB28181Pusher(**json.load(sys.stdin)).run_forever()"
            childlog=(a.output/(transport+'.log')).open('wb');os.chmod(childlog.name,0o600)
            camera=subprocess.Popen([sys.executable,'-c',child_code,str(a.source)],stdin=subprocess.PIPE,stdout=childlog,stderr=childlog)
            cfg={'server_ip':'127.0.0.1','server_port':15160,'server_id':platform,'agent_id':device,'agent_password':password,'channel_id':channel,'local_ip':'127.0.0.1','use_udp_signalling':transport=='udp','max_reconnect_attempts':1,'connection_timeout':3}
            camera.stdin.write(json.dumps(cfg).encode());camera.stdin.close()
            state={}
            try:
                deadline=time.monotonic()+18
                while time.monotonic()<deadline:
                    states=api('/v1/status').get('devices',[])
                    state=next((d for d in states if d['id']==device),{})
                    if state.get('registered') and state.get('catalogComplete') and state.get('info'):break
                    if camera.poll() is not None:break
                    time.sleep(.25)
                results.append({'transport':transport,'registered':state.get('registered',False),'catalogComplete':state.get('catalogComplete',False),'channelFound':any(c.get('deviceId',c.get('id'))==channel for c in (state.get('catalog') or [])),'deviceInfoReceived':bool(state.get('info')),'lastError':state.get('lastError'),'version':state.get('version'),'catalog':state.get('catalog',[])})
            finally:
                camera.terminate()
                try:camera.wait(timeout=5)
                except subprocess.TimeoutExpired:camera.kill();camera.wait()
                childlog.close()
        report={'scope':'third-party signaling only; no media or 2022 certification','upstream':'https://github.com/sb-im/sbgb28181','commit':'1da9bc62134d4cb1fd4374f733583fb5997c3f0a','sourceSha256':hashlib.sha256(a.source.read_bytes()).hexdigest(),'gatewaySha256':hashlib.sha256(a.gateway.read_bytes()).hexdigest(),'results':results,'passed':all(r['registered'] and r['catalogComplete'] and r['channelFound'] and r['deviceInfoReceived'] for r in results)}
        (a.output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps(report,ensure_ascii=False))
        return 0 if report['passed'] else 1
    finally:
        gateway.terminate()
        try:gateway.wait(timeout=8)
        except subprocess.TimeoutExpired:gateway.kill();gateway.wait()
        log.close();bootstrap.unlink(missing_ok=True)

if __name__=='__main__':sys.exit(main())