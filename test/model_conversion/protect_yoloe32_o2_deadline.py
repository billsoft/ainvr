"""AINVR preserve one identified O2 compiler while replacing its deadline.
Only the owned GNU timeout wrapper is stopped; compilation continues.
Never resume that wrapper after its original alarm has expired.
"""
import argparse, hashlib, json, os, signal, time
from pathlib import Path

ROOT = Path('/work/yoloe32-attention-ec-o2-v7')
BC = '3b8738559f637d8065d56c56e4bf3a89c93f34f15be84e2f603c8dff3d6d1e10'
RECORD = ROOT / 'deadline-extension.json'
PYTHON_PID, WRAPPER_PID = 81538, 81537

def identity(pid):
    proc = Path('/proc') / str(pid)
    stat = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
    return {'pid':pid, 'state':stat[0], 'ppid':int(stat[1]),
            'pgid':int(stat[2]), 'start_ticks':int(stat[19]),
            'argv':(proc / 'cmdline').read_bytes().decode().split('\0')[:-1]}

def same(saved):
    try:
        now = identity(saved['pid'])
        return now['start_ticks'] == saved['start_ticks'] and now['argv'] == saved['argv']
    except FileNotFoundError:
        return False

def uptime():
    return float(Path('/proc/uptime').read_text().split()[0])

def save(record):
    tmp = RECORD.with_suffix('.tmp')
    tmp.write_text(json.dumps(record, indent=2) + '\n')
    tmp.replace(RECORD)

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('mode', choices=['prepare', 'watch'])
a = p.parse_args()
if a.mode == 'prepare':
    assert not RECORD.exists(), 'Existing protection must be audited, not overwritten'
    status = json.loads((ROOT/'status.json').read_text())
    assert status['state']=='compiling' and status['bc_sha256']==BC and status['opt']==2
    worker, wrapper = identity(PYTHON_PID), identity(WRAPPER_PID)
    assert worker['ppid']==WRAPPER_PID and worker['pgid']==wrapper['pgid']==WRAPPER_PID
    assert worker['argv'][0]=='python3' and worker['argv'][1]=='/work/compile-bc32.py'
    assert str(ROOT) in worker['argv'] and BC in worker['argv']
    assert wrapper['argv']==['timeout','7200']+worker['argv']
    start = worker['start_ticks']/os.sysconf('SC_CLK_TCK')
    assert uptime()-start < 6900, 'Too close to original expiry for safe replacement'
    record = {'state':'preparing', 'worker':worker, 'wrapper':wrapper,
              'bc_sha256':BC, 'old_timeout_seconds':7200,
              'new_total_timeout_seconds':21600, 'deadline_uptime':start+21600,
              'prepared_unix':time.time(), 'warning':'Do not resume original timeout wrapper'}
    save(record)
    os.kill(WRAPPER_PID, signal.SIGSTOP)
    for _ in range(20):
        if identity(WRAPPER_PID)['state']=='T': break
        time.sleep(.05)
    assert identity(WRAPPER_PID)['state']=='T' and same(worker)
    record['state']='protected_compiler_running'
    save(record)
    print('Protected exact timeout wrapper; compiler continues under six-hour total deadline')
else:
    record = json.loads(RECORD.read_text())
    assert record['state']=='protected_compiler_running'
    assert same(record['wrapper']) and identity(WRAPPER_PID)['state']=='T'
    record['watchdog_pid']=os.getpid()
    record['watchdog_started_unix']=time.time()
    save(record)
    while True:
        if not same(record['worker']):
            status = json.loads((ROOT/'status.json').read_text())
            terminal = status.get('state')=='compile_failed'
            if status.get('state')=='compiled_needs_validation':
                model = ROOT/'detector.hbm'
                terminal = model.is_file() and hashlib.sha256(model.read_bytes()).hexdigest()==status.get('hbm_sha256')
            if terminal and same(record['wrapper']):
                os.kill(WRAPPER_PID, signal.SIGKILL)
                record['state']='terminal_artifact_confirmed_wrapper_cleaned'
            else:
                record['state']='worker_exited_needs_manual_audit'
            record['finished_unix']=time.time()
            save(record)
            break
        assert same(record['wrapper']) and identity(WRAPPER_PID)['state']=='T'
        if uptime()>=record['deadline_uptime']:
            # The verified stopped wrapper still owns the unique process group.
            os.killpg(WRAPPER_PID, signal.SIGTERM)
            time.sleep(10)
            if same(record['wrapper']):
                os.killpg(WRAPPER_PID, signal.SIGKILL)
            record['state']='six_hour_deadline_reached_task_group_stopped'
            record['finished_unix']=time.time()
            save(record)
            break
        time.sleep(min(300, max(1, record['deadline_uptime']-uptime())))
