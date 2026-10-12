"""写入不足（按 GOP 丢弃）对外暴露：时间轴区间、统计、健康告警、通道状态。"""
import time


def _drop(client, cid="ch1", ago_s=600, ms=12_000):
    now = int(time.time() * 1000)
    client.app.state.index.add_drop_event({
        "channelId": cid, "startTs": now - ago_s * 1000, "endTs": now - ago_s * 1000 + ms,
        "droppedMs": ms, "gops": 2, "bytes": 1, "reason": "backlog"})
    return now


def test_drops_endpoint_returns_ranges_for_timeline(client):
    now = _drop(client)
    rows = client.get("/v1/recordings/drops",
                      params={"channel": "ch1", "from": now - 3_600_000, "to": now}).json()
    assert rows == [{"startTs": now - 600_000, "endTs": now - 588_000,
                     "droppedMs": 12_000, "reason": "backlog"}]
    assert client.get("/v1/recordings/drops",
                      params={"channel": "other", "from": now - 3_600_000, "to": now}).json() == []


def test_stats_and_health_warn_when_writes_cannot_keep_up(client):
    _drop(client)
    stats = client.get("/v1/recorder/stats").json()
    assert stats["droppedMsLastHour"] == 12_000 and stats["writeDegradedChannels"] == 1
    health = client.get("/v1/recorder/health").json()
    assert "未保存录像" in health["warning"] and "12 秒" in health["warning"]
    assert health["droppedMsLastHour"] == 12_000


def test_old_drops_do_not_warn(client):
    _drop(client, ago_s=7200)
    assert client.get("/v1/recorder/stats").json()["writeDegradedChannels"] == 0
    assert client.get("/v1/recorder/health").json()["warning"] is None
