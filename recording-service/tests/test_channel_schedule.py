"""录像通道选择：24 小时整点录像计划（2026-09-18）。

覆盖：
- ChannelSchedule 模型：默认全选、非法 hours 拒绝、去重排序、is_recording_at
- Supervisor._wanted：计划优先、enabled=False 优先于 hours、跨小时判定、
  无计划时回退旧 enabled_channel_ids
- parse_channel_schedules：channelSchedules 解析校验、旧 enabledChannelIds 迁移
"""
import os
from unittest.mock import MagicMock

import pytest

from recorder.app import parse_channel_schedules
from recorder.config import ChannelSchedule, ConfigStore
from recorder.index import SegmentIndex
from recorder.storage import StorageManager
from recorder.supervisor import Supervisor


# ---------- ChannelSchedule 模型 ----------

def test_schedule_default_all_hours():
    s = ChannelSchedule()
    assert s.enabled is True
    assert s.hours == list(range(24))
    assert s.is_recording_at(0) and s.is_recording_at(23)


def test_schedule_hours_dedup_sorted():
    s = ChannelSchedule(enabled=True, hours=[5, 5, 3, 23, 0])
    assert s.hours == [0, 3, 5, 23]


def test_schedule_invalid_hours_rejected():
    with pytest.raises(Exception):
        ChannelSchedule(enabled=True, hours=[24])
    with pytest.raises(Exception):
        ChannelSchedule(enabled=True, hours=[-1])
    with pytest.raises(Exception):
        ChannelSchedule(enabled=True, hours=["a"])


def test_schedule_enabled_false_beats_hours():
    s = ChannelSchedule(enabled=False, hours=list(range(24)))
    assert not s.is_recording_at(12)


def test_schedule_partial_hours():
    # 只录 08 点：8:00-8:59 在录，9 点起停
    s = ChannelSchedule(enabled=True, hours=[8])
    assert s.is_recording_at(8)
    assert not s.is_recording_at(9)
    assert not s.is_recording_at(7)


# ---------- Supervisor._wanted ----------

class FakeChannels:
    def __init__(self, channels):
        self.channels = channels


def _supervisor(tmp_path):
    store = ConfigStore(str(tmp_path / "config.json"))
    cfg = store.mutate()
    cfg.recording.storage.localPath = str(tmp_path / "videos")
    cfg.enabled_channel_ids = ["legacy-ch"]
    os.makedirs(cfg.recording.storage.localPath, exist_ok=True)
    store.save()
    store.commit()
    index = SegmentIndex(str(tmp_path / "segments.db"))
    sm = StorageManager()
    sup = Supervisor(store, FakeChannels([]), sm, index)
    return sup, store


def test_wanted_falls_back_to_enabled_ids(tmp_path):
    sup, store = _supervisor(tmp_path)
    cfg = store.get()
    assert sup._wanted(cfg, "legacy-ch") is True
    assert sup._wanted(cfg, "not-enabled") is False


def test_wanted_schedule_priority_over_legacy(tmp_path):
    sup, store = _supervisor(tmp_path)
    cfg = store.mutate()
    # 既有计划：只录 8 点；legacy-ch 虽在 enabled_channel_ids 中，
    # 但计划存在时以计划为准（当前小时非 8 → 不录）
    cfg.channel_schedules = {"legacy-ch": ChannelSchedule(enabled=True, hours=[8])}
    store.commit()
    cfg2 = store.get()
    assert sup._wanted(cfg2, "legacy-ch", now_hour=8) is True
    assert sup._wanted(cfg2, "legacy-ch", now_hour=10) is False


def test_wanted_enabled_false_stops(tmp_path):
    sup, store = _supervisor(tmp_path)
    cfg = store.mutate()
    cfg.channel_schedules = {"ch": ChannelSchedule(enabled=False, hours=list(range(24)))}
    store.commit()
    assert sup._wanted(store.get(), "ch", now_hour=12) is False


# ---------- parse_channel_schedules ----------

def test_parse_none_returns_none():
    assert parse_channel_schedules(None, None) == (None, "")


def test_parse_legacy_enabled_ids_migrates_full_day():
    schedules, err = parse_channel_schedules(None, ["a", "b", "a"])
    assert err == ""
    assert set(schedules) == {"a", "b"}
    assert schedules["a"].hours == list(range(24))
    assert schedules["a"].enabled is True


def test_parse_channel_schedules_valid():
    raw = {
        "ch1": {"enabled": True, "hours": [8, 9, 10]},
        "ch2": {"enabled": False, "hours": [0, 23]},
    }
    schedules, err = parse_channel_schedules(raw, ["ignored"])
    assert err == ""
    assert schedules["ch1"].hours == [8, 9, 10]
    assert schedules["ch2"].enabled is False


def test_parse_rejects_bad_hours():
    schedules, err = parse_channel_schedules({"ch1": {"hours": [24]}}, None)
    assert schedules is None
    assert "ch1" in err


def test_parse_rejects_non_object():
    schedules, err = parse_channel_schedules(["not-dict"], None)
    assert schedules is None
    assert "对象" in err
