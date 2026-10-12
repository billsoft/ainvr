import os

from fastapi.testclient import TestClient

from recorder.app import create_app
from recorder.config import ConfigStore


def test_health_and_default_config(client):
    r = client.get("/v1/recorder/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    cfg = client.get("/v1/recorder/config").json()
    assert set(cfg.keys()) == {"storage", "quota", "files"}
    assert cfg["files"]["segmentSeconds"] == 60
    assert cfg["storage"]["smb"] is None


def test_put_config_rejected_conflict(client):
    """写入口已收敛到统一配置中心：本地 PUT 一律 409。"""
    for payload in (
        {"files": {"segmentSeconds": 123}},
        {"files": {"segmentSeconds": 300}},
        {"quota": {"mode": "percent", "percent": 80, "onFull": "overwrite",
                   "gb": None, "minRetentionDays": 7}},
        {"enabledChannelIds": ["other"]},
    ):
        r = client.put("/v1/recorder/config", json=payload)
        assert r.status_code == 409
        assert "配置中心" in r.json()["detail"]


def test_storage_test_local(client, tmp_data):
    r = client.post("/v1/recorder/storage/test", json={
        "kind": "local",
        "localPath": os.path.join(tmp_data, "probe-dir"),
        "smb": None,
    })
    assert r.status_code == 409
    assert not os.path.exists(os.path.join(tmp_data, "probe-dir"))


def test_segments_and_range_play_download(client, store, tmp_data):
    app = client.app
    index = app.state.index
    root = store.get().recording.storage.localPath
    rel = "20260914/phase6_test_大门口_20260914_080000.mp4"
    abs_path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    payload = bytes((i % 251 for i in range(10000)))
    with open(abs_path, "wb") as f:
        f.write(payload)
    start = 1789000000000
    index.upsert_segment({
        "id": f"ch1-{start}", "channelId": "ch1", "channelName": "大门口",
        "streamName": "phase6_test", "startTs": start, "endTs": start + 60_000,
        "durationMs": 60_000, "sizeBytes": len(payload), "codec": "h264",
        "width": 3840, "height": 1920, "fps": 30, "hasAudio": True,
        "storage": "local", "relPath": rel, "complete": True,
    })

    r = client.get("/v1/recordings/segments",
                   params={"channel": "ch1", "from": start - 1, "to": start + 10})
    segs = r.json()
    assert len(segs) == 1
    s = segs[0]
    assert s["playable"] is True
    assert s["codec"] == "h264"
    assert "relPath" not in s  # 内部字段不外泄

    # Range 播放：206 + Content-Range
    r = client.get(f"/v1/recordings/ch1-{start}/play",
                   headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes 0-99/{len(payload)}"
    assert r.headers["accept-ranges"] == "bytes"
    assert len(r.content) == 100
    assert r.content == payload[:100]

    # 越界 Range → 416
    r = client.get(f"/v1/recordings/ch1-{start}/play",
                   headers={"Range": "bytes=99999-"})
    assert r.status_code == 416

    # 无 Range → 200 完整文件
    r = client.get(f"/v1/recordings/ch1-{start}/play")
    assert r.status_code == 200
    assert len(r.content) == len(payload)

    # 下载带 attachment 文件名
    r = client.get(f"/v1/recordings/ch1-{start}/download")
    assert r.status_code == 200
    cd = r.headers["content-disposition"]
    assert "attachment" in cd and "phase6_test" in cd

    # 不存在段 → 404
    assert client.get("/v1/recordings/nope/play").status_code == 404


def test_token_auth_required_when_password_set(tmp_data, monkeypatch):
    monkeypatch.setattr('recorder.auth._authorize', lambda token, cookie: 204 if token == 'deadbeef' else 401)
    p = os.path.join(tmp_data, "config2.json")
    s = ConfigStore(p)
    cfg = s.mutate()
    cfg.console.token = "deadbeef"
    cfg.console.base_url = "http://127.0.0.1:9"
    cfg.srs_api_url = "http://127.0.0.1:9"
    s.save()
    s.commit()
    app = create_app(s, tmp_data)
    with TestClient(app) as c:
        assert c.get("/v1/recorder/health").status_code == 401
        r = c.get("/v1/recorder/health",
                  headers={"X-Console-Token": "deadbeef"})
        assert r.status_code == 200
        # 媒体端点接受 query token
        assert c.get("/v1/recordings/x/play").status_code == 401


def test_media_requires_a_valid_license(store, tmp_data, monkeypatch):
    """生产行为锁定：授权不是 valid 时媒体端点一律 403，不因测试注入而放松。"""
    from conftest import guard_with_phase
    monkeypatch.setattr('recorder.auth._authorize', lambda *_: 204)
    for phase in ("configuration_error", "invalid", "dormant"):
        app = create_app(store, tmp_data, guard_factory=guard_with_phase(phase))
        try:
            with TestClient(app) as c:
                r = c.get("/v1/recordings/any/play")
                assert r.status_code == 403 and r.json()["detail"] == "LICENSE_REQUIRED"
        finally:
            app.state.storage.io.shutdown()
            app.state.index.close()
