"""Bounded, read-only host collectors. No user-supplied commands or filesystem paths.

Runtime settings are an effective cache of PostgreSQL configuration supplied by BFF.
Metric history and rotated, redacted log archives remain on the local disk, never NAS.
"""
from __future__ import annotations

import configparser
import ipaddress
import collections
import base64
import heapq
import datetime as dt
import hashlib
import json
import os
import re
import selectors
import shutil
import sqlite3
import subprocess
import threading
import time
from pathlib import Path
from urllib.request import ProxyHandler, build_opener, Request, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
import socket

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(__file__).resolve().parent / 'data' / 'observability'
UNITS = {'ai-service': 'ai-service.service', 'recorder': 'ainvr-recorder.service'}
CONTAINERS = {'frontend': 'frontend', 'backend': 'backend', 'srs': 'srs', 'postgres': 'postgres'}


def deployment_units():
    if os.environ.get('AINVR_DEPLOYMENT_MODE') == 'native':
        return {**UNITS, 'ai-service': 'ainvr-ai.service',
                'frontend': 'ainvr-web.service', 'backend': 'ainvr-backend.service',
                'alarm-service': 'ainvr-alarm.service', 'llm-service': 'ainvr-llm.service',
                **{name: unit for name, unit in {'onvif': 'ainvr-onvif.service', 'gb28181': 'ainvr-gb28181.service', 'gb-media': 'ainvr-gb-media.service', 'search-service': 'ainvr-search.service'}.items()
                   if Path('/etc/systemd/system', unit).exists()}}
    return UNITS


def deployment_containers():
    if os.environ.get('AINVR_DEPLOYMENT_MODE') == 'native':
        return {k: v for k, v in CONTAINERS.items() if k not in ('frontend', 'backend')}
    return CONTAINERS
SOURCES = ['host', 'frontend', 'backend', 'srs', 'postgres', 'mongodb', 'ai-service', 'recorder', 'alarm-service', 'llm-service', 'search-service', 'onvif', 'gb28181', 'gb-media', 'helper']
DEFAULTS = {'fileMiB': 5, 'files': 3, 'historyHours': 72, 'level': 'INFO', 'repeatSeconds': 60}
LEVELS = {'DEBUG': 10, 'INFO': 20, 'WARN': 30, 'ERROR': 40}


def redact(value: str) -> str:
    value = re.sub(r'(?i)\bBearer\s+[^\s,;"}]+', 'Bearer [REDACTED]', value)
    value = re.sub(r'(?i)([a-z][a-z0-9+.-]*://)[^\s/@]+:[^\s/@]+@', r'\1[REDACTED]@', value)
    value = re.sub(r'(?i)((?:password|passwd|secret|token|authorization|api[_-]?key)["\s]*[:=]["\s]*)([^\s,;}]+)', r'\1[REDACTED]', value)
    return value[:4096]


def run(args: list[str], timeout: float = 3, limit: int = 262144, merge_stderr=False) -> str:
    """Bound pipe reads and process waits, including a broken CLI. Never invoke a shell."""
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT if merge_stderr else subprocess.DEVNULL)
    sel = selectors.DefaultSelector()
    sel.register(p.stdout, selectors.EVENT_READ)
    chunks, size, deadline = [], 0, time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            events = sel.select(min(.1, max(0, deadline - time.monotonic())))
            if not events:
                if p.poll() is not None: break
                continue
            chunk = os.read(p.stdout.fileno(), min(65536, limit - size + 1))
            if not chunk: break
            chunks.append(chunk); size += len(chunk)
            if size > limit: raise RuntimeError('collector output limit')
        if p.poll() is None:
            try: p.wait(timeout=.2)
            except subprocess.TimeoutExpired: raise RuntimeError('collector timeout')
        if p.returncode: raise RuntimeError('collector unavailable')
        return b''.join(chunks).decode('utf-8', 'replace')
    finally:
        sel.close()
        if p.poll() is None:
            p.kill()
            try: p.wait(timeout=.2)
            except subprocess.TimeoutExpired: pass
        p.stdout.close()


def http_json(url: str):
    with build_opener(ProxyHandler({})).open(url, timeout=1.5) as r:
        return json.loads(r.read(262144))



class NoProbeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('health probe redirect rejected')


def private_probe(url, token=None, body=None):
    """Fixed local management endpoints; secrets stay in headers/body, never logs."""
    request = Request(url, data=json.dumps(body).encode() if body is not None else None,
                      headers=({'X-Service-Token': token} if token else {}) |
                              ({'Content-Type': 'application/json'} if body is not None else {}))
    with build_opener(ProxyHandler({}), NoProbeRedirect()).open(request, timeout=1.5) as response:
        data = response.read(262145)
        if len(data) > 262144: raise ValueError('probe response exceeds limit')
        result = json.loads(data)
        if not isinstance(result, dict): raise ValueError('invalid health response')
        return result


