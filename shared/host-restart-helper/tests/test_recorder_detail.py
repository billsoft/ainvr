"""仪表盘录像服务明细：存储异常时必须带上录像服务给出的具体原因（2026-09-24
NAS 写满时只显示"存储 smb 不可用"，看不出是空间不足）。"""
from __future__ import annotations

from observability import recorder_detail


def test_healthy_storage():
    assert recorder_detail({'storageKind': 'smb', 'storageHealthy': True}) == '存储 smb 正常'


def test_unhealthy_storage_carries_reason():
    detail = recorder_detail({'storageKind': 'smb', 'storageHealthy': False,
                              'message': 'NAS 可用空间不足（剩余 0.0GB，停录线 5.0GB）'})
    assert detail.startswith('存储 smb 不可用：')
    assert '空间不足' in detail


def test_warning_shown_and_long_text_clipped():
    detail = recorder_detail({'storageKind': 'smb', 'storageHealthy': True,
                              'warning': 'NAS 共享开启了回收站' + '很长' * 200})
    assert detail.startswith('存储 smb 正常 · NAS 共享开启了回收站')
    assert len(detail) <= 160 and detail.endswith('…')
