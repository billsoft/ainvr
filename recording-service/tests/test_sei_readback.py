"""识别信息索引不能把录像整段读回（2026-09-30 8K 100Mbps 实测：每分钟回读约 1.4GB，
约 200Mbps 压在 WiFi 上，相机推流被挤断）。

- 原始流通道的录像不可能带识别信息：直接记为"无"，一个字节都不读；
- AI 输出通道的录像：识别信息总在每帧画面数据之前，读到第一块画面数据就停。
"""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from recorder import sei_indexer as sei_indexer_mod
from recorder import sei_worker
from recorder.index import SegmentIndex
from recorder.sei_indexer import SeiIndexer
from recorder.sei_worker import UUID, scan


def _row(**kw):
    row = dict(id='seg1', channelId='cam', channelName='大门口', streamName='cam', startTs=0,
               endTs=60000, durationMs=60000, sizeBytes=100, codec='h265',
               storage='local', relPath='a.mp4', complete=True, seiPresent=False)
    row.update(kw)
    return row


def _indexer(tmp_path, channel_kind):
    index = SegmentIndex(str(tmp_path / 'segments.db'))
    index.upsert_segment(_row())
    storage = SimpleNamespace(
        current_status=lambda: SimpleNamespace(healthy=True),
        io=SimpleNamespace(generation=1),
        media_root=lambda: str(tmp_path))
    return index, SeiIndexer(index, storage, channel_kind=channel_kind)


def test_source_channel_segments_are_marked_empty_without_reading(tmp_path, monkeypatch):
    async def forbidden(*a, **k):
        raise AssertionError('原始流录像不应被回读')
    monkeypatch.setattr(sei_indexer_mod.asyncio, 'create_subprocess_exec', forbidden)
    index, indexer = _indexer(tmp_path, lambda cid: 'source')
    asyncio.run(indexer.scan_one())
    assert index.get('seg1')['seiRanges'] == []
    assert index.pending_sei() == []
    index.close()


def test_ai_and_unknown_channel_segments_are_still_scanned(tmp_path, monkeypatch):
    """AI 输出通道要扫；通道已删、类型未知时保守起见也扫（可能是旧的 AI 录像）。"""
    for kind in ('ai', None):
        calls = []

        async def fake_exec(*args, **kwargs):
            calls.append(args)
            raise RuntimeError('stop here')
        monkeypatch.setattr(sei_indexer_mod.asyncio, 'create_subprocess_exec', fake_exec)
        (tmp_path / str(kind)).mkdir()
        index, indexer = _indexer(tmp_path / str(kind), lambda cid, k=kind: k)
        try:
            asyncio.run(indexer.scan_one())
        except RuntimeError:
            pass
        assert calls, kind
        index.close()




# ---- 类型未确认时不能把 AI 录像标成"没有识别信息" ----
# AI 目录（经控制台后端）启动时可能取不到：通道类型此时是"未知"，不是"普通源"。
# 误当普通源会把 AI 输出的录像永久写成空索引，目录恢复后已完成的空索引不会重扫。

def test_indexer_never_marks_empty_while_kind_unconfirmed(tmp_path, monkeypatch):
    calls = []

    async def fake_exec(*args, **kwargs):
        calls.append(args)
        raise RuntimeError('stop here')
    monkeypatch.setattr(sei_indexer_mod.asyncio, 'create_subprocess_exec', fake_exec)
    index, indexer = _indexer(tmp_path, lambda cid: None)   # 类型未确认
    try:
        asyncio.run(indexer.scan_one())
    except RuntimeError:
        pass
    assert calls, '类型未确认时应保守地扫描'
    assert index.get('seg1')['seiRanges'] is None
    index.close()


def test_kind_corrected_from_source_to_ai_requeues_segments(tmp_path, monkeypatch):
    """先被确认为普通源（标空），后来修正成 AI 输出：受影响的录像必须重新排队扫描。"""
    calls = []

    async def fake_exec(*args, **kwargs):
        calls.append(args)
        raise RuntimeError('stop here')
    monkeypatch.setattr(sei_indexer_mod.asyncio, 'create_subprocess_exec', fake_exec)
    kinds = {'cam': 'source'}
    index, indexer = _indexer(tmp_path, lambda cid: kinds.get(cid))
    asyncio.run(indexer.scan_one())
    assert index.get('seg1')['seiRanges'] == [] and index.pending_sei() == []
    kinds['cam'] = 'ai'                                      # 目录修正
    try:
        asyncio.run(indexer.scan_one())
    except RuntimeError:
        pass
    assert calls, '修正为 AI 后应重新扫描'
    assert index.get('seg1')['seiRanges'] is None
    index.close()