def onvif_health(path=Path('/etc/ainvr/onvif-bootstrap.json')):
    config = json.loads(path.read_text())
    host, port = config['listen'].rsplit(':', 1)
    if not ipaddress.ip_address(host.strip('[]')).is_loopback or not 1 <= int(port) <= 65535:
        raise ValueError('management endpoint must be loopback')
    state = private_probe('http://' + config['listen'] + '/health', token=config['token'])
    ready = state.get('ready') is True
    return ready, ('控制接口正常；ONVIF 接入已启用' if state.get('enabled') else '控制接口正常；ONVIF 接入已停用') if ready else 'ONVIF 控制服务尚未就绪'


def gateway_health(path=Path('/etc/ainvr/gb28181-bootstrap.json')):
    config = json.loads(path.read_text())
    host, port = config['listen'].rsplit(':', 1)
    if not ipaddress.ip_address(host.strip('[]')).is_loopback or not 1 <= int(port) <= 65535:
        raise ValueError('management endpoint must be loopback')
    state = private_probe('http://' + config['listen'] + '/v1/status', token=config['token'])
    if state.get('error'):
        return False, '国标配置应用失败，请检查国标接入配置'
    if state.get('configured') is False and state.get('state') == 'waiting_configuration':
        return True, '管理接口正常；等待配置国标服务'
    if state.get('configured') is not True or not isinstance(state.get('enabled'), bool):
        return False, '国标状态响应无效'
    if not state['enabled']:
        return True, '管理接口正常；国标接入已停用'
    return state.get('ready') is True, ('国标信令已就绪；收流状态见接入管理' if state.get('ready') is True
                                      else '国标服务尚未就绪，请检查接入配置')


def gb_media_health(path=Path('/etc/ainvr/gb28181-media.ini')):
    config = configparser.ConfigParser(interpolation=None)
    with path.open() as file: config.read_file(file)
    port = config.getint('http', 'port')
    if not 1 <= port <= 65535: raise ValueError('invalid media port')
    state = private_probe(f'http://127.0.0.1:{port}/index/api/getThreadsLoad', body={'secret': config.get('api', 'secret')})
    rows = state.get('data')
    healthy = state.get('code') == 0 and isinstance(rows, list) and len(rows) > 0
    return healthy, ('媒体事件循环可响应；实际收流见接入管理' if healthy else '国标媒体接口未就绪，请检查日志')


def srs_health():
    result = http_json('http://127.0.0.1:1985/api/v1/versions')
    return isinstance(result, dict) and result.get('code') == 0 and isinstance(result.get('data'), dict) and bool(result['data'].get('version'))


def frontend_health(url='http://127.0.0.1:8088/'):
    """Probe the served application shell, independently of the API upstream."""
    with build_opener(ProxyHandler({})).open(url, timeout=1.5) as response:
        html = response.read(262145)
        if len(html) > 262144:
            raise ValueError('frontend response exceeds limit')
        return (response.status == 200 and b'<div id="root"' in html
                and b'type="module"' in html and b'/assets/' in html)


def probe_failure(error, phase):
    # Do not expose URLs, response bodies, credentials or arbitrary exception text.
    cause = error.reason if isinstance(error, URLError) else error
    if isinstance(error, HTTPError): reason = f'HTTP {error.code}'
    elif isinstance(cause, (TimeoutError, socket.timeout)): reason = '响应超时'
    elif isinstance(cause, ConnectionRefusedError): reason = '连接被拒绝，服务可能正在启动或重启'
    elif isinstance(error, (ValueError, json.JSONDecodeError)): reason = '响应格式无效'
    elif isinstance(cause, OSError): reason = '连接或读取失败'
    else: reason = '采集失败（' + type(error).__name__ + '）'
    return phase + '：' + reason

def alarm_health_url(pid: int, proc=Path('/proc')) -> str:
    """Discover this unit's one loopback HTTP listener; no credentials/config read.

    TCP tables are namespace-wide, so socket inode membership is required.
    This follows central port changes without probing unrelated local listeners.
    """
    if pid <= 0: raise ValueError('No alarm process')
    base = proc / str(pid)
    sockets = set()
    for fd in list((base / 'fd').iterdir())[:4096]:
        try:
            link = os.readlink(fd)
            if re.fullmatch(r'socket:\[[0-9]+\]', link): sockets.add(link[8:-1])
        except OSError: pass
    listeners = []
    for family, address, host in [('tcp', '0100007F', '127.0.0.1'), ('tcp6', '00000000000000000000000001000000', '[::1]')]:
        try: lines = (base / 'net' / family).read_text().splitlines()[1:]
        except OSError: continue
        for line in lines[:8192]:
            fields = line.split()
            if len(fields) < 10 or fields[3] != '0A' or fields[9] not in sockets: continue
            ip, port = fields[1].split(':')
            if ip.upper() == address: listeners.append((host, int(port, 16)))
    if len(listeners) != 1: raise ValueError('Ambiguous or unavailable alarm listener')
    host, port = listeners[0]
    return f'http://{host}:{port}/readyz'


