"""通道目录从流媒体服务带出推流会话 ID，供录像在相机重推时换读端（见 test_supervisor_codec）。"""
from __future__ import annotations

import asyncio

from recorder import channels as channels_mod
from recorder.channels import ChannelManager
from recorder.config import ConfigStore
from recorder.index import SegmentIndex


def _srs(publish):
    return {"streams": [{
        "name": "cam", "app": "live",
        "video": {"codec": "HEVC", "width": 3840, "height": 1920},
        "audio": None, "publish": publish,
    }]}


def _manager(tmp_path, monkeypatch, srs_payload, bff_online=True):
    store = ConfigStore(str(tmp_path / "config.json"))
    cm = ChannelManager(store, SegmentIndex(str(tmp_path / "segments.db")))
    monkeypatch.setattr(channels_mod, "_http_get_json", lambda *a, **k: srs_payload)
    monkeypatch.setattr(cm, "_fetch_bff_channels", lambda: [{
        "id": "c1", "name": "大门口", "streamName": "cam", "app": "live",
        "rtmpUrl": "rtmp://127.0.0.1:1935/live/cam", "bffOnline": bff_online, "bffCodec": None}])
    monkeypatch.setattr(cm, "_fetch_ai_outputs", lambda: set())
    return cm


def test_active_publisher_session_is_exposed(tmp_path, monkeypatch):
    cm = _manager(tmp_path, monkeypatch, _srs({"active": True, "cid": "nv623941"}))
    asyncio.run(cm.refresh_once())
    assert cm.get("c1")["publisherId"] == "nv623941"


def test_inactive_publisher_has_no_session(tmp_path, monkeypatch):
    cm = _manager(tmp_path, monkeypatch, _srs({"active": False, "cid": "old"}))
    asyncio.run(cm.refresh_once())
    assert cm.get("c1")["publisherId"] is None


def test_stream_with_only_players_is_not_online(tmp_path, monkeypatch):
    """相机已停推，但录像/AI 还在尝试拉流，流媒体服务会保留这路流（只有观看方）。
    这不算在线：否则录像服务反复拉起读端、读不到数据又失败，空转重启。"""
    payload = _srs({"active": False, "cid": "old"})
    payload["streams"][0]["video"] = None
    cm = _manager(tmp_path, monkeypatch, payload, bff_online=False)
    asyncio.run(cm.refresh_once())
    assert cm.get("c1")["online"] is False


def test_active_publisher_is_online_even_before_bff_catches_up(tmp_path, monkeypatch):
    cm = _manager(tmp_path, monkeypatch, _srs({"active": True, "cid": "nv1"}), bff_online=False)
    asyncio.run(cm.refresh_once())
    assert cm.get("c1")["online"] is True
    assert cm.get("c1")["codec"] == "h265"


# ---- 通道类型（AI 输出 / 普通源）是否已被 AI 目录确认 ----

def test_kind_is_unconfirmed_until_the_ai_directory_has_been_read(tmp_path, monkeypatch):
    cm = _manager(tmp_path, monkeypatch, _srs({"active": True, "cid": "x"}))

    def boom():
        raise OSError("AI 目录暂时不可用")
    monkeypatch.setattr(cm, "_fetch_ai_outputs", boom)
    asyncio.run(cm.refresh_once())
    assert cm.confirmed_kind("c1") is None      # 取不到目录：未知，不是"普通源"

    monkeypatch.setattr(cm, "_fetch_ai_outputs", lambda: set())
    cm._ai_refresh_at = 0.0
    asyncio.run(cm.refresh_once())
    assert cm.confirmed_kind("c1") == "source"   # 目录读到了，且不含它

    monkeypatch.setattr(cm, "_fetch_ai_outputs", lambda: {("live", "cam")})
    cm._ai_refresh_at = 0.0
    asyncio.run(cm.refresh_once())
    assert cm.confirmed_kind("c1") == "ai"


def test_directory_failure_after_success_keeps_the_confirmed_kind(tmp_path, monkeypatch):
    cm = _manager(tmp_path, monkeypatch, _srs({"active": True, "cid": "x"}))
    monkeypatch.setattr(cm, "_fetch_ai_outputs", lambda: {("live", "cam")})
    asyncio.run(cm.refresh_once())

    def boom():
        raise OSError("下线")
    monkeypatch.setattr(cm, "_fetch_ai_outputs", boom)
    cm._ai_refresh_at = 0.0
    asyncio.run(cm.refresh_once())
    assert cm.confirmed_kind("c1") == "ai"       # 已验证过的映射不被一次故障抹掉


def test_unknown_channel_has_no_confirmed_kind(tmp_path, monkeypatch):
    cm = _manager(tmp_path, monkeypatch, _srs({"active": True, "cid": "x"}))
    asyncio.run(cm.refresh_once())
    assert cm.confirmed_kind("deleted-channel") is None
