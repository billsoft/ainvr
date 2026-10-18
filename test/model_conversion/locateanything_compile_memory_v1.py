"""Host compiler headroom;separate Linux MemAvailable and Docker cgroup accounting.

Inactive file cache is reclaimable in the working-set estimate. This is a
compilation resource guard,not a model-runtime memory or quality certificate.
"""
from pathlib import Path
import time

def headroom(available,usage,limit,inactive_file):
 assert all(type(x) is int and x>=0 for x in [available,usage,inactive_file])
 assert limit is None or (type(limit) is int and limit>0)
 reclaim=min(inactive_file,usage)
 return dict(ordinary_available_bytes=available,cgroup_usage_bytes=usage,cgroup_limit_bytes=limit,
  cgroup_inactive_file_bytes=reclaim,cgroup_working_set_bytes=usage-reclaim,
  cgroup_headroom_after_inactive_file_bytes=None if limit is None else max(0,limit-(usage-reclaim)))

def resource_snapshot():
 available=int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024
 root=Path('/sys/fs/cgroup');version=None;failcnt=None;oom=None
 if (root/'memory.current').exists():
  version=2;usage=int((root/'memory.current').read_text());text=(root/'memory.max').read_text().strip();limit=None if text=='max' else int(text)
  values={k:int(v) for k,v in (line.split() for line in (root/'memory.stat').read_text().splitlines())};inactive=values.get('inactive_file',0)
  oom=(root/'memory.events').read_text() if (root/'memory.events').exists() else None
 else:
  root=root/'memory';assert (root/'memory.usage_in_bytes').exists(),'Compiler cgroup accounting unavailable'
  version=1;usage=int((root/'memory.usage_in_bytes').read_text());limit=int((root/'memory.limit_in_bytes').read_text());limit=None if limit>=1<<60 else limit
  values={k:int(v) for k,v in (line.split() for line in (root/'memory.stat').read_text().splitlines())};inactive=values.get('total_inactive_file',values.get('inactive_file',0))
  failcnt=int((root/'memory.failcnt').read_text());oom=(root/'memory.oom_control').read_text()
 result=headroom(available,usage,limit,inactive);result.update(checked=time.time(),cgroup_version=version,cgroup_failure_counter=failcnt,cgroup_oom_state=oom)
 return result

def has_headroom(snapshot,preparation=False):
 host_floor=(14 if preparation else 6)*1024**3;cgroup_floor=(8 if preparation else 3)*1024**3
 cgroup=snapshot['cgroup_headroom_after_inactive_file_bytes']
 return snapshot['ordinary_available_bytes']>host_floor and (cgroup is None or cgroup>cgroup_floor)