def search_service_health(state, health):
    # Public /health proves process liveness only. No secret is needed by the
    # host collector; model/index/admission readiness stays in the search BFF.
    alive = state == 'active' and isinstance(health, dict) and health.get('alive') is True
    return alive, ('进程存活；模型、索引与采集状态见智能搜索' if alive else
                   '搜索进程探测未通过，请检查日志')


def memory_bytes(text: str):
    match = re.match(r'([\d.]+)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB)', text)
    if not match: return None
    scale = {'B': 1, 'kB': 1000, 'KB': 1000, 'KiB': 1024, 'MB': 1000**2,
             'MiB': 1024**2, 'GB': 1000**3, 'GiB': 1024**3}
    return round(float(match[1]) * scale[match[2]])


def bpu_percent() -> float | None:
    """S100/S100P driver utilization, already in percent (not TOPS or FPS).

    Official interface: /sys/devices/system/bpu/ratio. Missing or invalid
    samples remain unavailable; never substitute GPU load or a fabricated zero.
    """
    try:
        raw = Path('/sys/devices/system/bpu/ratio').read_text().strip()
        if len(raw) > 128: return None
        value = float(raw)
        return value if 0 <= value <= 100 else None
    except (OSError, ValueError):
        return None


class BpuWindow:
    """10s time-weighted driver occupancy; sample independently of AI jobs.

    Missing samples/gaps stay unknown. Hold readings at most 1s and require
    80% coverage. Occupancy is not MAC saturation or an inference rate limit.
    """
    def __init__(self):
        self.samples = collections.deque(maxlen=64)
        self.lock = threading.Lock()

    def add(self, stamp, value):
        with self.lock:
            self.samples.append((stamp, value))

    def mean(self, now=None):
        now = time.monotonic() if now is None else now
        begin = now - 10.0
        with self.lock:
            points = list(self.samples)
        area = covered = 0.0
        for i, (stamp, value) in enumerate(points):
            end = points[i+1][0] if i+1 < len(points) else now
            duration = max(0.0, min(end, now, stamp+1.0)-max(stamp, begin))
            if value is None: continue
            area += value * duration
            covered += duration
        return round(area/covered, 2) if covered >= 8.0 else None

    def loop(self, stop):
        while not stop.is_set():
            self.add(time.monotonic(), bpu_percent())
            stop.wait(.5)


def ai_service_health(health: dict) -> tuple[bool, str]:
    detail = '运行通道 ' + str(health.get('channels_running', 0))
    business = health.get('business')
    if not isinstance(business, dict):
        return False, detail + ' · 归档就绪状态未知，请更新 AI 服务'
    if business.get('license_allowed') is not True:
        return False, detail + ' · 授权未生效，业务暂停'
    unavailable = business.get('archive_unavailable_channels', 0)
    enabled = business.get('archive_enabled_channels', 0)
    if unavailable:
        return False, detail + f' · {unavailable} 路识别归档不可用，请检查数据库连接和鉴权'
    if enabled:
        detail += f' · 归档连接 {business.get("archive_connected_channels", 0)}/{enabled} 正常'
    else:
        detail += ' · 识别归档未开启'
    return health.get('status') == 'ok' and business.get('ready') is True, detail


def recorder_detail(health: dict, limit: int = 160) -> str:
    """录像服务明细：状态 + 服务自报的原因/告警（如 NAS 空间不足、回收站）。"""
    kind = str(health.get('storageKind', 'unknown'))
    if health.get('storageHealthy'):
        text = f'存储 {kind} 正常'
        if health.get('warning'): text += ' · ' + str(health['warning'])
    else:
        text = f'存储 {kind} 不可用'
        if health.get('message'): text += '：' + str(health['message'])
    return text if len(text) <= limit else text[:limit - 1] + '…'