def test_other_channels_empty_index_survives_a_reclassification(tmp_path):
    """只重排队被修正的那个通道，别的通道已标空的录像不动。"""
    index = SegmentIndex(str(tmp_path / 'segments.db'))
    index.upsert_segment(_row(id='a', channelId='cam', relPath='a.mp4'))
    index.upsert_segment(_row(id='b', channelId='other', relPath='b.mp4'))
    for sid in ('a', 'b'):
        index.set_sei_ranges(index.get(sid), [])
    index.reset_sei_ranges('cam')
    assert index.get('a')['seiRanges'] is None
    assert index.get('b')['seiRanges'] == []
    index.close()


def test_sei_index_version_bump_rescans_everything_marked_by_old_rule(tmp_path):
    """旧规则(版本 2)下可能被误标空的录像，升级后全部重新索引一次。"""
    import sqlite3
    db = str(tmp_path / 'segments.db')
    index = SegmentIndex(db)
    index.upsert_segment(_row())
    index.set_sei_ranges(index.get('seg1'), [])
    index.conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('sei_index_version','2')")
    index.conn.commit()
    index.close()
    reopened = SegmentIndex(db)
    assert reopened.get('seg1')['seiRanges'] is None
    reopened.close()


# ---- "因普通源判断而跳过"要持久记录：重启后仍能纠正（审查：seen_kind 只在内存里） ----
# 新建的 AI 输出通道会先出现在通道列表里，而 AI 目录 30 秒才刷新：这段时间它被判成普通源，
# 录像被标成"无识别信息"。目录更新后必须能纠正——包括录像服务在这期间重启过的情况。

def test_skip_reason_survives_a_restart_and_a_later_ai_confirmation_requeues(tmp_path, monkeypatch):
    calls = []

    async def fake_exec(*args, **kwargs):
        calls.append(args)
        raise RuntimeError('stop here')
    monkeypatch.setattr(sei_indexer_mod.asyncio, 'create_subprocess_exec', fake_exec)

    index, first = _indexer(tmp_path, lambda cid: 'source')       # 目录还没认出它：判成普通源
    asyncio.run(first.scan_one())
    assert index.get('seg1')['seiRanges'] == [] and index.pending_sei() == []

    # —— 录像服务重启：内存里的任何记忆都没了，索引库还在 ——
    second = SeiIndexer(index, first.storage, channel_kind=lambda cid: 'ai')   # 目录更新：它其实是 AI 输出
    try:
        asyncio.run(second.scan_one())
    except RuntimeError:
        pass
    assert calls, '重启后目录纠正为 AI，应当重新扫描被跳过的录像'
    assert index.get('seg1')['seiRanges'] is None
    index.close()


def test_a_really_scanned_empty_result_is_not_reset_by_a_later_ai_confirmation(tmp_path):
    """真正扫描过、结果为空的录像不是"被跳过"的，不该被重扫（否则每 30 秒无谓地回读）。"""
    index = SegmentIndex(str(tmp_path / 'segments.db'))
    index.upsert_segment(_row())
    index.set_sei_ranges(index.get('seg1'), [])                   # 扫描得到的空结果（无跳过原因）
    index.reset_sei_skipped_as_source('cam')
    assert index.get('seg1')['seiRanges'] == []
    index.close()


def test_skipped_rows_of_other_channels_are_untouched(tmp_path):
    index = SegmentIndex(str(tmp_path / 'segments.db'))
    index.upsert_segment(_row(id='a', channelId='cam', relPath='a.mp4'))
    index.upsert_segment(_row(id='b', channelId='other', relPath='b.mp4'))
    for sid in ('a', 'b'):
        index.skip_sei_as_source(index.get(sid))
    index.reset_sei_skipped_as_source('cam')
    assert index.get('a')['seiRanges'] is None
    assert index.get('b')['seiRanges'] == []
    index.close()


def test_sei_reason_column_is_added_to_an_existing_database(tmp_path):
    import sqlite3
    db = str(tmp_path / 'segments.db')
    index = SegmentIndex(db)
    index.close()
    conn = sqlite3.connect(db)
    conn.execute('ALTER TABLE segments DROP COLUMN sei_reason')   # 模拟没有这一列的旧库
    conn.execute("DELETE FROM meta WHERE key='sei_index_version'")
    conn.commit(); conn.close()
    reopened = SegmentIndex(db)                                    # 不应抛错，并补上这一列
    reopened.upsert_segment(_row())
    reopened.skip_sei_as_source(reopened.get('seg1'))
    assert reopened.get('seg1')['seiRanges'] == []
    reopened.close()
