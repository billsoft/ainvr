"""Own-process RSS once plus ION owned by its main PID or any live task TID.

Stable PID/start/UID/PGID/argv and stable thread membership are mandatory.
This is sampled,conservative accounting;no exact/deduplicated peak is claimed.
"""
from pathlib import Path
import hashlib,time

V3=Path('/home/sunrise/ainvr/test/model_conversion/locateanything_process_memory_v3.py')
assert hashlib.sha256(V3.read_bytes()).hexdigest()=='f44418597c95456336454634980772fbbecfdaf189a04c9d450fdc8d8b24bb57'
from locateanything_process_memory_v3 import require_owned,IncompleteProcessSnapshot,parse_smaps,accumulate

def task_identities(pid,uid=1000):
 result={}
 for task in (Path('/proc')/str(pid)/'task').iterdir():
  if not task.name.isdigit():continue
  tail=(task/'stat').read_text().rsplit(')',1)[1].split()
  status=(task/'status').read_text().splitlines()
  tgid=int(next(x for x in status if x.startswith('Tgid:')).split()[1])
  uids=[int(x) for x in next(x for x in status if x.startswith('Uid:')).split()[1:]]
  assert tgid==pid and uids[0]==uids[1]==uid,'Not the declared process task'
  if tail[0] in ['Z','X']:raise IncompleteProcessSnapshot('Task exited during sample')
  result[int(task.name)]=tail[19]
 assert pid in result
 return result

def parse_owned_tasks_heap(text,heap,tids):
 result={}
 for line in text.split('allocations (',1)[0].splitlines():
  values=line.split()
  if len(values)==4 and values[0]==heap and values[2].isdigit() and int(values[2]) in tids:
   owner=int(values[2]);size=int(values[3]);assert size>=0
   result[owner]=result.get(owner,0)+size
 return result

def sample_owned_process(pid,start_ticks,pgid,argument,uid=1000,smaps=False):
 before=require_owned(pid,start_ticks,pgid,argument,uid);root=Path('/proc')/str(pid)
 tasks=task_identities(pid,uid);values={}
 for line in (root/'status').read_text().splitlines():
  if line.startswith(('VmRSS:','VmHWM:')):
   key,value=line.split(':',1);values[key]=int(value.split()[0])*1024
 heaps={};by_task={}
 for name in ['cma_reserved','carveout','ion_cma']:
  path=Path('/sys/kernel/debug/ion/heaps')/name
  if path.exists():
   owners=parse_owned_tasks_heap(path.read_text(),name,set(tasks));heaps[name]=sum(owners.values());by_task[name]={str(k):v for k,v in owners.items()}
 result=dict(pid=pid,start_ticks=str(start_ticks),pgid=pgid,uid=uid,checked=time.time(),
  rss_bytes=values.get('VmRSS',0),rss_high_water_bytes=values.get('VmHWM',0),
  owned_heap_bytes=heaps,owned_heap_bytes_by_task=by_task,
  owned_task_start_ticks={str(k):v for k,v in tasks.items()},thread_count=len(tasks),
  rss_counted_once_for_tgid=True,ion_owner_scope='main_pid_and_current_process_task_tids',
  exact_allocator_peak_verified=False,deduplicated_total_memory_verified=False)
 if smaps:result['smaps']=parse_smaps((root/'smaps').read_text())
 after_tasks=task_identities(pid,uid)
 if tasks!=after_tasks:raise IncompleteProcessSnapshot('Process thread membership changed during ION sample')
 after=require_owned(pid,start_ticks,pgid,argument,uid)
 assert all(before[k]==after[k] for k in ['pid','start_ticks','pgid','uid','effective_uid','arguments'])
 return result
