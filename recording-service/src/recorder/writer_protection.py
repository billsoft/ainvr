"""Event-loop-owned file leases, including writers draining after segment rotation.

No filesystem lookup here: querying a slow NAS must not block the event loop.
"""
import os

_writers: dict[str, set[object]] = {}


def acquire(path: str) -> object:
    token = object()
    _writers.setdefault(os.path.abspath(path), set()).add(token)
    return token


def release(path: str, token: object) -> None:
    key = os.path.abspath(path)
    owners = _writers.get(key)
    if owners is not None:
        owners.discard(token)
        if not owners:
            del _writers[key]


def is_writing(path: str) -> bool:
    return bool(_writers.get(os.path.abspath(path)))
