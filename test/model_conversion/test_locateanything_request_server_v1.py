"""Control-only tests: real private sockets, fake backend, zero neural calls."""
from pathlib import Path
import importlib.util
import json
import socket
import struct
import tempfile
import threading
import time
import unittest

from locateanything_request_server import BoundedRequestServer

runtime = Path('/home/sunrise/ainvr/ai-service/runtime')
spec = importlib.util.spec_from_file_location(
    'candidate_executor', runtime / 'locateanything_bpu_executor_v2.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class Prompt:
    def encode(self, description, tokens, mode):
        if description != 'person':
            raise ValueError('Invalid test prompt')
        return [1]


class Backend:
    contract_sha256 = 'a' * 64
    mode = 'slow'
    prompt = Prompt()

    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.cancelled = threading.Event()
        self.active = 0
        self.maximum_active = 0
        self.calls = 0
        self.fail = False

    def health(self):
        return dict(ready=True, neural_provider='fake-control-only')

    def generate(self, pixels, ids, tokens, cancelled):
        self.active += 1
        self.calls += 1
        self.maximum_active = max(self.maximum_active, self.active)
        self.entered.set()
        try:
            if self.fail:
                raise RuntimeError('Injected fake backend failure')
            deadline = time.monotonic() + 5
            while not self.release.wait(.01):
                if cancelled():
                    self.cancelled.set()
                    raise RuntimeError('Fake generation cancelled')
                if time.monotonic() >= deadline:
                    raise RuntimeError('Fake backend test deadline')
            return dict(response='<box>None</box>', all_models_released=True)
        finally:
            self.active -= 1


def request(path, operation, timeout=2):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(str(path))
        value = dict(schema_version=1, contract_sha256=Backend.contract_sha256,
                     operation=operation, description='person', tokens=128)
        if operation == 'generate':
            value.update(input_bytes=candidate.INPUT_BYTES,
                         input_shape=[3, 224, 448], pixel_format='rgb-chw-f32le')
        header = json.dumps(value).encode()
        connection.sendall(struct.pack('!I', len(header)) + header)
        if operation == 'generate':
            connection.sendall(bytes(candidate.INPUT_BYTES))
        size = struct.unpack('!I', candidate.receive_exact(connection, 4))[0]
        return json.loads(candidate.receive_exact(connection, size))


class Controls(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='locate-control-')
        self.path = Path(self.directory.name) / 'test.sock'
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(self.path))
        self.path.chmod(0o600)
        self.listener.listen(8)
        self.stop = threading.Event()
        self.backend = Backend()
        self.server = BoundedRequestServer(
            self.listener, self.backend, candidate.serve_connection, self.stop)
        self.thread = threading.Thread(target=self.server.serve)
        self.thread.start()

    def tearDown(self):
        self.stop.set()
        self.backend.release.set()
        self.thread.join(3)
        self.assertFalse(self.thread.is_alive())
        self.listener.close()
        self.directory.cleanup()

    def begin(self):
        result = {}
        def run():
            result.update(request(self.path, 'generate', timeout=5))
        thread = threading.Thread(target=run)
        thread.start()
        self.assertTrue(self.backend.entered.wait(2))
        return thread, result

    def test_health_during_generation_and_no_second_neural_request(self):
        thread, result = self.begin()
        started = time.monotonic()
        health = request(self.path, 'health')
        self.assertTrue(health['ok'] and health['ready'] and health['busy'])
        self.assertLess(time.monotonic() - started, 1)
        self.assertFalse(request(self.path, 'generate')['ok'])
        self.assertEqual(self.backend.calls, 1)
        self.assertEqual(self.backend.maximum_active, 1)
        self.backend.release.set()
        thread.join(2)
        self.assertTrue(result['ok'] and result['all_models_released'])
        self.assertFalse(request(self.path, 'health')['busy'])

    def test_stop_cancels_generation_and_joins_worker(self):
        thread, result = self.begin()
        self.stop.set()
        self.thread.join(2)
        thread.join(2)
        self.assertFalse(self.thread.is_alive())
        self.assertFalse(thread.is_alive())
        self.assertTrue(self.backend.cancelled.is_set())
        self.assertFalse(result['ok'])
        self.assertEqual(self.backend.active, 0)

    def test_backend_failure_releases_gate_for_next_request(self):
        self.backend.fail = True
        self.assertFalse(request(self.path, 'generate')['ok'])
        self.assertFalse(request(self.path, 'health')['busy'])
        self.backend.fail = False
        self.backend.release.set()
        self.assertTrue(request(self.path, 'generate')['ok'])
        self.assertEqual(self.backend.maximum_active, 1)

    def test_invalid_request_does_not_take_generation_gate(self):
        self.assertFalse(request(self.path, 'invalid')['ok'])
        self.assertTrue(request(self.path, 'validate')['valid'])
        self.assertFalse(request(self.path, 'health')['busy'])
        self.assertEqual(self.backend.calls, 0)

    def test_capacity_is_bounded_and_rejects_overflow(self):
        connections = []
        original = self.server.handler
        held = threading.Event()
        all_entered = threading.Event()
        count = [0]
        lock = threading.Lock()
        def handler(connection, backend):
            with lock:
                count[0] += 1
                if count[0] == 8:
                    all_entered.set()
            held.wait(2)
        self.server.handler = handler
        try:
            for _ in range(8):
                connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                connection.settimeout(2)
                connection.connect(str(self.path))
                connections.append(connection)
            self.assertTrue(all_entered.wait(2))
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as overflow:
                overflow.settimeout(1)
                overflow.connect(str(self.path))
                self.assertEqual(overflow.recv(1), b'')
            with self.server.lock:
                self.assertEqual(len(self.server.threads), 8)
            self.assertEqual(self.backend.calls, 0)
        finally:
            held.set()
            for connection in connections:
                connection.close()
            self.server.handler = original


if __name__ == '__main__':
    unittest.main(verbosity=2)
