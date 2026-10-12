"""Protect existing jobs by terminating only a verified new GPU compile on pressure."""
import argparse
import json
import os
from pathlib import Path
import signal
import time

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--pid', type=int, required=True)
p.add_argument('--config', required=True)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
proc = Path('/proc') / str(a.pid)
assert a.config.encode() in (proc / 'cmdline').read_bytes().split(b'\0')
start = (proc / 'stat').read_text().split()[21]
a.output.mkdir(exist_ok=False)

def same_process():
    try:
        return ((proc / 'stat').read_text().split()[21] == start and
                a.config.encode() in (proc / 'cmdline').read_bytes().split(b'\0'))
    except FileNotFoundError:
        return False

low = 0
with (a.output / 'memory.jsonl').open('a', buffering=1) as log:
    for tick in range(10800):
        if not same_process():
            log.write(json.dumps({'event': 'compiler_exited', 'time': time.time()}) + '\n')
            break
        mem = {line.split(':')[0]: int(line.split()[1])
               for line in Path('/proc/meminfo').read_text().splitlines()}
        low = low + 1 if mem['MemAvailable'] < 3 * 1024 * 1024 else 0
        if tick % 30 == 0 or low:
            log.write(json.dumps({'time': time.time(), 'available_kib': mem['MemAvailable'],
                                 'swap_free_kib': mem['SwapFree'], 'low_count': low}) + '\n')
        if low >= 3:
            if same_process():
                os.kill(a.pid, signal.SIGTERM)
                log.write(json.dumps({'event': 'terminated_gpu_compile_for_memory_pressure',
                                      'pid': a.pid, 'time': time.time()}) + '\n')
            break
        time.sleep(2)
