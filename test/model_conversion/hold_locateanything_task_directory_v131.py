"""Hold only an inherited handle to approved D-drive task staging.

The existing container cannot bind-mount this external drvfs directory (EINVAL).
No new mounts,container,quota or existing process changes. Callers must verify
this exact PID/start/argv and task-owner marker before using its directory FD.
"""
from pathlib import Path
import json,os,signal,time,hashlib
STAGE=Path('/work/official-llm-v1');REPORT=STAGE/'d-task-storage-v131-holder.json'
def write(r):
 p=REPORT.with_name('.'+REPORT.name+'.incoming');p.write_text(json.dumps(r,indent=2)+'\n');p.replace(REPORT)
def main():
 assert not REPORT.exists();marker=Path('/proc/self/fd/9/.ainvr-task-owner.json');owner=json.loads(marker.read_text());assert owner['thread']=='01a11f62-f8a4-7801-8cd1-52fbcea37056' and owner['source_directory']=='/home/sunrise/ainvr'
 pid=os.getpid();r=dict(status='holding_task_directory_fd',pid=pid,start_ticks=Path('/proc/self/stat').read_text().rsplit(')',1)[1].split()[19],source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),started=time.time(),fd=9,access_path=f'/proc/{pid}/fd/9',source_windows='D:/codex-task-staging/ainvr-locateanything-w4',owner=owner,mounts_created=False,new_container=False,quota_changed=False,initial_bind_attempts_failed_without_mount=True)
 write(r);stop=False
 def done(*_):
  nonlocal stop;stop=True
 signal.signal(signal.SIGTERM,done);signal.signal(signal.SIGHUP,done)
 try:
  while not stop:signal.pause()
 finally:os.close(9);r.update(status='closed_owned_task_directory_fd',finished=time.time());write(r)
if __name__=='__main__':main()
