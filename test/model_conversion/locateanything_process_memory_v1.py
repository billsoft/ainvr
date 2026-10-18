"""Read task-owned process memory domains separately;never infer a deduplicated peak.

Every sample binds PID/start ticks/PGID/UID/exact command argument. RSS,VmHWM,
smaps categories and owned ION remain separate. CPU/device mapping overlap and
unobserved allocator peaks require later interpretation,not an automatic pass.
"""
from pathlib import Path
import re,time

def identity(pid):
 root=Path('/proc')/str(pid);tail=(root/'stat').read_text().rsplit(')',1)[1].split()
 status=(root/'status').read_text();uids=next(x for x in status.splitlines() if x.startswith('Uid:')).split()[1:]
 return dict(pid=pid,start_ticks=tail[19],pgid=int(tail[2]),uid=int(uids[0]),effective_uid=int(uids[1]),arguments=(root/'cmdline').read_bytes().split(bytes([0])))

def require_owned(pid,start_ticks,pgid,argument,uid=1000):
 item=identity(pid)
 assert item['start_ticks']==str(start_ticks) and item['pgid']==pgid,'Task process identity changed'
 assert item['uid']==item['effective_uid']==uid and argument.encode() in item['arguments'],'Not the declared inference worker'
 return item

def find_owned_workers(pgid,argument,uid=1000):
 result=[]
 for proc in Path('/proc').iterdir():
  if not proc.name.isdigit():continue
  try:
   tail=(proc/'stat').read_text().rsplit(')',1)[1].split()
   if int(tail[2])!=pgid:continue
   item=identity(int(proc.name))
   if item['uid']==item['effective_uid']==uid and argument.encode() in item['arguments']:
    assert item['pgid']==pgid;result.append(item)
  except (FileNotFoundError,ProcessLookupError):pass
 return result

def parse_owned_heap(text,heap,pid):
 total=0
 for line in text.split('allocations (',1)[0].splitlines():
  values=line.split()
  if len(values)==4 and values[0]==heap and values[2].isdigit() and int(values[2])==pid:
   size=int(values[3]);assert size>=0;total+=size
 return total

def parse_smaps(text):
 totals=dict(total_rss_bytes=0,total_pss_bytes=0,anonymous_rss_bytes=0,file_rss_bytes=0,device_or_pfnmap_rss_bytes=0,device_mappings=0)
 current=None
 def finish():
  if current is None:return
  rss=current.get('Rss',0);pss=current.get('Pss',0);name=current['name'];flags=current.get('VmFlags','').split()
  totals['total_rss_bytes']+=rss;totals['total_pss_bytes']+=pss
  device=name.startswith('/dev/') or 'pf' in flags or 'io' in flags
  if device:totals['device_or_pfnmap_rss_bytes']+=rss;totals['device_mappings']+=1
  elif name.startswith('/'):totals['file_rss_bytes']+=rss
  else:totals['anonymous_rss_bytes']+=rss
 for line in text.splitlines():
  if re.match(r'^[0-9a-f]+-[0-9a-f]+ ',line):
   finish();parts=line.split(None,5);current=dict(name=parts[5] if len(parts)==6 else '')
  elif current is not None and ':' in line:
   key,value=line.split(':',1)
   if key in ['Rss','Pss']:current[key]=int(value.split()[0])*1024
   elif key=='VmFlags':current[key]=value.strip()
 finish();return totals

def sample_owned_process(pid,start_ticks,pgid,argument,uid=1000,smaps=False):
 before=require_owned(pid,start_ticks,pgid,argument,uid);root=Path('/proc')/str(pid)
 values={}
 for line in (root/'status').read_text().splitlines():
  if line.startswith(('VmRSS:','VmHWM:')):
   key,value=line.split(':',1);values[key]=int(value.split()[0])*1024
 heaps={}
 for name in ['cma_reserved','carveout','ion_cma']:
  path=Path('/sys/kernel/debug/ion/heaps')/name
  if path.exists():heaps[name]=parse_owned_heap(path.read_text(),name,pid)
 result=dict(pid=pid,start_ticks=str(start_ticks),pgid=pgid,uid=uid,checked=time.time(),rss_bytes=values.get('VmRSS',0),rss_high_water_bytes=values.get('VmHWM',0),owned_heap_bytes=heaps)
 if smaps:result['smaps']=parse_smaps((root/'smaps').read_text())
 after=require_owned(pid,start_ticks,pgid,argument,uid);assert before==after
 return result

def accumulate(summary,sample):
 summary.setdefault('sample_count',0);summary['sample_count']+=1
 summary.setdefault('first_checked',sample['checked']);summary['last_checked']=sample['checked']
 summary.setdefault('identities',{})[str(sample['pid'])]=dict(start_ticks=sample['start_ticks'],pgid=sample['pgid'],uid=sample['uid'])
 for key in ['rss_bytes','rss_high_water_bytes']:summary[key+'_maximum']=max(summary.get(key+'_maximum',0),sample[key])
 peaks=summary.setdefault('owned_heap_bytes_maxima',{})
 for name,value in sample['owned_heap_bytes'].items():peaks[name]=max(peaks.get(name,0),value)
 if 'smaps' in sample:
  summary['latest_smaps']=sample['smaps'];summary['smaps_sample_count']=summary.get('smaps_sample_count',0)+1
 summary.update(exact_allocator_peak_verified=False,deduplicated_total_memory_verified=False,memory_requirement_passed=False)
 return summary
