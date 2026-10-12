"""Event-loop-owned read leases and delete reservations for quota eviction."""
import time
from contextlib import contextmanager


class PlaybackProtection:
    def __init__(self, ttl: float = 120):
        self.ttl = ttl
        self._until: dict[str, float] = {}
        self._readers: dict[str, int] = {}
        self._deleting: set[str] = set()

    def touch(self, segment_id: str) -> bool:
        now = time.monotonic()
        self._until = {key: expiry for key, expiry in self._until.items()
                       if expiry > now or self._readers.get(key, 0)}
        if segment_id in self._deleting:
            return False
        self._until[segment_id] = now + self.ttl
        return True

    @contextmanager
    def reader(self, segment_id: str):
        self._readers[segment_id] = self._readers.get(segment_id, 0) + 1
        try:
            yield
        finally:
            self._readers[segment_id] -= 1
            if not self._readers[segment_id]:
                del self._readers[segment_id]
            self._until[segment_id] = time.monotonic() + self.ttl

    def begin_delete(self, segment_id: str) -> bool:
        if self._readers.get(segment_id, 0) or self._until.get(segment_id, 0) > time.monotonic():
            return False
        self._until.pop(segment_id, None)
        self._deleting.add(segment_id)
        return True

    def end_delete(self, segment_id: str) -> None:
        self._deleting.discard(segment_id)
