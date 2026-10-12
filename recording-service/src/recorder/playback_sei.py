"""Bounded, isolated SEI reads; never run disk scanning on the HTTP event loop."""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from collections import OrderedDict

from fastapi import HTTPException

log = logging.getLogger(__name__)


class PlaybackSeiReader:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.proc = None
        self.cache = OrderedDict()

    async def read(self, path: str, key: tuple, start_ms: int):
        key = (*key, start_ms)
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        # A timed-out NAS process can remain in D state. Keep its slot occupied
        # until the child watcher confirms exit; repeated requests cannot leak workers.
        if self.lock.locked() or (self.proc and self.proc.returncode is None):
            raise HTTPException(503, '识别框读取正忙，请稍后重试')
        async with self.lock:
            proc = None
            try:
                proc = await asyncio.create_subprocess_exec(
                    sys.executable, '-m', 'recorder.sei_worker', '--frames', path,
                    str(start_ms), str(start_ms + 10000),
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                self.proc = proc
                output, _ = await asyncio.wait_for(proc.communicate(), 5)
                if proc.returncode or len(output) > 2 * 1024 * 1024:
                    raise ValueError('Invalid metadata worker result')
                result = json.loads(output)
                self.cache[key] = result
                while len(self.cache) > 8:
                    self.cache.popitem(last=False)
                return result
            except (OSError, ValueError, asyncio.TimeoutError) as error:
                log.warning('playback_sei_read_failed segment=%s error=%s', key[0], type(error).__name__)
                raise HTTPException(503, '识别框读取失败或超时，录像可继续播放') from None
            finally:
                if proc and proc.returncode is None:
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                    # No unbounded wait for a kernel-blocked disk operation.

