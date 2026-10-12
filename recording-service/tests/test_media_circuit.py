"""端到端回归：存储熔断 OPEN 时媒体端点快速 503、健康检查立即反映、
段列表（纯 SQLite）不受影响；reset（模拟重挂恢复）后播放恢复。"""
import os
import pytest

from fastapi.testclient import TestClient


@pytest.mark.parametrize('header,status,body', [
    ('bytes=2-5', 206, b'2345'), ('bytes=-3', 206, b'789'),
    ('bytes=8-', 206, b'89'), ('bytes=99-', 416, b''),
])
def test_media_ranges(client, store, header, status, body):
    segment = _seed_segment(client, store)
    response = client.get(f'/v1/recordings/{segment}/play', headers={'Range': header})
    assert response.status_code == status
    assert response.content == body


def test_other_storage_identity_is_not_playable(client, store):
    segment = _seed_segment(client, store)
    client.app.state.storage.status.storage_id = 'another-root'
    assert client.get(f'/v1/recordings/{segment}/play').status_code == 410
    assert client.app.state.index.get(segment) is not None


def _seed_segment(client, store, start=1789000000000):
    app = client.app
    index = app.state.index
    root = store.get().recording.storage.localPath
    rel = "20260916/circuit_test_20260916_080000.mp4"
    abs_path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    with open(abs_path, "wb") as f:
        f.write(b"0123456789")
    index.upsert_segment({
        "id": f"ch9-{start}", "channelId": "ch9", "channelName": "circuit",
        "streamName": "circuit_test", "startTs": start, "endTs": start + 60_000,
        "durationMs": 60_000, "sizeBytes": 10, "codec": "h264",
        "storage": "local", "relPath": rel, "complete": True,
    })
    return f"ch9-{start}"


def test_play_503_when_circuit_open_and_recovers(client, store):
    seg_id = _seed_segment(client, store)

    # 正常：200
    r = client.get(f"/v1/recordings/{seg_id}/play")
    assert r.status_code == 200
    assert r.content == b"0123456789"

    sm = client.app.state.storage
    # 模拟工作线程捕获到 D 状态：跳闸（on_trip 立即把存储置 unhealthy）
    sm.io.trip("unlink", "操作超过 120s 未返回")

    # 播放/下载在 resolve 阶段立即 503，而不是挂连接
    r = client.get(f"/v1/recordings/{seg_id}/play")
    assert r.status_code == 503
    assert client.get(f"/v1/recordings/{seg_id}/download").status_code == 503

    # 健康检查永不触文件系统：200 且带诊断，storageHealthy=False
    h = client.get("/v1/recorder/health").json()
    assert h["storageHealthy"] is False
    assert h["blockedOp"] == "unlink"
    assert h["stuckSeconds"] is not None

    # 段列表只读本地 SQLite，仍 200（playable=False 提示前端）
    r = client.get("/v1/recordings/segments",
                   params={"channel": "ch9", "from": 0})
    assert r.status_code == 200
    segs = r.json()
    assert len(segs) == 1 and segs[0]["playable"] is False

    # stats 也不卡：读容量缓存快照（local 启动即建缓存），健康标志独立反映熔断
    stats = client.get("/v1/recorder/stats").json()
    assert stats["storageHealthy"] is False
    assert stats["capacityKnown"] is True
    assert stats["poolTotalBytes"] > 0

    # 模拟重挂恢复：reset 后播放立即恢复
    sm.io.reset("测试重挂成功")
    sm.status.healthy = True
    sm.status.message = ""
    r = client.get(f"/v1/recordings/{seg_id}/play")
    assert r.status_code == 200
    assert r.content == b"0123456789"
    h2 = client.get("/v1/recorder/health").json()
    assert h2["storageHealthy"] is True and h2["blockedOp"] is None
