"""Lifetime residency lock shared with llm-service protocol 2. No debugfs reads."""
import fcntl
import json
import os
from pathlib import Path

class LargeModelReservation:
    def __init__(self, directory='/run/ainvr'):
        self.root = Path(directory)
        self.fd = os.open(self.root/'bpu-reservation.lock', os.O_CREAT|os.O_RDWR|os.O_CLOEXEC|os.O_NOFOLLOW, 0o600)
        try:
            try: fcntl.flock(self.fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: raise RuntimeError('large_model_busy') from None
            registry = self.root/'bpu-reservations.json'
            if registry.exists():
                for holder in json.loads(registry.read_text())['holders']:
                    if self.identity(holder['pid']) == holder['start_ticks']:
                        raise RuntimeError('uncoordinated_model_holder')
            self.holder = dict(service='locateanything',pid=os.getpid(),start_ticks=self.identity(os.getpid()),bytes=5190000000,state='loading',protocol=2)
            self.write([self.holder])
        except BaseException:
            os.close(self.fd); self.fd = None
            raise
    @staticmethod
    def identity(pid):
        if type(pid) is not int or pid <= 0: raise ValueError('invalid holder pid')
        try: text = Path(f'/proc/{pid}/stat').read_text()
        except FileNotFoundError: return None
        return text[text.rfind(')')+2:].split()[19]
    def write(self, holders):
        path = self.root/f'bpu-reservations.json.{os.getpid()}.tmp'
        path.write_text(json.dumps(dict(protocol=2,holders=holders)))
        path.replace(self.root/'bpu-reservations.json')
    def loaded(self):
        self.holder['state']='loaded'; self.write([self.holder])
    def close(self):
        if self.fd is not None:
            try: self.write([])
            finally: os.close(self.fd); self.fd=None

class ReservedExecutor:
    """Keep residency lock on SDK cleanup failure, until process exit."""
    def __init__(self, executor, reservation):
        self.executor,self.reservation=executor,reservation
    def __getattr__(self,name): return getattr(self.executor,name)
    def close(self):
        self.executor.close()
        self.reservation.close()