class Observer:
    def __init__(self):
        DATA.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(DATA / 'metrics.db', check_same_thread=False, timeout=2)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA max_page_count=16384')
        self.db.execute('CREATE TABLE IF NOT EXISTS samples(ts INTEGER PRIMARY KEY,payload TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS runtime(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
        self.config = dict(DEFAULTS)
        row = self.db.execute("SELECT value FROM runtime WHERE key='settings'").fetchone()
        if row:
            try: self.config.update(self.validate(json.loads(row[0])))
            except (ValueError, TypeError): pass
        self.snapshot = None
        self.previous = {}
        self.dedup = collections.OrderedDict()
        self.seen = collections.OrderedDict()
        self.since = {}
        row = self.db.execute("SELECT value FROM runtime WHERE key='log-cursors'").fetchone()
        if row:
            try: self.since = json.loads(row[0])
            except ValueError: pass
        self.last_compact = 0
        self.stop = threading.Event()
        self.bpu_sampler = BpuWindow()
        self.bpu_thread = threading.Thread(target=self.bpu_sampler.loop, args=(self.stop,),
                                           name='bpu-observer', daemon=True)
        self.bpu_thread.start()
        self.thread = threading.Thread(target=self.loop, name='host-observer', daemon=True)
        self.thread.start()

    @staticmethod
    def validate(config):
        if not isinstance(config, dict) or set(config) != set(DEFAULTS): raise ValueError('invalid settings')
        for name, low, high in [('fileMiB', 1, 50), ('files', 1, 5), ('historyHours', 1, 168), ('repeatSeconds', 10, 300)]:
            if type(config[name]) is not int or not low <= config[name] <= high: raise ValueError(name)
        if config['level'] not in LEVELS: raise ValueError('level')
        return config

    def configure(self, config):
        config = self.validate(config)
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO runtime VALUES('settings',?)", (json.dumps(config),))
            self.db.commit()
            self.config = dict(config)
            # Apply retention immediately; only this collector's derived archives are affected.
            self.db.execute('DELETE FROM samples WHERE ts < ?', (int(time.time()*1000) - config['historyHours']*3600000,))
            self.db.commit()
            for source in SOURCES:
                for n in range(config['files'], 6):
                    (DATA / f'{source}.{n}.jsonl').unlink(missing_ok=True)
                file = DATA / f'{source}.jsonl'
                if file.exists() and file.stat().st_size > config['fileMiB']*1024*1024:
                    self.write_event({'ts':int(time.time()*1000),'source':source,'level':'INFO','module':'archive',
                                      'category':'audit','message':'归档容量策略已调整，轮转超限文件','count':1})
        return self.config

    def append(self, source, level, message, module='', category='runtime', ts=None, count=1):
        if source not in SOURCES: return
        level = level if level in LEVELS else 'INFO'
        if category != 'audit' and LEVELS[level] < LEVELS[self.config['level']]: return
        message = redact(str(message)); module = redact(str(module))[:80]
        now = time.time()
        key = (source, level, module, message)
        with self.lock:
            if category != 'audit':
                old = self.dedup.get(key)
                if old and now - old[0] < self.config['repeatSeconds']:
                    self.dedup[key] = (old[0], old[1]+count)
                    return
                if old:
                    count += old[1]
                self.dedup[key] = (now, 0)
                self.dedup.move_to_end(key)
                if len(self.dedup) > 1024: self.dedup.popitem(last=False)
            event = {'ts': int(ts or now*1000), 'source': source, 'level': level,
                     'module': module, 'category': category, 'message': message, 'count': count}
            self.write_event(event)

    def write_event(self, event):
        source = event['source']
        data = (json.dumps(event, ensure_ascii=False)+'\n').encode()
        file = DATA / f'{source}.jsonl'
        maximum = self.config['fileMiB']*1024*1024
        if file.exists() and file.stat().st_size + len(data) > maximum:
            (DATA / f'{source}.{self.config["files"]-1}.jsonl').unlink(missing_ok=True)
            for n in range(self.config['files']-2, 0, -1):
                old = DATA / f'{source}.{n}.jsonl'
                if old.exists(): old.replace(DATA / f'{source}.{n+1}.jsonl')
            if self.config['files'] > 1: file.replace(DATA / f'{source}.1.jsonl')
            else: file.unlink()
        with file.open('ab') as f: f.write(data)

    def ingest(self, source, raw, timestamp=None):
        raw = re.sub(r'\x1b\[[0-9;]*m', '', raw)
        # Successful access polling is not an operational event.
        if re.search(r'"(?:GET|HEAD) [^"\n]+ HTTP/[\d.]+"\s+[23]\d\d\b', raw): return
        fingerprint = hashlib.sha256((source + str(timestamp) + raw).encode()).hexdigest()
        if fingerprint in self.seen: return
        self.seen[fingerprint] = True
        if len(self.seen) > 4096: self.seen.popitem(last=False)
        level, module, category, message = 'INFO', '', 'runtime', raw
        match = re.match(r'^\[[^]]+\]\[(INFO|WARN|ERROR|TRACE)\]\[\d+\]\[[^]]+\](?:\[\d+\])?\s*(.*)',raw)
        if source == 'srs' and match:
            level, message = match.groups(); module = 'srs'
            if level == 'INFO' and re.match(r'HTTP #\d+ .* GET |TCP: (?:before dispose|disposing|clear zombies)|client finished\.|Hybrid cpu=|[<>-]+ (?:PLA|CPB|HLS) time=',message): return
        match = re.match(r'^\d{4}-\d\d-\d\d [\d:.,]+ \[(\w+)\] ([\w.]+): (.*)',raw)
        if match:
            level, module, message = match.groups()
            level = {'WARNING':'WARN','CRITICAL':'ERROR'}.get(level,level)
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                message = obj.get('message', obj.get('msg', raw))
                module = obj.get('module', obj.get('logger', ''))
                level = str(obj.get('level', obj.get('s', 'INFO'))).upper()
                level = {'I':'INFO','W':'WARN','E':'ERROR','F':'ERROR','WARNING':'WARN','CRITICAL':'ERROR'}.get(level,level)
                category = obj.get('category', 'runtime')
                if source == 'mongodb' and level == 'INFO' and message in ('WiredTiger message','client metadata','Received first command on ingress connection since session start or auth handshake'): return
                if category == 'browser': source = 'frontend'
                if category == 'audit':
                    message = str(message) + ' ' + json.dumps({k:obj[k] for k in ('actor','requestId','durationMs') if k in obj},ensure_ascii=False)
                if isinstance(obj.get('diagnostic'), dict):
                    message = str(message) + ' ' + json.dumps(obj['diagnostic'],ensure_ascii=False)[:1500]
        except ValueError: pass
        if re.search(r'(?i)\b(error|fatal|exception|traceback|out of memory|oom|segfault)\b|错误|失败', str(message)): level = 'ERROR'
        elif re.search(r'(?i)\b(warn|warning|timeout|disconnect)\b|超时|重连|中断', str(message)): level = 'WARN'
        try: count=max(1,min(100000,int(obj.get('count',1)))) if 'obj' in locals() and isinstance(obj,dict) else 1
        except (ValueError,TypeError): count=1
        self.append(source, level, message, module, category, timestamp,count=count)

    def logs(self, source='', level='', query='', start=0, end=0, limit=200, cursor=''):
        """Resume by inode + byte offset, including empty filtered scan windows.

        Paths are always constructed from the fixed source allowlist; cursor data
        never supplies a pathname. Rotation preserves inode identity until expiry.
        """
        if source and source not in SOURCES: raise ValueError('source')
        if level and level not in LEVELS: raise ValueError('level')
        positions = None
        if cursor:
            try:
                if len(cursor) > 16000: raise ValueError('cursor')
                positions = json.loads(base64.urlsafe_b64decode(cursor.encode()))
                if not isinstance(positions,dict) or len(positions)>45: raise ValueError('cursor')
                if any(not isinstance(k,str) or type(v) is not int or v<0 for k,v in positions.items()): raise ValueError('cursor')
            except Exception as e: raise ValueError('invalid cursor') from e
        files, offsets, heap, result, buffers = {}, {}, [], [], {}
        scanned, expired = 0, False
        deadline = time.monotonic()+2
        with self.lock:
            try:
                for name in ([source] if source else SOURCES):
                    for n in range(self.config['files']):
                        path = DATA / (f'{name}.{n}.jsonl' if n else f'{name}.jsonl')
                        if not path.exists(): continue
                        stat = path.stat(); key = f'{name}:{stat.st_ino}'
                        if positions is not None and key not in positions: continue
                        offsets[key] = min(stat.st_size, positions[key] if positions is not None else stat.st_size)
                        files[key] = path.open('rb')
                expired = positions is not None and any(v and k not in files for k,v in positions.items())

                def candidate(key):
                    nonlocal scanned
                    f = files[key]
                    while offsets[key] and scanned < 12*1024*1024 and time.monotonic()<deadline:
                        position = offsets[key]
                        # Events are capped at 4096 characters (~24 KiB with JSON escaping).
                        cached = buffers.get(key)
                        if cached and cached[0]<position<=cached[0]+len(cached[1]) and (cached[0]==0 or b'\n' in cached[1][:position-cached[0]].rstrip(b'\n')):
                            begin=cached[0]; block=cached[1][:position-begin]
                        else:
                            begin = max(0,position-65536); f.seek(begin)
                            block = f.read(position-begin); scanned += len(block)
                            buffers[key]=(begin,block)
                        trimmed = block.rstrip(b'\n'); boundary = trimmed.rfind(b'\n')
                        if boundary<0 and begin:
                            offsets[key]=begin; continue  # malformed oversized source record
                        previous = begin+boundary+1
                        try: row=json.loads(trimmed[boundary+1:])
                        except ValueError: offsets[key]=previous; continue
                        match = not ((start and row['ts']<start) or (end and row['ts']>=end)
                                     or (level and row['level']!=level)
                                     or (query and query.casefold() not in (row['message']+' '+row.get('module','')).casefold()))
                        if match:
                            heapq.heappush(heap,(-row['ts'],key,previous,row)); return
                        offsets[key]=previous

                for key in files: candidate(key)
                while heap and len(result)<limit:
                    _,key,previous,row=heapq.heappop(heap)
                    offsets[key]=previous; result.append(row); candidate(key)
                # Unconsumed heap candidates retain their original offsets.
                remaining = any(offsets.values())
                next_cursor=base64.urlsafe_b64encode(json.dumps(offsets,separators=(',',':')).encode()).decode() if remaining else None
                return {'items':result,'truncated':remaining,'nextCursor':next_cursor,
                        'cursorExpired':expired,'nextBefore':None}
            finally:
                for f in files.values(): f.close()

    def history(self, hours):
        with self.lock:
            rows = self.db.execute('SELECT ts,payload FROM samples WHERE ts>=? ORDER BY ts',
                                   (int(time.time()*1000)-hours*3600000,)).fetchall()
        # Fixed time buckets, not a browser-only history. Preserve gaps as absent points.
        step = max(1, (len(rows)+719)//720)
        return [json.loads(payload) for _,payload in rows[::step]]

    def cpu(self, key, total, now):
        previous = self.previous.get(key); self.previous[key] = (total, now)
        if previous is None or total < previous[0] or now <= previous[1]: return None
        return round(100*(total-previous[0])/(now-previous[1]),2)

    def host(self):
        now = time.monotonic(); ticks = os.sysconf('SC_CLK_TCK')
        cpu = [int(x) for x in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
        previous = self.previous.get('host'); self.previous['host'] = cpu
        percent = None
        if previous:
            delta = sum(cpu)-sum(previous)
            if delta > 0: percent = round(100*(1-((cpu[3]+cpu[4])-(previous[3]+previous[4]))/delta),2)
        mem = {line.split(':')[0]:int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines()}
        gpu = None
        try: gpu = int(Path('/sys/devices/platform/17000000.gpu/load').read_text())/10
        except (OSError,ValueError): pass
        host = {'cpuPercent':percent,'memoryBytes':mem['MemTotal']-mem['MemAvailable'],
                'memoryTotalBytes':mem['MemTotal'],'gpuPercent':gpu,'bpuPercent':self.bpu_sampler.mean(),'cores':os.cpu_count(),
                'swapBytes':mem['SwapTotal']-mem['SwapFree']}
        disk = shutil.disk_usage(ROOT)
        host.update(diskUsedBytes=disk.used, diskTotalBytes=disk.total)
        network = []
        for line in Path('/proc/net/dev').read_text().splitlines()[2:]:
            name, values = line.split(':', 1); name = name.strip(); values = values.split()
            # Physical interfaces only: no duplicate Docker/veth/bridge traffic.
            if not (Path('/sys/class/net') / name / 'device').exists(): continue
            try:
                if (Path('/sys/class/net')/name/'type').read_text().strip() != '1': continue
                if (Path('/sys/class/net')/name/'operstate').read_text().strip() not in ('up','unknown'): continue
            except OSError: continue
            rx, tx = int(values[0]), int(values[8])
            key = 'net:' + name; old = self.previous.get(key); self.previous[key] = (rx, tx, now)
            elapsed = now-old[2] if old else 0
            valid = old is not None and elapsed > 0 and rx >= old[0] and tx >= old[1]
            network.append({'name': name, 'rxBytesPerSecond': (rx-old[0])/elapsed if valid else None,
                            'txBytesPerSecond': (tx-old[1])/elapsed if valid else None})
        host['network'] = network
        temperatures=[]
        for zone in Path('/sys/class/thermal').glob('thermal_zone*'):
            try: temperatures.append({'name':(zone/'type').read_text().strip(),'celsius':int((zone/'temp').read_text())/1000})
            except (OSError,ValueError): pass
        host['temperatureC'] = max((v['celsius'] for v in temperatures), default=None)
        services=[]
        for source,unit in deployment_units().items():
            row={'id':source,'state':'unknown','cpuPercent':None,'memoryBytes':None,'connections':None}
            phase = '进程状态采集'
            try:
                props=dict(line.split('=',1) for line in run(['systemctl','show',unit,'--property=MainPID,ActiveState,NRestarts,Result']).splitlines() if '=' in line)
                row.update(state=props.get('ActiveState','unknown'),restarts=int(props.get('NRestarts',0)),detail=props.get('Result',''))
                pid=int(props.get('MainPID',0))
                # Aggregate the whole process tree (recorder includes ffmpeg children).
                table={}
                for p in Path('/proc').iterdir():
                    if not p.name.isdigit(): continue
                    try:
                        values=(p/'stat').read_text().rsplit(')',1)[1].split()
                        table[int(p.name)]=(int(values[1]),(int(values[11])+int(values[12]))/ticks,int(values[21])*os.sysconf('SC_PAGE_SIZE'))
                    except (OSError,ValueError,IndexError): pass
                members={pid} if pid else set()
                for _ in range(8):
                    children={p for p,(parent,_,_) in table.items() if parent in members}
                    if children <= members: break
                    members |= children
                usage=[table[p] for p in members if p in table]
                if usage:
                    row['cpuPercent']=self.cpu(source,sum(x[1] for x in usage),now)
                    row['memoryBytes']=sum(x[2] for x in usage)
                if source in ('onvif', 'gb28181', 'gb-media'):
                    phase = 'ONVIF 业务接口探测' if source == 'onvif' else '国标业务接口探测'
                    if row['state'] == 'active' and pid > 0:
                        row['healthy'], row['detail'] = onvif_health() if source == 'onvif' else gateway_health() if source == 'gb28181' else gb_media_health()
                    else:
                        row['healthy'], row['detail'] = False, '进程未运行，请检查日志'
                    services.append(row)
                    continue
                phase = 'HTTP 服务探测'
                if source == 'frontend':
                    row['healthy'] = row['state'] == 'active' and frontend_health()
                    row['detail'] = '页面可访问；接口服务单独检测' if row['healthy'] else '前端页面不可用或构建文件不完整'
                    services.append(row)
                    continue
                url = alarm_health_url(pid) if source == 'alarm-service' else {'ai-service': 'http://127.0.0.1:8000/health',
                       'llm-service': 'http://127.0.0.1:8300/health',
                       'search-service': 'http://127.0.0.1:8400/health',
                       'recorder': 'http://127.0.0.1:8100/v1/recorder/health',
                       'backend': 'http://127.0.0.1:3001/api/branding',
                       'frontend': 'http://127.0.0.1:8088/api/branding'}[source]
                health=http_json(url)
                if source == 'ai-service':
                    row['healthy'], row['detail'] = ai_service_health(health)
                elif source == 'alarm-service':
                    row['healthy'] = row['state'] == 'active' and health.get('ready') is True
                    row['detail'] = '服务就绪；消费、存储与规则状态见告警监视' if row['healthy'] else '告警服务未就绪，请检查告警监视和日志'
                elif source == 'llm-service':
                    row['healthy'], row['detail'] = llm_service_health(row['state'], health)
                elif source == 'search-service':
                    row['healthy'], row['detail'] = search_service_health(row['state'], health)
                elif source == 'recorder':
                    row['healthy'] = health.get('ok') is True and health.get('storageHealthy') is True
                    row['detail'] = recorder_detail(health)
                else:
                    row['healthy'] = row['state'] == 'active' and bool(health)
            except Exception as error:
                row['healthy']=False
                row['detail']=probe_failure(error, phase)
            services.append(row)
        return host,services

    def containers(self):
        project = 'ainvr-infra' if os.environ.get('AINVR_DEPLOYMENT_MODE') == 'native' else 'srs-web-console'
        ids=run(['docker','ps','-aq','--filter','label=com.docker.compose.project='+project]).split()
        try: ids += run(['docker','ps','-aq','--filter','name=^/ainvr-mongo$']).split()
        except RuntimeError: pass
        ids=list(dict.fromkeys(ids))
        details=json.loads(run(['docker','inspect',*ids],limit=1024*1024)) if ids else []
        chosen={}
        for d in details:
            service=d.get('Config',{}).get('Labels',{}).get('com.docker.compose.service')
            source=next((k for k,v in deployment_containers().items() if v==service),None)
            if d.get('Name')=='/ainvr-mongo': source='mongodb'
            if source and (source not in chosen or d['State']['Running']): chosen[source]=d
        stats={}
        if chosen:
            for line in run(['docker','stats','--no-stream','--format','{{json .}}',*[d['Id'] for d in chosen.values()]],timeout=5).splitlines():
                obj=json.loads(line);stats[obj['ID']]=obj
        rows=[]
        for source in [*deployment_containers(),'mongodb']:
            d=chosen.get(source)
            row={'id':source,'state':'missing','cpuPercent':None,'memoryBytes':None,'connections':None,'healthy':False}
            if d:
                state=d['State'];s=next((v for k,v in stats.items() if d['Id'].startswith(k)),{})
                row.update(state='active' if state['Running'] else state['Status'],healthy=state['Running'] and state.get('Health',{}).get('Status','healthy')=='healthy',
                           cpuPercent=float(s['CPUPerc'].rstrip('%')) if s.get('CPUPerc') else None,
                           memoryBytes=memory_bytes(s.get('MemUsage','').split('/')[0].strip()),
                           restarts=d.get('RestartCount',0),oomKilled=state.get('OOMKilled',False),
                           detail='OOM 终止' if state.get('OOMKilled') else state.get('Error',''),
                           logPolicy=d.get('HostConfig',{}).get('LogConfig',{}).get('Config',{}))
                if source == 'srs' and row['healthy']:
                    try:
                        row['healthy'] = srs_health()
                        row['detail'] = 'SRS 管理接口可响应；视频源状态见接入管理' if row['healthy'] else 'SRS 管理接口响应无效'
                    except Exception as error:
                        row['healthy'] = False
                        row['detail'] = probe_failure(error, 'SRS 接口探测')
            rows.append(row)
        return rows,chosen

    def collect_logs(self, chosen):
        now=time.time()
        targets={**{k:('unit',v) for k,v in deployment_units().items()},'helper':('unit','ainvr-restart-helper.service'),
                 **{k:('docker',v['Id']) for k,v in chosen.items()},'host':('kernel','')}
        for source,(kind,target) in targets.items():
            since=self.since.get(source,now-60)
            try:
                if kind=='docker':
                    raw=run(['docker','logs','--timestamps','--since',str(int(since)),'--tail','200',target],merge_stderr=True)
                    lines=raw.splitlines()
                    for line in lines:
                        stamp,_,message=line.partition(' ')
                        try: ts=dt.datetime.fromisoformat(stamp[:26]+'+00:00').timestamp()*1000
                        except ValueError: ts=now*1000
                        self.ingest(source,message,ts)
                else:
                    args=['journalctl','--no-pager','-o','json','--since','@'+str(int(since)),'-n','200']
                    args+=['-k'] if kind=='kernel' else ['-u',target]
                    lines=run(args).splitlines()
                    for line in lines:
                        row=json.loads(line);message=row.get('MESSAGE','')
                        if not isinstance(message,str): continue
                        if kind=='kernel' and not re.search(r'(?i)oom|out of memory|killed process|segfault|cifs|nvrm|gpu.*error',message): continue
                        self.ingest(source,message,int(row.get('__REALTIME_TIMESTAMP',0))/1000)
                self.since[source]=now-1
                if len(lines)>=200: self.append('host','WARN',f'{source} 日志达到单次 200 行上限；详细原始日志仍由系统保存','collector')
            except Exception:
                self.append('host','WARN',f'{source} 日志采集不可用','collector')

    def loop(self):
        while not self.stop.is_set():
            started=time.monotonic()
            try:
                host,services=self.host()
                try: containers,chosen=self.containers()
                except Exception:
                    containers=[{'id':s,'state':'unknown','healthy':False,'cpuPercent':None,'memoryBytes':None,'connections':None} for s in [*deployment_containers(),'mongodb']];chosen={}
                    self.append('host','WARN','Docker 指标采集不可用','collector')
                services+=containers
                # Database commands are fixed read-only status queries, never request input.
                for source in ('postgres','mongodb'):
                    d=chosen.get(source)
                    if not d or not d['State']['Running']: continue
                    row=next(s for s in services if s['id']==source)
                    try:
                        if source=='postgres':
                            env=dict(v.split('=',1) for v in d['Config'].get('Env',[]) if '=' in v)
                            count=run(['docker','exec',d['Id'],'psql','-U',env.get('POSTGRES_USER','postgres'),'-d',env.get('POSTGRES_DB','postgres'),'-Atc','SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid()'],timeout=2)
                            row['connections']=int(count.strip())
                        else:
                            # Read established listener sockets, without database admin credentials
                            # or spawning a JS database client on every sampling tick.
                            count=run(['docker','exec',d['Id'],'awk',
                                       '$2 ~ /:6989$/ && $4 == "01" {n++} END {print n+0}',
                                       '/proc/net/tcp','/proc/net/tcp6'],timeout=2)
                            row['connections']=int(count.strip())
                            row['detail']='容器运行；TCP 连接数不代表鉴权或归档可用，请同时查看 AI 归档状态'
                    except Exception:
                        row['detail']='数据库连接指标不可用（权限或响应超时）'
                try:
                    streams=http_json('http://127.0.0.1:1985/api/v1/streams/').get('streams',[])
                    row=next(s for s in services if s['id']=='srs')
                    row['connections']=sum(s.get('clients',0) for s in streams)
                    row['detail']=f'{len(streams)} 路视频流'
                except Exception: pass
                stamp=int(time.time()*1000)
                snapshot={'ts':stamp,'host':host,'services':services,'sampleSeconds':10}
                with self.lock:
                    self.snapshot=snapshot
                    self.db.execute('DELETE FROM samples WHERE ts<?',(stamp-self.config['historyHours']*3600000,))
                    if stamp-self.last_compact>60000:
                        cutoff=stamp-3600000
                        self.db.execute('DELETE FROM samples WHERE ts<? AND ts NOT IN (SELECT MIN(ts) FROM samples WHERE ts<? GROUP BY ts/60000)',(cutoff,cutoff))
                        self.last_compact=stamp
                    self.db.execute('INSERT OR REPLACE INTO samples VALUES(?,?)',(stamp,json.dumps(snapshot,separators=(',',':'))))
                    self.db.commit()
                for s in services:
                    key='state:'+s['id'];state=(s['state'],s.get('healthy'),s.get('oomKilled'),s.get('restarts'),s.get('detail') if not s.get('healthy') else None)
                    if self.previous.get(key)!=state:
                        self.append(s['id'],'INFO' if s.get('healthy') else 'ERROR',f'服务状态 {s["state"]}；{s.get("detail","")}；重启次数 {s.get("restarts",0)}','health')
                        self.previous[key]=state
                self.collect_logs(chosen)
                with self.lock:
                    self.db.execute("INSERT OR REPLACE INTO runtime VALUES('log-cursors',?)",(json.dumps(self.since),))
                    self.db.commit()
                    for key,(when,count) in list(self.dedup.items()):
                        if count and time.time()-when>=self.config['repeatSeconds']:
                            source,level,module,message=key
                            self.write_event({'ts':int(time.time()*1000),'source':source,'level':level,'module':module,'category':'runtime','message':message,'count':count})
                            self.dedup[key]=(time.time(),0)
            except Exception as e:
                try:
                    with self.lock: self.db.rollback()
                    self.append('host','ERROR','采集循环失败: '+type(e).__name__,'collector')
                except Exception: pass
            self.stop.wait(max(1,10-(time.monotonic()-started)))


def llm_service_health(state, health):
    """A listening process is not enough: the model must actually be ready."""
    ready = state == 'active' and health.get('ready') is True and health.get('model') == 'ready'
    details = {'loading': '模型加载中', 'unloaded': '模型未加载',
               'fault': '模型未就绪，请查看服务监视和日志',
               'ion_insufficient': '专用内存不足，模型未加载',
               'verify_failed': '模型文件校验失败'}
    return ready, '模型就绪；提供图片复审接口' if ready else details.get(health.get('model'), '大模型服务未就绪')
