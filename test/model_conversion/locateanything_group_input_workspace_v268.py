"""Request-scoped synchronous input workspace; no neural computation.

Returned KV input arrays are borrowed until the next prepare/close. A checked,
synchronous executor must finish using them before either operation. Allocate
one workspace per decoder group per request and close in a finally block;
generation state must never be retained across requests. Not production-admitted.
"""
from pathlib import Path
import hashlib
import threading
import numpy as np

SOURCE = Path('/home/sunrise/ainvr/test/model_conversion/locateanything_official_group_routing_v1.py')
SOURCE_SHA = '351821138e32feab01b866fb487328ca5d65345bc10cd8d1166ae7e691ad0694'


class GroupInputWorkspace:
    def __init__(self):
        assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == SOURCE_SHA
        self.owner = threading.get_ident()
        self.buffers = [np.zeros((2, 512, 128), np.float32) for _ in range(18)]
        self.last_past = None
        self.closed = False
        self.calls = 0
        self.resets = 0

    def _owned(self):
        assert not self.closed and self.owner == threading.get_ident()

    def _clear(self):
        for value in self.buffers:
            value.fill(0)
        self.last_past = None
        self.resets += 1

    def prepare(self, hidden, caches, layout, length, rope):
        self._owned()
        q, p = layout.query_length, layout.past_length
        assert length in [1, 256] and 0 < q <= length and p + length <= 512 and len(caches) == 9
        assert p >= 0
        # Reject borrowing our previous input as a cache before clearing it.
        for pair in caches:
            if pair is not None:
                for value in pair:
                    assert isinstance(value, np.ndarray)
                    assert not any(np.shares_memory(value, buf) for buf in self.buffers)
        if self.last_past is not None and p <= self.last_past:
            self._clear()
        try:
            result = self._prepare(hidden, caches, layout, length, rope)
        except BaseException:
            self._clear()
            raise
        self.last_past = p
        self.calls += 1
        return result

    def _prepare(self, hidden, caches, layout, length, rope):
        q, p = layout.query_length, layout.past_length
        assert hidden.shape == (q, 2048) and hidden.dtype == np.float32 and np.isfinite(hidden).all()
        assert layout.visibility.shape == (q, p + q) and layout.visibility.dtype == np.bool_
        h = np.zeros((length, 2048), np.float32)
        h[:q] = hidden
        cos, sin = rope.padded(layout.positions, length)
        assert cos.shape == sin.shape == (1, length, 128) and cos.dtype == sin.dtype == np.float32
        mask = np.full((length, 512), -512., np.float32)
        mask[:q, 512-length-p:512-length] = np.where(layout.visibility[:, :p], 0., -512.)
        mask[:q, 512-length:512-length+q] = np.where(layout.visibility[:, p:], 0., -512.)
        if q < length:
            mask[q:, 512-length] = 0.
        result = [h, np.ascontiguousarray(cos[0]), np.ascontiguousarray(sin[0]), mask]
        index = 0
        for pair in caches:
            if pair is None:
                assert p == 0
                pair = (np.empty((2, 0, 128), np.float32), np.empty((2, 0, 128), np.float32))
            assert len(pair) == 2
            for value in pair:
                assert value.shape == (2, p, 128) and value.dtype == np.float32 and np.isfinite(value).all()
                padded = self.buffers[index]
                index += 1
                if p:
                    padded[:, 512-p:] = value
                result.append(padded)
        assert len(result) == 22 and all(x.flags.c_contiguous and np.isfinite(x).all() for x in result)
        return result

    def close(self):
        self._owned()
        self._clear()
        assert all(not np.any(x) for x in self.buffers)
        self.closed = True
