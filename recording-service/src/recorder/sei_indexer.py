"""Low-priority SEI backfill; at most one process group, even on a stuck NAS."""
from __future__ import annotations
import asyncio
import json
import os
import signal
import sys
import time
from .logging_setup import get_logger

log = get_logger('recorder.sei')


class SeiIndexer:
    def __init__(self, index, storage, channel_kind=None):
        self.index, self.storage = index, storage
        # channelId → 'ai' / 'source' / None(未知)。原始流通道的录像不可能带识别信息，
        # 不必回读——8K 高码率下整段回读每分钟上 GB，会挤占相机推流的网络。
        self.channel_kind = channel_kind
        self.group = None
        self.retry = {}

    def group_alive(self):
        if self.group is None: return False
        try: os.killpg(self.group, 0); return True
        except ProcessLookupError:
            self.group = None
            return False

    def kill_group(self):
        if self.group is not None:
            try: os.killpg(self.group, signal.SIGKILL)
            except ProcessLookupError: self.group = None

    async def scan_one(self):
        if self.group_alive() or not self.storage.current_status().healthy: return
        now = time.monotonic()
        self.retry = {key: until for key, until in self.retry.items() if until > now}
        # 之前因"判为普通源"而跳过的录像，如果这个通道现在确认是 AI 输出：重新排队扫描。
        # 跳过原因持久记录在索引库里（sei_reason），所以录像服务重启后依然有效；
        # 这些录像已不在"待索引"里，所以独立于待索引列表去检查。便宜的一条 UPDATE，没有可纠正的就是 0 行。
        if self.channel_kind is not None:
            for cid in (await self.index.run(self.index.channels_skipped_as_source, )):
                if self.channel_kind(cid) == 'ai':
                    (await self.index.run(self.index.reset_sei_skipped_as_source, cid))
        row = None
        for r in (await self.index.run(self.index.pending_sei, )):
            if r['id'] in self.retry: continue
            kind = self.channel_kind(r['channelId']) if self.channel_kind is not None else None
            if kind == 'source':
                (await self.index.run(self.index.skip_sei_as_source, r))
            elif row is None:
                row = r
        if not row: return
        generation = self.storage.io.generation
        scope = self.index.active_storage_id
        root = self.storage.media_root()
        path = os.path.normpath(os.path.join(root, row['relPath']))
        if os.path.commonpath([root, path]) != root: return
        proc = await asyncio.create_subprocess_exec(sys.executable, '-m', 'recorder.sei_worker', path,
            str(row['durationMs']), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True)
        self.group = proc.pid
        try:
            output, _ = await asyncio.wait_for(proc.communicate(), 30)
            if proc.returncode: raise ValueError('SEI probe failed')
            ranges = json.loads(output)
            if generation == self.storage.io.generation and scope == self.index.active_storage_id:
                (await self.index.run(self.index.set_sei_ranges, row, ranges))
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.retry[row['id']] = time.monotonic() + 120
            log.warning('SEI indexing deferred for %s: %s', row['id'], type(error).__name__)
        finally:
            self.kill_group()
            # Never wait indefinitely for a CIFS D-state process. group_alive()
            # prevents spawning replacements until this exact group has gone.

    async def run_forever(self):
        try:
            while True:
                await self.scan_one()
                await asyncio.sleep(2)
        finally:
            self.kill_group()
