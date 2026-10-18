"""One SDK owner thread;requests share weights,never generation/KV state.

No model choice/admission or neural operation lives in this transport helper.
A synchronous SDK stall remains covered by the existing process watchdog.
"""
import math,queue,threading,time

class RequestBoundProxy:
 def __init__(self,executor,check):self._executor=executor;self._check=check
 def __getattr__(self,name):return getattr(self._executor,name)
 def run_ordered(self,key,values):
  self._check();result=self._executor.run_ordered(key,values);self._check();return result

class PersistentRequestWorker:
 def __init__(self,factory):
  self._factory=factory;self._queue=queue.Queue(maxsize=1);self._closing=threading.Event();self._gate=threading.Lock();self._lock=threading.Lock()
  self._state=dict(alive=True,cached_models=0,completed_requests=0,failed_requests=0)
  self._thread=threading.Thread(target=self._loop,name='locateanything-sdk-owner',daemon=False);self._thread.start()
 def snapshot(self):
  with self._lock:return dict(self._state,stopping=self._closing.is_set())
 def execute(self,operation,cancelled,maximum_seconds):
  if isinstance(maximum_seconds,bool) or not isinstance(maximum_seconds,(int,float)) or not math.isfinite(maximum_seconds) or not 0<maximum_seconds<=3600:raise ValueError('Invalid persistent request bound')
  if not self._gate.acquire(blocking=False):raise RuntimeError('Persistent inference worker is busy')
  try:
   if self._closing.is_set() or not self._thread.is_alive():raise RuntimeError('Persistent worker is stopping')
   job=dict(operation=operation,cancelled=cancelled,deadline=time.monotonic()+maximum_seconds,done=threading.Event())
   self._queue.put_nowait(job)
   while not job['done'].wait(.1):
    if not self._thread.is_alive():raise RuntimeError('SDK owner thread exited')
   if 'error' in job:raise job['error']
   return job['result']
  finally:self._gate.release()
 def _loop(self):
  executor=None
  try:
   while True:
    job=self._queue.get()
    if job is None:break
    try:
     def check():
      if self._closing.is_set() or (job['cancelled'] is not None and job['cancelled']()):raise RuntimeError('Inference request cancelled')
      if time.monotonic()>job['deadline']:raise TimeoutError('Inference request exceeded its bound')
     check()
     if executor is None:executor=self._factory()
     check();job['result']=job['operation'](RequestBoundProxy(executor,check));check()
     with self._lock:self._state['completed_requests']+=1
    except BaseException as error:
     job['error']=error
     with self._lock:self._state['failed_requests']+=1
     try:
      if executor is not None:executor.close()
     except BaseException:
      job['error']=RuntimeError('SDK cleanup failed');self._closing.set()
     executor=None
    finally:
     with self._lock:self._state['cached_models']=len(executor.loaded) if executor is not None else 0
     job['done'].set()
    if self._closing.is_set():break
  finally:
   try:
    if executor is not None:executor.close()
   finally:
    with self._lock:self._state.update(alive=False,cached_models=0)
 def close(self,timeout=5):
  if threading.current_thread() is self._thread:raise RuntimeError('SDK owner cannot join itself')
  self._closing.set()
  try:self._queue.put_nowait(None)
  except queue.Full:pass
  self._thread.join(timeout)
  if self._thread.is_alive():raise TimeoutError('SDK owner is still in flight;models were not unloaded by caller')
