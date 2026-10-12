"""“写入速度不足”提示的判据：只统计真正的写入积压，不统计停止录制时顺手丢掉的那一个画面组。

2026-10-01 误报：相机重新推流 → 录像进程被停 → 缓冲里没写完的 1 个画面组（0.167 秒、2MB）被丢，
reason='stopped'。界面据此在本机固态盘上提示“写入速度不足”，一小时不消失。
真正的写入不足（07:08 NAS 卡死）是 backlog 丢了 13.7 秒，或 stopped 时丢了 30 秒的积压——这些必须仍然报。
"""
from __future__ import annotations

import time

from recorder.index import SegmentIndex


def drop(index, ch, ms, reason, now):
    index.add_drop_event({'channelId': ch, 'startTs': now - ms - 1000, 'endTs': now - 1000,
                          'droppedMs': ms, 'gops': 1, 'bytes': 2_000_000, 'reason': reason})


def test_a_tiny_drop_at_stop_is_not_a_write_problem(tmp_path):
    index = SegmentIndex(str(tmp_path / 's.db'))
    now = int(time.time() * 1000)
    drop(index, 'a', 167, 'stopped', now)
    assert index.dropped_ms_since(now - 3_600_000) == {}


def test_real_backlog_drops_are_still_reported(tmp_path):
    index = SegmentIndex(str(tmp_path / 's.db'))
    now = int(time.time() * 1000)
    drop(index, 'a', 13_700, 'backlog', now)
    drop(index, 'a', 100, 'backlog', now)         # backlog 再小也是写不过来
    assert index.dropped_ms_since(now - 3_600_000) == {'a': 13_800}


def test_a_large_drop_at_stop_means_backlog_and_is_reported(tmp_path):
    index = SegmentIndex(str(tmp_path / 's.db'))
    now = int(time.time() * 1000)
    drop(index, 'a', 30_633, 'stopped', now)
    assert index.dropped_ms_since(now - 3_600_000) == {'a': 30_633}


def test_timeline_still_lists_every_drop_even_when_not_warned(tmp_path):
    index = SegmentIndex(str(tmp_path / 's.db'))
    now = int(time.time() * 1000)
    drop(index, 'a', 167, 'stopped', now)
    assert len(index.drop_events('a', now - 3_600_000, now + 1)) == 1
