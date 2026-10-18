"""Control-only memory sampler test with a real owned two-thread process.

No BPU model load. Heap ownership parsing uses an explicit synthetic table;
actual process/task identities,RSS and smaps are read on the board.
"""
from pathlib import Path
import argparse,hashlib,json,os,signal,subprocess,sys,threading,time
from locateanything_process_memory_v4 import sample_owned_process,parse_owned_tasks_heap
ROOT=Path('/home/sunrise/ainvr');RESULTS=ROOT/'test/results'
SAMPLER_SHA='0d4517e81b629caae4530e9821c2d81513c3f2427dc8813c4595fa12aa77480b'
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def ticks(pid):return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]

def worker(marker):
 assert os.getuid()==1000 and marker.parent.resolve().parent==RESULTS
 event=threading.Event();thread=threading.Thread(target=lambda:event.wait(30),name='sampler-control-owner');thread.start()
 try:
  data=dict(pid=os.getpid(),start_ticks=ticks(os.getpid()),pgid=os.getpgrp(),tid=thread.native_id)
  temp=marker.with_name(marker.name+'.tmp');temp.write_text(json.dumps(data)+'\n');temp.replace(marker);event.wait(30)
 finally:event.set();thread.join(5)

def main():
 p=argparse.ArgumentParser();p.add_argument('--worker',type=Path);a=p.parse_args()
 if a.worker is not None:worker(a.worker);return
 assert os.getuid()==0
 assert sha(Path(__file__).parent/'locateanything_process_memory_v4.py')==SAMPLER_SHA
 directory=RESULTS/'official-process-memory-v4-controls-v1';report=RESULTS/'official-process-memory-v4-controls-v1.json'
 assert not directory.exists() and not report.exists();directory.mkdir(mode=0o750);os.chown(directory,1000,1000)
 marker=directory/'identity.json';child=None;identity=None;data=None;r=dict(status='running',started=time.time(),source_sha256=sha(Path(__file__)),sampler_sha256=SAMPLER_SHA,neural_calls=0,whole_model_verified=False,release_approved=False)
 try:
  with (directory/'worker.log').open('xb') as log:
   command=['runuser','-u','sunrise','--',str(ROOT/'ai-service/runtime/.venv-locateanything/bin/python'),str(Path(__file__).resolve()),'--worker',str(marker)]
   child=subprocess.Popen(command,cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);identity=ticks(child.pid)
   deadline=time.monotonic()+10
   while not marker.exists():
    assert child.poll() is None and time.monotonic()<deadline;time.sleep(.05)
   data=json.loads(marker.read_text());assert data['pgid']==child.pid and data['pid']!=data['tid']
   sample=sample_owned_process(data['pid'],data['start_ticks'],child.pid,str(Path(__file__).resolve()),uid=1000,smaps=True)
   assert sample['rss_counted_once_for_tgid'] and sample['thread_count']>=2
   assert str(data['pid']) in sample['owned_task_start_ticks'] and str(data['tid']) in sample['owned_task_start_ticks']
   assert sample['rss_bytes']>0 and sample['smaps']['total_rss_bytes']>0
   assert set(sample['owned_heap_bytes'])==set(sample['owned_heap_bytes_by_task'])
   assert all(sum(values.values())==sample['owned_heap_bytes'][heap] for heap,values in sample['owned_heap_bytes_by_task'].items())
   owners={int(x) for x in sample['owned_task_start_ticks']};outsider=max(owners)+1000000
   table=f"cma_reserved one {data['pid']} 100\ncma_reserved two {data['tid']} 200\ncma_reserved unrelated {outsider} 99999\nallocations (footer ignored)\n"
   parsed=parse_owned_tasks_heap(table,'cma_reserved',owners)
   assert parsed=={data['pid']:100,data['tid']:200} and sum(parsed.values())==300
   rejected=[]
   for name,overrides in [('start_ticks',dict(start_ticks=str(int(data['start_ticks'])+1))),('pgid',dict(pgid=child.pid+1)),('uid',dict(uid=0)),('argv',dict(argument=str(Path(__file__).resolve())+'-wrong'))]:
    args=dict(pid=data['pid'],start_ticks=data['start_ticks'],pgid=child.pid,argument=str(Path(__file__).resolve()),uid=1000);args.update(overrides)
    failed=False
    try:sample_owned_process(**args)
    except AssertionError:failed=True
    assert failed,name;rejected.append(name)
   r.update(status='passed_control_only',actual_owned_multithread_sample=sample,
    synthetic_main_plus_owner_thread_heap_bytes=300,unrelated_owner_excluded=True,negative_identity_cases=rejected,
    model_memory_requirement_passed=False,note='Control identities and synthetic owner parsing only;no actual model allocation,peak or speed claim.')
 finally:
  if child is not None and child.poll() is None:
   assert ticks(child.pid)==identity and os.getpgid(child.pid)==child.pid
   assert str(Path(__file__).resolve()).encode() in Path(f'/proc/{child.pid}/cmdline').read_bytes().split(b'\0')
   os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=5)
   except subprocess.TimeoutExpired:
    assert ticks(child.pid)==identity;os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
  r.update(owned_worker_cleaned=child is not None and child.poll() is not None,finished=time.time())
  report.write_text(json.dumps(r,indent=2)+'\n');os.chown(report,1000,1000)
 assert r['status']=='passed_control_only' and r['owned_worker_cleaned']
 print(json.dumps(dict(status=r['status'],actual_thread_count=r['actual_owned_multithread_sample']['thread_count'],negative_identity_cases=len(r['negative_identity_cases']),report_sha256=sha(report),neural_calls=0)))

if __name__=='__main__':main()
