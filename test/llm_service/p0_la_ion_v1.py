"""P0-C 补测：LocateAnything 首次请求触发懒加载后的 ION 占用。
需以 root 在 board_guard_eval_v2.sh 内运行（AI 与 LocateAnything 已暂停）；请求客户端以 sunrise 身份发送
（执行器只接受 sunrise 的连接）。用法：python3 p0_la_ion_v1.py OUT_DIR"""
import sys, json, time, re, subprocess, threading
from pathlib import Path

OUT = Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
PY = '/home/sunrise/ainvr/ai-service/runtime/.venv-locateanything/bin/python'
CLIENT = r'''
import socket,struct,json,sys,numpy as np
pix=np.full((3,224,448),0.5,'<f4').tobytes()
req=dict(schema_version=1,operation='generate',contract_sha256='a4f584ab8e7f8742006bb4345e5ce7307846129534580715e543774401f92381',
         description='person',tokens=8,input_bytes=len(pix),input_shape=[3,224,448],pixel_format='rgb-chw-f32le')
s=socket.socket(socket.AF_UNIX);s.settimeout(150);s.connect('/home/sunrise/ainvr/data/ai/locateanything-official-bpu.sock')
h=json.dumps(req).encode();s.sendall(struct.pack('!I',len(h))+h);s.sendall(pix)
n=struct.unpack('!I',s.recv(4,socket.MSG_WAITALL))[0];buf=b''
while len(buf)<n:buf+=s.recv(n-len(buf))
print(buf[:800].decode('utf-8','replace'))
'''


def ion():
    raise RuntimeError('已禁用：读取 /sys/kernel/debug/ion 会使本板内核崩溃（2026-10-22 事故），不要再运行本脚本')


R = dict(ion_before=ion())
subprocess.run(['systemctl', 'start', 'ainvr-locateanything-official-bpu'], timeout=700)
R['ion_after_start'] = ion()
cf = OUT / 'la_client.py'; cf.write_text(CLIENT); cf.chmod(0o644)
peak = [0]; stop = threading.Event()


def sample():
    while not stop.is_set():
        peak[0] = max(peak[0], ion()); time.sleep(0.2)


th = threading.Thread(target=sample); th.start(); t0 = time.time()
p = subprocess.run(['runuser', '-u', 'sunrise', '--', PY, str(cf)], capture_output=True, text=True, timeout=200)
stop.set(); th.join()
R.update(request_seconds=round(time.time() - t0, 1), rc=p.returncode, response=p.stdout[-800:], stderr=p.stderr[-400:],
         ion_peak=peak[0], ion_after_request=ion())
subprocess.run(['systemctl', 'stop', 'ainvr-locateanything-official-bpu'], timeout=120)
time.sleep(2); R['ion_after_stop'] = ion()
(OUT / 'p0-la-ion.json').write_text(json.dumps(R, indent=1, ensure_ascii=False)); print(json.dumps(R, ensure_ascii=False))
