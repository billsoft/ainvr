#!/usr/bin/env python3
"""Bounded review release with rollback; preserves video/channel configuration."""
import base64,hashlib,json,os,pathlib,pwd,shutil,subprocess,time,urllib.request,urllib.parse
R=pathlib.Path('/home/sunrise/ainvr');C=pathlib.Path('/mnt/ainvr-ssd/ainvr-review-release')
def run(args,**kw):return subprocess.check_output(args,stderr=subprocess.PIPE,timeout=120,**kw).decode().strip()
def get(url,headers=None,body=None,timeout=10):
    req=urllib.request.Request(url,headers=headers or {},data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req,timeout=timeout) as f:return json.load(f)
def config(service):
    b=json.loads((R/f'deploy/s100p/runtime/{service}-bootstrap.json').read_text());h={'x-service-token':b['service_token']}
    base=urllib.parse.urljoin(b['control_url'],'/api/v1/config/')
    s=get(base+'service-states/'+service,h)['data']
    return get(base+f"versions/{s['appliedVersion']}/snapshot?service={service}",h)['data'][0]['config']
def main():
    assert os.geteuid()==0 and pathlib.Path('/mnt/ainvr-ssd').is_mount()
    stamp=time.strftime('%Y%m%d-%H%M%S');backup=R/'deploy/s100p'/('rollback-review-'+stamp);backup.mkdir()
    output=R/'test/results/review-production-release.json';report={'phase':'prepared','backup':str(backup)}
    def record(phase):report['phase']=phase;output.write_text(json.dumps(report,indent=2))
    before={s:run(['systemctl','show',s,'-p','MainPID','--value']) for s in ['ainvr-recorder','ainvr-ingest']}
    backend_pid=run(['systemctl','show','ainvr-backend','-p','MainPID','--value'])
    env=dict(v.decode().split('=',1) for v in pathlib.Path('/proc/'+backend_pid+'/environ').read_bytes().split(b'\0') if b'=' in v)
    ai_cfg=json.loads((R/'deploy/s100p/runtime/ai-service.json').read_text());aiheaders={'x-api-key':ai_cfg['server']['api_key']}
    def ai():return get('http://127.0.0.1:8000/api/v1/channels',aiheaders)['channels']
    channels=ai();running=[x['id'] for x in channels if x['state']=='running'];original_config={x['id']:x['config'] for x in channels}
    units={s:pathlib.Path('/etc/systemd/system/'+s+'.service') for s in ['ainvr-alarm','ainvr-llm']}
    for s,p in units.items():shutil.copy2(p,backup/(s+'.service'))
    drop=pathlib.Path('/etc/systemd/system/ainvr-ai.service.d/70-review-cache.conf');assert not drop.exists()
    source=R/'deploy/s100p/alarm-service'/('release-review-'+stamp);source.mkdir();shutil.copytree(R/'alarm-service/src',source/'src');os.symlink(R/'alarm-service/node_modules',source/'node_modules')
    llm=R/'deploy/s100p/llm-service'/('release-review-'+stamp);llm.mkdir();shutil.copy2('/mnt/ainvr-ssd/llm-build/ainvr/ainvr_llm_service',llm/'ainvr_llm_service')
    cache=pathlib.Path('/mnt/ainvr-ssd/ainvr-review-frames');cache.mkdir(exist_ok=True);owner=pwd.getpwnam('sunrise');os.chown(cache,owner.pw_uid,owner.pw_gid);cache.chmod(0o700)
    swapped=[];installed=None
    try:
        for name in ['backend','frontend']:
            target=R/'srs-web-console'/name/'dist';shutil.copytree(target,backup/name)
            prepared=target.with_name('dist.review-next-'+stamp);shutil.copytree(C/name,prepared)
            if name=='frontend':
                for asset in (target/'assets').glob('*'):
                    if asset.is_file() and not (prepared/'assets'/asset.name).exists():shutil.copy2(asset,prepared/'assets'/asset.name)
            old=target.with_name('dist.review-before-'+stamp);target.rename(old);prepared.rename(target);swapped.append((target,old))
        record('installing')
        # Existing credentials remain encrypted in the parameter store.
        run(['/usr/local/bin/node',str(R/'deploy-package/provision-alarm-review.mjs')],env=env)
        for service,directory,command in [('ainvr-alarm',source,'/opt/ainvr/node-v24.20.0-linux-arm64/bin/node '+str(source/'src/main.mjs')+' --config-center '+str(R/'deploy/s100p/runtime/alarm-service-bootstrap.json')),('ainvr-llm',llm,str(llm/'ainvr_llm_service')+' --bootstrap '+str(R/'deploy/s100p/runtime/llm-service-bootstrap.json'))]:
            text=(backup/(service+'.service')).read_text();text='\n'.join('ExecStart='+command if l.startswith('ExecStart=') else 'WorkingDirectory='+str(directory) if l.startswith('WorkingDirectory=') else l for l in text.splitlines())+'\n'
            if service=='ainvr-alarm':text=text.replace('ReadWritePaths=','ReadWritePaths='+str(cache)+' ')
            units[service].write_text(text)
        drop.parent.mkdir(exist_ok=True);drop.write_text('[Service]\nEnvironment=AINVR_REVIEW_FRAME_ROOT='+str(cache)+'\n')
        run(['systemctl','daemon-reload']);run(['systemctl','restart','ainvr-backend']);run(['systemctl','restart','ainvr-llm'])
        deadline=time.monotonic()+150
        while time.monotonic()<deadline:
            try:
                if get('http://127.0.0.1:8300/health')['model']=='ready':break
            except Exception:pass
            time.sleep(1)
        else:raise RuntimeError('Model failed readiness')
        deadline=time.monotonic()+60;key=None
        while time.monotonic()<deadline:
            cfg=config('llm-service');key=next((k['key'] for k in cfg['api_keys'] if k['name']=='alarm-review'),None)
            if key:break
            time.sleep(1)
        if not key:raise RuntimeError('Dedicated caller configuration not acknowledged')
        item=json.loads(pathlib.Path('/mnt/ainvr-ssd/llm-eval/v1/items-dev-v2.jsonl').read_text().splitlines()[0]);image=pathlib.Path('/mnt/ainvr-ssd/llm-eval/v1')/item['image']
        body={'request_id':'review-release-strict','image':{'jpeg_base64':base64.b64encode(image.read_bytes()).decode()},'alarm':{'kind':item['kind'],'description':item['desc']}}
        result=get('http://127.0.0.1:8300/v1/ainvr/tasks/alarm-review-zh-v1',{'Authorization':'Bearer '+key,'Content-Type':'application/json'},body,90)
        expected=json.loads((R/'test/results/review-model-baseline.json').read_text())['result'];assert result['logits']==expected['logits'],'Strict image regression'
        report['strict_logits_unchanged']=True
        installed=json.loads(run(['python3',str(R/'deploy-package/install-ai-s100p.py'),'--binary',str(R/'out/build/ai-s100p/ainvr_s100p_control_service'),'--start']).splitlines()[-1])
        run(['systemctl','restart','ainvr-alarm'])
        deadline=time.monotonic()+100
        while time.monotonic()<deadline:
            now=ai();assert {x['id']:x['config'] for x in now}==original_config,'Channel config changed'
            selected=[x for x in now if x['id'] in running]
            if len(selected)==len(running) and all(x['state']=='running' and x['stats']['inference_count']>=20 and x['stats']['consecutive_errors']==0 and x['stats']['publish']['sei_injected']>=.9*x['stats']['inference_count'] for x in selected):break
            time.sleep(1)
        else:raise RuntimeError('AI live acceptance failed')
        ac=config('alarm-service');status=get('http://127.0.0.1:'+str(ac['port'])+'/v1/status',{'Authorization':'Bearer '+ac['api_token']})
        report['alarm_status']=status;report['running_channels']=running
        assert before=={s:run(['systemctl','show',s,'-p','MainPID','--value']) for s in before},'Recorder/ingest changed'
        report['recorder_ingest_unchanged']=True;report['ai_installation']=installed
        report['llm_sha256']=hashlib.sha256((llm/'ainvr_llm_service').read_bytes()).hexdigest();record('deployed-short-checks-passed')
    except Exception as error:
        record('rolling-back')
        for s,p in units.items():shutil.copy2(backup/(s+'.service'),p)
        drop.unlink(missing_ok=True)
        for target,old in reversed(swapped):target.rename(target.with_name('dist.review-failed-'+stamp));old.rename(target)
        run(['systemctl','daemon-reload'])
        if installed:run(['python3',str(R/'deploy-package/install-ai-s100p.py'),'--binary',str(pathlib.Path(installed['rollback'])/'ainvr_ai_service'),'--start'])
        for s in ['ainvr-backend','ainvr-llm','ainvr-alarm']:run(['systemctl','restart',s])
        report['error_type']=type(error).__name__;report['error']=str(error)[:250];record('rolled-back');raise
if __name__=='__main__':main()
