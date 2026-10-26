"""Test-only isolated IP link: real loss, delay, reordering and disconnection.

Two nonpersistent TUN devices join the host to one network namespace. Only
198.18.0.1 <-> 198.18.0.2 packets are relayed. Physical interfaces, SSH routes,
firewall rules and host traffic-control settings are never modified.
"""
import ctypes
import fcntl
import heapq
import ipaddress
import json
import os
from pathlib import Path
import random
import select
import struct
import subprocess
import threading
import time

NETWORK=ipaddress.ip_network('198.18.0.0/30')
HOST='198.18.0.1'
CAMERA='198.18.0.2'
NAMESPACE='ainvr-onvif-fault'

def command(args):
    return subprocess.check_output(args,stderr=subprocess.STDOUT,timeout=10)

class FaultLink:
    def __init__(self):
        self.fds=[]
        self.thread=None
        self.created=False
        self.stopped=threading.Event()
        self.lock=threading.Lock()
        self.policy={'drop':0.,'delay':0.,'jitter':0.,'cut':False,'seed':28181,'epoch':0}
        self.stats={'packets':0,'injected':0,'dropped':0,'queueDrops':0,'bytes':0,'queuePeak':0}
        self.error=None
        self.applied=threading.Condition(self.lock)
        self.applied_epoch=-1

    def __enter__(self):
        if os.geteuid()!=0:raise RuntimeError('Root is required for the isolated test namespace')
        if Path('/run/netns',NAMESPACE).exists():raise RuntimeError('Test namespace already exists; inspect its owner first')
        for route in json.loads(command(['ip','-j','-4','route','show'])):
            destination=route.get('dst','default')
            if destination!='default' and ipaddress.ip_network(destination,strict=False).overlaps(NETWORK):raise RuntimeError('Benchmark test network is already routed')
        try:
            command(['ip','netns','add',NAMESPACE]);self.created=True
            self.namespace_inode=Path('/run/netns',NAMESPACE).stat().st_ino
            self.fds.append(self.tun('avonvif0'))
            libc=ctypes.CDLL(None,use_errno=True)
            with open('/proc/self/ns/net','rb') as original,open('/run/netns/'+NAMESPACE,'rb') as isolated:
                if libc.setns(isolated.fileno(),0):raise OSError(ctypes.get_errno(),'enter network namespace')
                try:self.fds.append(self.tun('avcam0'))
                finally:
                    if libc.setns(original.fileno(),0):raise OSError(ctypes.get_errno(),'restore network namespace')
            command(['ip','addr','add',HOST+'/30','dev','avonvif0'])
            command(['ip','link','set','avonvif0','mtu','1400','up'])
            command(['ip','netns','exec',NAMESPACE,'ip','addr','add',CAMERA+'/30','dev','avcam0'])
            command(['ip','netns','exec',NAMESPACE,'ip','link','set','avcam0','mtu','1400','up'])
            command(['ip','netns','exec',NAMESPACE,'ip','link','set','lo','up'])
            self.thread=threading.Thread(target=self.relay,name='onvif-test-ip-relay',daemon=True)
            self.thread.start()
            return self
        except BaseException:
            self.close();raise

    @staticmethod
    def tun(name):
        fd=os.open('/dev/net/tun',os.O_RDWR|os.O_NONBLOCK)
        try:fcntl.ioctl(fd,0x400454ca,struct.pack('16sH',name.encode(),0x0001|0x1000))
        except BaseException:os.close(fd);raise
        return fd

    def configure(self,*,drop=0.,delay=0.,jitter=0.,cut=False,seed=28181):
        if not 0<=drop<=.5 or not 0<=delay<=.25 or not 0<=jitter<=.25:raise ValueError('Bounded test fault parameters required')
        with self.lock:
            self.policy={'drop':drop,'delay':delay,'jitter':jitter,'cut':bool(cut),'seed':int(seed),'epoch':self.policy['epoch']+1}
            epoch=self.policy['epoch']
            if not self.applied.wait_for(lambda:self.applied_epoch>=epoch or self.stopped.is_set(),timeout=2):raise RuntimeError('Fault relay policy application timed out')
            if self.error:raise RuntimeError('Fault relay failed')

    def snapshot(self):
        with self.lock:return {**self.stats,'policy':dict(self.policy),'error':self.error}

    def relay(self):
        queue=[];sequence=0;epoch=-1;queued_bytes=0;rng=random.Random(28181)
        allowed={(ipaddress.ip_address(HOST).packed,ipaddress.ip_address(CAMERA).packed),(ipaddress.ip_address(CAMERA).packed,ipaddress.ip_address(HOST).packed)}
        try:
            while not self.stopped.is_set():
                with self.lock:policy=dict(self.policy)
                if policy['epoch']!=epoch:
                    epoch=policy['epoch'];rng.seed(policy['seed'])
                    if policy['cut']:
                        with self.lock:self.stats['dropped']+=len(queue)
                        queue.clear();queued_bytes=0
                    with self.applied:
                        self.applied_epoch=epoch;self.applied.notify_all()
                ready,_,_=select.select(self.fds,[],[],.01)
                for fd in ready:
                    packet=os.read(fd,65536)
                    # This relay cannot become a bridge to production networks.
                    if len(packet)<20 or packet[0]>>4!=4 or (packet[12:16],packet[16:20]) not in allowed:continue
                    with self.lock:self.stats['packets']+=1;self.stats['bytes']+=len(packet)
                    if policy['cut'] or rng.random()<policy['drop']:
                        with self.lock:self.stats['dropped']+=1
                        continue
                    if len(queue)>=2048 or queued_bytes+len(packet)>8<<20:
                        with self.lock:self.stats['queueDrops']+=1
                        continue
                    sequence+=1;queued_bytes+=len(packet)
                    due=time.monotonic()+max(0,policy['delay']+rng.uniform(-policy['jitter'],policy['jitter']))
                    heapq.heappush(queue,(due,sequence,self.fds[1] if fd==self.fds[0] else self.fds[0],packet))
                    with self.lock:self.stats['queuePeak']=max(self.stats['queuePeak'],len(queue))
                now=time.monotonic()
                while queue and queue[0][0]<=now:
                    _,_,fd,packet=heapq.heappop(queue);queued_bytes-=len(packet)
                    try:os.write(fd,packet)
                    except BlockingIOError:
                        with self.lock:self.stats['queueDrops']+=1
                    else:
                        with self.lock:self.stats['injected']+=1
        except BaseException as error:
            with self.lock:self.error=type(error).__name__
            self.stopped.set()

    def close(self):
        self.stopped.set()
        if self.thread:self.thread.join(timeout=2)
        for fd in self.fds:os.close(fd)
        self.fds=[]
        if self.created:
            path=Path('/run/netns',NAMESPACE)
            if path.exists() and path.stat().st_ino==self.namespace_inode:command(['ip','netns','delete',NAMESPACE])
            else:raise RuntimeError('Namespace identity changed; refusing to remove another owner')
            self.created=False

    def __exit__(self,*_):self.close()

if __name__=='__main__':
    # Bounded positive/negative control, independent of media and ONVIF code.
    with FaultLink() as link:
        command(['ping','-c','1','-W','2',CAMERA])
        link.configure(cut=True)
        cut=subprocess.run(['ping','-c','1','-W','1',CAMERA],capture_output=True,timeout=3)
        assert cut.returncode!=0
        link.configure(drop=.1,jitter=.02,seed=20261026)
        subprocess.run(['ping','-c','20','-i','.05','-W','1',CAMERA],capture_output=True,timeout=5)
        link.configure()
        command(['ping','-c','1','-W','2',CAMERA])
        state=link.snapshot();assert state['dropped']>0 and not state['error']
        print(json.dumps({'passed':True,**state}))
    assert not Path('/run/netns',NAMESPACE).exists()
