"""Bounded subprocess media reads, single HTTP ranges and cancellation fencing."""
from __future__ import annotations

import os
import errno
import asyncio
import anyio
import stat
import json
import sys
from pathlib import Path
from urllib.parse import quote
from contextlib import nullcontext

from fastapi import HTTPException
from fastapi.responses import Response, JSONResponse

from .index import SegmentIndex
from .storage import StorageManager
from .storage_io import StorageIOError
from .playback_protection import PlaybackProtection


class LimitedFileResponse(Response):
    """No shared threads. Bound active reads and unkillable orphan processes.

    Kernel D-state cannot be forcibly terminated; at most eight orphan readers
    may remain in addition to active permits. Exhaustion returns a recoverable
    503 instead of creating unbounded workers or locking the management API.
    """
    _orphans: set = set()
    read_timeout = 8.0

    def __init__(self, path, *, semaphore: asyncio.Semaphore,
                 protection: PlaybackProtection | None = None, segment_id: str = '',
                 storage: StorageManager | None = None, media_type='video/mp4',
                 filename=None, headers=None, index: SegmentIndex | None = None,
                 license_check=None):
        super().__init__(content=b'', media_type=media_type, headers=headers)
        self.path = str(path)
        self.license_check = license_check
        self.storage = storage
        self.generation = storage.io.generation if storage else None
        del self.headers['content-length']
        self.headers['accept-ranges'] = 'bytes'
        self.headers['cache-control'] = 'no-store'
        if filename:
            self.headers['content-disposition'] = "attachment; filename*=UTF-8''" + quote(filename)
        self.semaphore = semaphore
        self.protection = protection
        self.segment_id = segment_id
        self.index = index

    async def __call__(self, scope, receive, send):
        if self.license_check and not self.license_check():
            await JSONResponse({'code': 'LICENSE_REQUIRED'}, status_code=403)(scope, receive, send)
            return
        self._orphans.difference_update(p for p in list(self._orphans) if p.returncode is not None)
        if self.semaphore.locked() or len(self._orphans) >= 8:
            await JSONResponse({"detail": "录像媒体并发已满，请稍后再试"},
                               status_code=503)(scope, receive, send)
            return
        async with self.semaphore:
            async with anyio.create_task_group() as tasks:
                async def stream():
                    try:
                        lease = self.protection.reader(self.segment_id) if self.protection else nullcontext()
                        with lease:
                            await self._stream(scope, send)
                    finally:
                        tasks.cancel_scope.cancel()
                tasks.start_soon(stream)
                while True:
                    message = await receive()
                    if message['type'] == 'http.disconnect':
                        tasks.cancel_scope.cancel()
                        break

    async def _stream(self, scope, send):
        proc = None
        started = False
        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable, str(Path(__file__).with_name('media_worker.py')), self.path,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL)
            header = await asyncio.wait_for(proc.stdout.readline(), self.read_timeout)
            info = json.loads(header)
            if 'error' in info:
                code = info['error']
                same_storage = self.storage is None or self.storage.io.generation == self.generation
                if code == errno.ENOENT and same_storage:
                    if self.index is not None:
                        (await self.index.run(self.index.delete, self.segment_id))
                    await JSONResponse({'detail': '录像文件已被删除或循环覆盖，列表已更新'}, status_code=410)(scope, None, send)
                    return
                if code in {errno.EIO, errno.ETIMEDOUT, errno.EHOSTDOWN, errno.ENETDOWN, errno.ENETUNREACH} and same_storage and self.storage:
                    self.storage.io.trip('media-read', 'NAS 返回存储或网络读取错误')
                raise OSError('media worker could not open file')
            size = info['size']
            first, last, status = 0, size - 1, 200
            headers = dict(scope.get('headers', []))
            raw = headers.get(b'range', b'').decode('latin1')
            # Unsupported multi-range and If-Range safely fall back to full 200.
            if raw and ',' not in raw and b'if-range' not in headers:
                try:
                    if not raw.startswith('bytes='):
                        raise ValueError()
                    left, right = raw[6:].split('-', 1)
                    if left:
                        first = int(left)
                        last = min(int(right), size - 1) if right else size - 1
                    else:
                        suffix = int(right)
                        if suffix <= 0:
                            raise ValueError()
                        first = max(0, size - suffix)
                    if first < 0 or first >= size or last < first:
                        raise ValueError()
                    status = 206
                except ValueError:
                    await Response(status_code=416, headers={'Content-Range': f'bytes */{size}'})(scope, None, send)
                    return
            length = max(0, last - first + 1)
            proc.stdin.write(json.dumps([first, length]).encode() + b'\n')
            await proc.stdin.drain()
            # Read first bytes before sending headers so an initial read timeout
            # can still become a meaningful 503, rather than an empty 200.
            chunk = await asyncio.wait_for(proc.stdout.read(min(256 * 1024, length)), self.read_timeout) if length else b''
            if self.storage and self.storage.io.generation != self.generation:
                raise OSError('storage changed')
            self.headers['content-length'] = str(length)
            if status == 206:
                self.headers['content-range'] = f'bytes {first}-{last}/{size}'
            await send({'type': 'http.response.start', 'status': status, 'headers': self.raw_headers})
            started = True
            if scope.get('method') == 'HEAD':
                await send({'type': 'http.response.body', 'body': b''})
                return
            while length:
                if self.license_check and not self.license_check():
                    raise OSError('license lease expired')
                if not chunk:
                    raise OSError('file shortened during playback')
                length -= len(chunk)
                await send({'type': 'http.response.body', 'body': chunk, 'more_body': length > 0})
                if length:
                    chunk = await asyncio.wait_for(proc.stdout.read(min(256 * 1024, length)), self.read_timeout)
                    if self.storage and self.storage.io.generation != self.generation:
                        raise OSError('storage changed')
            if size == 0:
                await send({'type': 'http.response.body', 'body': b''})
        except (asyncio.TimeoutError, OSError, ValueError, KeyError) as error:
            # EOF, invalid worker output and a truncated/deleted file are local
            # to this request. Only a genuine read timeout trips the whole NAS.
            if isinstance(error, asyncio.TimeoutError) and self.storage and self.storage.io.generation == self.generation:
                self.storage.io.trip('media-read', '媒体读取超时，等待存储恢复')
            if not started:
                await JSONResponse({'detail': '录像存储读取失败或超时，请稍后重试'}, status_code=503)(scope, None, send)
            else:
                # An incomplete Content-Length closes the response as an error;
                # never pretend a truncated video is a successful whole file.
                raise OSError('recording stream interrupted') from None
        finally:
            if proc:
                if proc.returncode is None:
                    try: proc.kill()
                    except ProcessLookupError: pass
                with anyio.CancelScope(shield=True):
                    try: await asyncio.wait_for(proc.communicate(), 0.5)
                    except asyncio.TimeoutError: self._orphans.add(proc)


