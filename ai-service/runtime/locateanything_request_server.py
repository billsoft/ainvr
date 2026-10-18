"""Bounded control connections with exactly one complete-model generation.

This module does no inference. The unchanged backend owns every SDK model and
releases it when a generation completes or observes cooperative cancellation.
"""
import math
import os
import socket
import struct
import threading


class SerialGenerationBackend:
    def __init__(self, backend, stopping, on_stall=None, grace_seconds=5):
        self._backend = backend
        self._stopping = stopping
        self._generation = threading.Lock()
        bound = backend.maximum_seconds
        if (isinstance(bound, bool) or not isinstance(bound, (int, float)) or
                not math.isfinite(bound) or not 0 < bound <= 3600 or
                not math.isfinite(grace_seconds) or not 0 < grace_seconds <= 5):
            raise ValueError('Invalid generation watchdog bound')
        self._hard_seconds = bound + grace_seconds
        self._on_stall = on_stall or (lambda: os._exit(70))
        self._state_lock = threading.Lock()
        self._active = None

    def __getattr__(self, name):
        return getattr(self._backend, name)

    def health(self):
        value = dict(self._backend.health(), busy=self._generation.locked(),
                     stopping=self._stopping.is_set(),
                     process_deadline_seconds=self._hard_seconds)
        if self._stopping.is_set():
            value['ready'] = False
        return value

    def _expired(self, marker):
        with self._state_lock:
            if self._active is not marker:
                return
            self._stopping.set()
            # Never unload buffers beneath an outstanding SDK call. Exit this
            # backend process; systemd Restart=on-failure can recover it. A
            # kernel/device hang may still require host-level intervention.
            self._on_stall()

    def generate(self, pixels, ids, tokens, cancelled):
        if self._stopping.is_set():
            raise RuntimeError('Executor is stopping')
        if not self._generation.acquire(blocking=False):
            raise RuntimeError('Executor generation is busy')
        timer = None
        try:
            if self._stopping.is_set():
                raise RuntimeError('Executor is stopping')
            marker = object()
            with self._state_lock:
                self._active = marker
            timer = threading.Timer(self._hard_seconds, self._expired, (marker,))
            timer.daemon = True
            timer.start()
            return self._backend.generate(
                pixels, ids, tokens,
                lambda: self._stopping.is_set() or
                (cancelled is not None and cancelled()))
        finally:
            if timer is not None:
                timer.cancel()
            with self._state_lock:
                self._active = None
            self._generation.release()


class BoundedRequestServer:
    def __init__(self, listener, backend, handler, stopping, maximum_connections=8):
        if not 2 <= maximum_connections <= 8:
            raise ValueError('Control connection capacity must be between two and eight')
        self.listener = listener
        self.backend = SerialGenerationBackend(backend, stopping)
        self.handler = handler
        self.stopping = stopping
        self.slots = threading.BoundedSemaphore(maximum_connections)
        self.threads = set()
        self.lock = threading.Lock()

    def _serve(self, connection):
        try:
            with connection:
                peer = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED,
                                             struct.calcsize('3i'))
                _, uid, _ = struct.unpack('3i', peer)
                if uid == os.getuid() and not self.stopping.is_set():
                    self.handler(connection, self.backend)
        finally:
            with self.lock:
                self.threads.discard(threading.current_thread())
            self.slots.release()

    def serve(self):
        self.listener.settimeout(.2)
        try:
            while not self.stopping.is_set():
                try:
                    connection, _ = self.listener.accept()
                except socket.timeout:
                    continue
                if not self.slots.acquire(blocking=False):
                    connection.close()
                    continue
                thread = threading.Thread(target=self._serve, args=(connection,),
                                          daemon=False)
                with self.lock:
                    self.threads.add(thread)
                try:
                    thread.start()
                except BaseException:
                    with self.lock:
                        self.threads.discard(thread)
                    connection.close()
                    self.slots.release()
                    raise
        finally:
            self.stopping.set()
            # Do not unload a model underneath an in-flight SDK call. Workers
            # observe cancellation at existing component boundaries. A stuck SDK
            # still requires the service manager's process-level stop policy.
            while True:
                with self.lock:
                    active = list(self.threads)
                if not active:
                    break
                for thread in active:
                    thread.join(.2)
