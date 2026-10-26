"""Bounded connection work: one slow camera never blocks stream supervision."""
from concurrent.futures import ThreadPoolExecutor
import threading
import time


class ConnectionCapacity(RuntimeError):
    """The bounded connector queue is full; this is waiting, not camera failure."""


class DeferredProcess:
    def __init__(self, future):
        self.future = future
        self.started = time.monotonic()
        self._stopped = False
        self._lock = threading.Lock()
        future.add_done_callback(self._completed)

    def _completed(self, future):
        with self._lock:
            if self._stopped and not future.cancelled() and future.exception() is None:
                future.result().stop()

    def _process(self):
        if not self.future.done() or self.future.cancelled() or self.future.exception() is not None:
            return None
        return self.future.result()

    @property
    def frames(self):
        process = self._process()
        return process.frames if process else 0

    @property
    def last_video(self):
        process = self._process()
        return process.last_video if process else time.monotonic()

    @property
    def error_code(self):
        if self.future.done() and not self.future.cancelled() and self.future.exception() is not None:
            return getattr(self.future.exception(), 'code', 'source_unavailable')
        return getattr(self._process(), 'error_code', None)

    @property
    def audio_warning(self):
        return getattr(self._process(), 'audio_warning', None)

    @property
    def audio_codec(self):
        return getattr(self._process(), 'audio_codec', None)

    def poll(self):
        if self._stopped or self.future.cancelled():
            return 1
        process = self._process()
        if process:
            return process.poll()
        return 1 if self.future.done() else None

    def stop(self):
        with self._lock:
            if self._stopped:
                return
            self._stopped = True
            process = self._process()
            if process:
                process.stop()
        self.future.cancel()


class AsyncLauncher:
    def __init__(self, factory, workers=2, capacity=4):
        self.factory = factory
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix='camera-connect')
        self.slots = threading.BoundedSemaphore(capacity)

    def launch(self, config):
        if not self.slots.acquire(blocking=False):
            raise ConnectionCapacity('connection capacity exceeded')
        try:
            future = self.pool.submit(self.factory, config)
            future.add_done_callback(lambda _: self.slots.release())
            return DeferredProcess(future)
        except BaseException:
            self.slots.release()
            raise

    def close(self):
        self.pool.shutdown(wait=True, cancel_futures=True)