async def resolve_segment_file(seg_id: str, index: SegmentIndex,
                               storage_mgr: StorageManager,
                               protection: PlaybackProtection | None = None) -> tuple[dict, str]:
    seg = (await index.run(index.get, seg_id))
    if seg is None:
        raise HTTPException(status_code=404, detail="录像不存在或已被清理")
    if seg["storage"] != storage_mgr.current_status().kind:
        raise HTTPException(status_code=410, detail="录像位于当前未启用的存储")
    if seg.get('storageId', '') != storage_mgr.current_status().storage_id:
        raise HTTPException(status_code=410, detail="录像属于其他存储目录，请切换回原存储后查看")
    if protection and not protection.touch(seg_id):
        raise HTTPException(status_code=410, detail="录像正在循环覆盖，请选择其他片段")
    try:
        root = storage_mgr.media_root()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"存储不可用：{e}")
    # rel_path 形如 20260914/xxx.mp4，严格限定在根目录内
    abs_path = os.path.normpath(os.path.join(root, seg["relPath"]))
    if os.path.commonpath([abs_path, root]) != root:
        raise HTTPException(status_code=400, detail="非法路径")
    try:
        file_stat = await storage_mgr.io.run(
            os.stat, abs_path, timeout=8, op="play-stat")
        exists = stat.S_ISREG(file_stat.st_mode)
    except FileNotFoundError:
        # A confirmed missing file is different from an inaccessible NAS. Remove
        # only this stale index entry; never purge an index on an I/O timeout.
        (await index.run(index.delete, seg_id))
        raise HTTPException(status_code=410, detail="录像文件已被删除或循环覆盖，列表已更新")
    except OSError:
        raise HTTPException(status_code=503, detail="存储读取失败，请检查 NAS 状态后重试")
    except StorageIOError as e:
        # 超时/熔断：明确告诉前端"存储正忙/恢复中"，别挂着连接等
        raise HTTPException(
            status_code=503,
            detail=f"存储暂时无响应（录像文件可达性检查超时），请稍后重试：{e}")
    if not exists:
        raise HTTPException(status_code=410, detail="录像文件已不存在（可能在对端存储上不可达）")
    return seg, abs_path
