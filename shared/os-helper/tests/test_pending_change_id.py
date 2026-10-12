"""待确认变更带唯一 ID：确认请求绑定 ID，旧页面/旧计时不能误确认一次新的变更。"""
from __future__ import annotations

import http.server
import json
import threading
import urllib.error
import urllib.request
from unittest.mock import patch

import pytest

import main
import nm


@pytest.fixture(autouse=True)
def _clean_pending():
    def reset():
        nm._pending = None
        if nm._rollback_timer:
            nm._rollback_timer.cancel()
            nm._rollback_timer = None
    reset()
    with patch.object(nm, "_snapshot_connection", return_value={"type": "new", "iface": "eth0"}), \
            patch.object(nm, "_apply_config"):
        yield
    reset()


def test_pending_info_carries_unique_id_per_change():
    nm.start_apply("eth0", {"ipv4": {"method": "auto"}}, rollback_seconds=30)
    first = nm.pending_info()["id"]
    assert isinstance(first, str) and first
    nm.confirm_pending(first)
    nm.start_apply("eth0", {"ipv4": {"method": "auto"}}, rollback_seconds=30)
    assert nm.pending_info()["id"] != first


def test_confirm_with_stale_id_is_rejected_and_keeps_pending():
    nm.start_apply("eth0", {"ipv4": {"method": "auto"}}, rollback_seconds=30)
    with pytest.raises(nm.NMError, match="已变化"):
        nm.confirm_pending("stale-id")
    assert nm.pending_info() is not None
    nm.confirm_pending(nm.pending_info()["id"])
    assert nm.pending_info() is None


def test_confirm_without_id_still_works_for_older_consoles():
    nm.start_apply("eth0", {"ipv4": {"method": "auto"}}, rollback_seconds=30)
    nm.confirm_pending()
    assert nm.pending_info() is None


@pytest.fixture
def server(monkeypatch):
    monkeypatch.setattr(main, "TOKEN", "test-token")
    monkeypatch.setattr(main, "source_ip_allowed", lambda addr: True)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), main.OSHelperHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def _post(base, path, body):
    req = urllib.request.Request(
        base + path, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": "Bearer test-token", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_http_confirm_passes_change_id(server):
    nm.start_apply("eth0", {"ipv4": {"method": "auto"}}, rollback_seconds=30)
    status, body = _post(server, "/network/confirm", {"id": "stale-id"})
    assert status == 400 and "已变化" in body["error"]
    assert nm.pending_info() is not None
    status, _ = _post(server, "/network/confirm", {"id": nm.pending_info()["id"]})
    assert status == 200
    assert nm.pending_info() is None


def test_http_confirm_rejects_non_string_id(server):
    nm.start_apply("eth0", {"ipv4": {"method": "auto"}}, rollback_seconds=30)
    status, _ = _post(server, "/network/confirm", {"id": 123})
    assert status == 400
    assert nm.pending_info() is not None
