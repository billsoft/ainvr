"""AINVR host memory guard, scoped to two explicitly owned compile containers.

Pause new compile containers before low-memory conditions; stopping a paused
task frees its retained memory if pressure remains critical. Never touches miners
or the existing COCO container. A pause cannot guarantee release of memory.
"""
import argparse,json,subprocess,time,re
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--max-seconds',type=int,default=21600)
a=p.parse_args();assert not a.output.exists()
names=['ainvr-gpu-yoloe-20261012','ainvr-gpu-face-o2-20261012']
sensor='ainvr-oe370-gpu-probe-v2-20261012'
def run(args):return subprocess.run(args,capture_output=True,text=True,timeout=15,check=True).stdout
def inspect(n):return json.loads(run(['docker','inspect',n]))[0]
def byte_count(s):
    match=re.fullmatch(r'\s*([\d.]+)\s*([A-Za-z]+)\s*',s);assert match,s
    units={'B':1,'kB':1000,'MB':1000**2,'GB':1000**3,'KiB':1024,'MiB':1024**2,'GiB':1024**3}
    return float(match[1])*units[match[2]]
identities={n:inspect(n)['Id'] for n in names};paused={};events=[];deadline=time.time()+a.max_seconds
r={'scope':names,'container_ids':identities,'events':events,'status':'monitoring','thresholds':{'pause_vm_available_gib':6,'resume_vm_available_gib':10,'critical_vm_available_gib':3,'pause_gpu_free_mib':2048},'existing_coco_and_miners_touched':False}
def save():a.output.write_text(json.dumps(r,indent=2))
save()
while time.time()<deadline:
    try:
        memory=run(['docker','exec',sensor,'python3','-c',"from pathlib import Path;d={x.split(':')[0]:int(x.split()[1]) for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith(('MemTotal:','MemAvailable:'))};print(d['MemAvailable'])"])
        available=float(memory.strip())/1024**2
        gpu=run(['nvidia-smi','--query-gpu=memory.total,memory.used','--format=csv,noheader,nounits']).strip().splitlines()[0].split(',')
        free=float(gpu[0])-float(gpu[1]);states={n:inspect(n) for n in names}
        assert all(states[n]['Id']==identities[n] for n in names),'Container identity changed'
        stats=[json.loads(line) for line in run(['docker','stats','--no-stream','--format','{{json .}}',*names]).splitlines() if line]
        spare={x['Name']:(byte_count(x['MemUsage'].split('/')[1])-byte_count(x['MemUsage'].split('/')[0]))/1024**3 for x in stats}
        r.update(last_checked_unix=time.time(),vm_available_gib=available,gpu_free_mib=free)
        r['container_headroom_gib']=spare
        critical=available<3
        for n in list(paused):
            if not states[n]['State']['Running']:paused.pop(n);continue
            if critical or spare.get(n,100)<1 or time.time()-paused[n]>600:
                run(['docker','stop','--time','5',n]);events.append({'time':time.time(),'container':n,'action':'stop_paused_task_to_release_memory','vm_available_gib':available});paused.pop(n)
            elif available>10 and free>3072 and spare.get(n,0)>3:
                run(['docker','unpause',n]);events.append({'time':time.time(),'container':n,'action':'resume','vm_available_gib':available});paused.pop(n)
        if available<6 or free<2048 or any(x<3 for x in spare.values()):
            for n in names:
                if states[n]['State']['Running'] and not states[n]['State']['Paused'] and n not in paused:
                    if available>=6 and free>=2048 and spare.get(n,100)>=3:continue
                    run(['docker','pause',n]);paused[n]=time.time();events.append({'time':time.time(),'container':n,'action':'pause_for_memory_headroom','vm_available_gib':available,'gpu_free_mib':free});break
        r['paused_by_guard']=dict(paused);save()
    except Exception as e:
        r['last_sensor_error']=repr(e);save()
    time.sleep(5)
for n in paused:
    try:
        state=inspect(n)
        if state['Id']==identities[n] and state['State']['Paused']:
            run(['docker','stop','--time','5',n]);events.append({'time':time.time(),'container':n,'action':'stop_paused_at_guard_deadline'})
    except Exception as e:r['cleanup_error']=repr(e)
r['status']='guard_deadline_reached';save()
