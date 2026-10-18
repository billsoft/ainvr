"""Protect one verified compile group by resources, never a wall-clock deadline."""
from pathlib import Path
import argparse,hashlib,json,os,signal,time

p=argparse.ArgumentParser()
p.add_argument('--pid',type=int,required=True)
p.add_argument('--start-ticks',required=True)
p.add_argument('--source',required=True)
p.add_argument('--source-sha256',required=True)
p.add_argument('--minimum-vm-available-kb',type=int,default=10*1024**2)
p.add_argument('--maximum-group-rss-kb',type=int,default=8*1024**2)
p.add_argument('--root',type=Path,required=True)
p.add_argument('--report',type=Path,required=True)
a=p.parse_args()
assert a.pid>1 and Path(a.source).parent==Path('/work')
assert a.root.parent==Path('/opt') and a.root.name.startswith('locate-')
assert a.report.parent==Path('/work') and not a.report.exists()
assert len(a.source_sha256)==64 and all(x in '0123456789abcdef' for x in a.source_sha256)
assert a.minimum_vm_available_kb>=4*1024**2 and 0<a.maximum_group_rss_kb<=20*1024**2
r=dict(status='watching_resources',started=time.time(),pid=a.pid,start_ticks=a.start_ticks,
       source=a.source,source_sha256=a.source_sha256,hard_time_limit_seconds=None,minimum_vm_available_kb=a.minimum_vm_available_kb,
       maximum_group_rss_kb=a.maximum_group_rss_kb,minimum_host_and_vm_free_bytes=20*1024**3)

def summary(pid):
    d=Path('/proc')/str(pid)
    st=(d/'stat').read_text().split(') ',1)[1].split()
    return dict(pid=pid,state=st[0],parent=int(st[1]),group=int(st[2]),start_ticks=st[19],
                user_ticks=int(st[11]),system_ticks=int(st[12]),
                wait_channel=(d/'wchan').read_text().strip())

def identity():
    try:
        s=summary(a.pid)
        return (s['state']!='Z' and s['start_ticks']==a.start_ticks and s['group']==a.pid and
                a.source.encode() in (Path('/proc')/str(a.pid)/'cmdline').read_bytes().split(b'\0') and
                hashlib.sha256(Path(a.source).read_bytes()).hexdigest()==a.source_sha256)
    except (OSError,ProcessLookupError):return False

def persist():
    t=a.report.with_suffix('.json.tmp');t.write_text(json.dumps(r,indent=2));t.replace(a.report)

persist()
while True:
    if not identity():r['status']='terminal_or_identity_changed';break
    available=next(int(x.split()[1]) for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
    rss=0
    for d in Path('/proc').iterdir():
        if not d.name.isdigit():continue
        try:
            if os.getpgid(int(d.name))!=a.pid:continue
            rss+=next((int(x.split()[1]) for x in (d/'status').read_text().splitlines() if x.startswith('VmRSS:')),0)
        except (OSError,ProcessLookupError):continue
    free={x:os.statvfs(x).f_bavail*os.statvfs(x).f_frsize for x in ['/opt','/work']}
    r.update(checked=time.time(),vm_available_kb=available,group_rss_kb=rss,
             disk_free_bytes=free,leader=summary(a.pid))
    try:
        status_path=a.root/'status.json'
        if status_path.exists() and status_path.stat().st_size<4*1024**2:
            d=json.loads(status_path.read_text());c=d.get('current')
            r['coordinator']=dict(status=d.get('status'),recorded_components=len(d.get('components',[])),
                                  current={k:c.get(k) for k in ['layer','profile','pid','start_ticks','directory']} if c else None)
            if c:
                child=summary(c['pid'])
                r['current_child']=child if child['start_ticks']==c['start_ticks'] and child['group']==a.pid else {'identity_changed':True}
                stage=Path(c['directory'])
                assert stage.is_relative_to(a.root)
                if (stage/'status.json').exists():
                    s=json.loads((stage/'status.json').read_text())
                    r['stage']={k:s.get(k) for k in ['status','layer','compiled_bc_sha256','hbo_sha256','hbm_sha256','finished']}
    except (OSError,ValueError,KeyError,ProcessLookupError) as e:
        r['progress_observation_error']=type(e).__name__
    if available<r['minimum_vm_available_kb'] or rss>r['maximum_group_rss_kb'] or min(free.values())<r['minimum_host_and_vm_free_bytes']:
        assert identity();r['status']='owned_group_resource_limit';persist();os.killpg(a.pid,signal.SIGTERM)
        deadline=time.monotonic()+10
        while time.monotonic()<deadline and identity():time.sleep(.5)
        if identity():os.killpg(a.pid,signal.SIGKILL);r['escalated_to_kill']=True
        break
    persist();time.sleep(2)
r['finished']=time.time();persist()
