"""Supervisor 与 H.265：按编码选读端、编码变化重启、缺 FFmpeg 8.1.2 明确报错、准入告警。

设计：docs/h265-codec12-support-design-2026-09-29.md §5.2（E2）、§7.1、§2。
"""
from __future__ import annotations

import asyncio
import os

from recorder import ffmpeg_recorder, supervisor as supervisor_mod
from recorder.config import ConfigStore
from recorder.index import SegmentIndex
from recorder.storage import StorageManager
from recorder.supervisor import Supervisor


class FakeChannels:
    def __init__(self, channels):
        self.channels = channels


class FakePipeline:
    instances: list["FakePipeline"] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.codec = kwargs.get("codec")
        self.pid = 5001
        self.exited = True
        self.returncode = None
        self.error = None
        self.stopped = False
        self.fake_stats: dict = {}
        FakePipeline.instances.append(self)

    async def start(self):
        pass

    def stalled(self):
        return False

    def stats(self):
        return self.fake_stats

    async def stop(self, term_timeout=5.0, kill_timeout=3.0):
        self.stopped = True
        self.returncode = 0
        return True


def _build(tmp_path, monkeypatch, codec):
    FakePipeline.instances = []
    monkeypatch.setattr(supervisor_mod, "RecordingPipeline", FakePipeline)
    store = ConfigStore(str(tmp_path / "config.json"))
    cfg = store.mutate()
    cfg.recording.storage.localPath = str(tmp_path / "videos")
    cfg.enabled_channel_ids = ["ch1"]
    os.makedirs(cfg.recording.storage.localPath, exist_ok=True)
    store.save()
    store.commit()
    index = SegmentIndex(str(tmp_path / "segments.db"))
    sm = StorageManager()
    sm.status.root = cfg.recording.storage.localPath
    ch = {"id": "ch1", "name": "大门", "streamName": "live/ch1",
          "rtmpUrl": "rtmp://127.0.0.1:9/live/ch1", "online": True, "codec": codec}
    return Supervisor(store, FakeChannels([ch]), sm, index), sm, ch


def _fake_ffmpeg8(tmp_path, monkeypatch, present=True):
    path = tmp_path / "ffmpeg8"
    if present:
        path.write_text("#!/bin/sh\n")
        path.chmod(0o755)
    monkeypatch.setattr(ffmpeg_recorder, "FFMPEG8", str(path))


def test_spawn_passes_channel_codec_to_pipeline(tmp_path, monkeypatch):
    _fake_ffmpeg8(tmp_path, monkeypatch)
    for codec in ("h264", "h265"):
        sup, sm, _ = _build(tmp_path, monkeypatch, codec)
        asyncio.run(sup._tick())
        assert FakePipeline.instances[-1].kwargs["codec"] == codec
        assert sup.state_of("ch1").state == "recording"
        sm.io.shutdown()


def test_h265_without_ffmpeg8_is_an_explicit_error_not_a_silent_spawn(tmp_path, monkeypatch):
    _fake_ffmpeg8(tmp_path, monkeypatch, present=False)
    sup, sm, _ = _build(tmp_path, monkeypatch, "h265")
    asyncio.run(sup._tick())
    st = sup.state_of("ch1")
    assert FakePipeline.instances == []
    assert st.state == "codec_error" and "缺少 H.265 录像组件" in st.detail and "--only python" in st.detail
    # 界面文字不暴露组件名、路径和技术栈（原文进日志）
    assert not any(k in st.detail for k in ("FFmpeg", "ffmpeg", "SRS", "/opt/"))
    assert sup.recording_status("ch1")["recordingState"] == "codec_error"
    sm.io.shutdown()


def test_h264_does_not_need_ffmpeg8(tmp_path, monkeypatch):
    _fake_ffmpeg8(tmp_path, monkeypatch, present=False)
    sup, sm, _ = _build(tmp_path, monkeypatch, "h264")
    asyncio.run(sup._tick())
    assert sup.state_of("ch1").state == "recording"
    sm.io.shutdown()


def test_codec_change_restarts_pipeline_with_new_codec_without_backoff(tmp_path, monkeypatch):
    _fake_ffmpeg8(tmp_path, monkeypatch)
    sup, sm, ch = _build(tmp_path, monkeypatch, "h264")

    async def run():
        await sup._tick()
        old = FakePipeline.instances[-1]
        assert old.codec == "h264"
        ch["codec"] = "h265"          # 相机改成 H.265 并重推，SRS 报告的编码变了
        await sup._tick()             # 发现不一致：停掉旧管线
        st = sup.state_of("ch1")
        assert old.stopped and st.proc is None and "编码变化" in st.detail
        await sup._tick()             # 不走退避，下一轮就按新编码拉起
        assert FakePipeline.instances[-1].codec == "h265"
        assert st.state == "recording"

    asyncio.run(run())
    sm.io.shutdown()


def test_unknown_codec_never_triggers_restart(tmp_path, monkeypatch):
    _fake_ffmpeg8(tmp_path, monkeypatch)
    sup, sm, ch = _build(tmp_path, monkeypatch, "h264")

    async def run():
        await sup._tick()
        ch["codec"] = None            # SRS 暂时拿不到编码：不能据此重启
        await sup._tick()
        assert not FakePipeline.instances[-1].stopped

    asyncio.run(run())
    sm.io.shutdown()


def test_online_but_codec_unknown_waits_instead_of_guessing(tmp_path, monkeypatch):
    """源已上线但 SRS 还没报出编码（刚开始推流、视频信息尚未解析）：先等，不按 264 猜着拉起——
    否则实际是 265 时要白录一段、再杀掉重启，丢一截录像。拿到编码后一次拉起到位。"""
    _fake_ffmpeg8(tmp_path, monkeypatch)
    sup, sm, ch = _build(tmp_path, monkeypatch, None)

    async def run():
        await sup._tick()
        st = sup.state_of("ch1")
        assert FakePipeline.instances == []
        assert st.state == "waiting_source" and "识别视频编码" in st.detail
        ch["codec"] = "h265"
        await sup._tick()
        assert len(FakePipeline.instances) == 1
        assert FakePipeline.instances[0].codec == "h265"
        assert not FakePipeline.instances[0].stopped

    asyncio.run(run())
    sm.io.shutdown()


def _age_codec_wait(sup, seconds):
    st = sup.state_of("ch1")
    assert st.codec_wait_since is not None
    st.codec_wait_since -= seconds


def test_codec_still_unknown_after_grace_falls_back_to_default_reader(tmp_path, monkeypatch):
    """SRS 接口一直给不出编码（如 API 不可达）：等待有上限，超时按默认读端录制，绝不无限停录。"""
    _fake_ffmpeg8(tmp_path, monkeypatch)
    sup, sm, ch = _build(tmp_path, monkeypatch, None)

    async def run():
        await sup._tick()
        assert FakePipeline.instances == []
        _age_codec_wait(sup, supervisor_mod.CODEC_WAIT_SEC + 1)
        await sup._tick()
        assert len(FakePipeline.instances) == 1 and FakePipeline.instances[0].codec is None

    asyncio.run(run())
    sm.io.shutdown()


def test_fallback_reader_then_h264_known_is_not_a_change(tmp_path, monkeypatch):
    """超时兜底用了默认读端，随后得知是 h264：读端本来就对，不重启，只补记编码。"""
    _fake_ffmpeg8(tmp_path, monkeypatch)
    sup, sm, ch = _build(tmp_path, monkeypatch, None)

    async def run():
        await sup._tick()
        _age_codec_wait(sup, supervisor_mod.CODEC_WAIT_SEC + 1)
        await sup._tick()
        first = FakePipeline.instances[-1]
        ch["codec"] = "h264"
        await sup._tick()
        assert not first.stopped and len(FakePipeline.instances) == 1
        assert first.codec == "h264"

    asyncio.run(run())
    sm.io.shutdown()


def test_fallback_reader_then_h265_known_restarts_with_ffmpeg8(tmp_path, monkeypatch):
    """兜底后才得知是 h265：默认读端（FFmpeg 4.4）读不了，必须换读端重启。"""
    _fake_ffmpeg8(tmp_path, monkeypatch)
    sup, sm, ch = _build(tmp_path, monkeypatch, None)

    async def run():
        await sup._tick()
        _age_codec_wait(sup, supervisor_mod.CODEC_WAIT_SEC + 1)
        await sup._tick()
        first = FakePipeline.instances[-1]
        ch["codec"] = "h265"
        await sup._tick()
        assert first.stopped
        await sup._tick()
        assert FakePipeline.instances[-1].codec == "h265"

    asyncio.run(run())
    sm.io.shutdown()


def test_codec_wait_restarts_when_source_goes_offline(tmp_path, monkeypatch):
    """等待计时只针对"本次在线"：源掉线再上线，重新计时，不把上次的等待算进来。"""
    _fake_ffmpeg8(tmp_path, monkeypatch)
    sup, sm, ch = _build(tmp_path, monkeypatch, None)

    async def run():
        await sup._tick()
        _age_codec_wait(sup, supervisor_mod.CODEC_WAIT_SEC + 1)
        ch["online"] = False
        await sup._tick()
        assert sup.state_of("ch1").codec_wait_since is None
        ch["online"] = True
        await sup._tick()
        assert FakePipeline.instances == []

    asyncio.run(run())
    sm.io.shutdown()


def test_recording_status_reports_hevc_admission_warnings(tmp_path, monkeypatch):
    _fake_ffmpeg8(tmp_path, monkeypatch)
    sup, sm, _ = _build(tmp_path, monkeypatch, "h265")
    asyncio.run(sup._tick())
    p = FakePipeline.instances[-1]

    p.fake_stats = {"codec": "h265", "noIdrSec": 15.0, "openGopAus": 0}
    s = sup.recording_status("ch1")
    assert s["recordingState"] == "recording" and s["codecWarning"] == "no_idr"
    assert "IDR" in s["recordingDetail"]

    p.fake_stats = {"codec": "h265", "noIdrSec": 1.0, "openGopAus": 3}
    s = sup.recording_status("ch1")
    assert s["codecWarning"] == "open_gop" and "开放 GOP" in s["recordingDetail"]

    p.fake_stats = {"codec": "h265", "noIdrSec": 1.0, "openGopAus": 0}
    s = sup.recording_status("ch1")
    assert s["codecWarning"] is None and s["recordingDetail"] == "正在录制"
    sm.io.shutdown()


def test_source_republish_restarts_reader_so_new_parameter_sets_are_used(tmp_path, monkeypatch):
    """相机断开重推（如 8K 改 4K、同为 H.265）：流媒体服务不会断开已连着的读端，
    读端会一直把首次连上时的旧参数集插在每个关键帧前，之后每段录像都是"旧参数集 +
    新画面"、播放黑屏（2026-09-30 大门口实测）。推流会话一换就必须重启读端。"""
    _fake_ffmpeg8(tmp_path, monkeypatch)
    sup, sm, ch = _build(tmp_path, monkeypatch, "h265")
    ch["publisherId"] = "pub-8k"

    async def run():
        await sup._tick()
        old = FakePipeline.instances[-1]
        ch["publisherId"] = "pub-4k"  # 同编码、新的推流会话
        await sup._tick()
        st = sup.state_of("ch1")
        assert old.stopped and st.proc is None and "重新推流" in st.detail
        await sup._tick()             # 不走退避，下一轮立即用新序列头拉起
        assert len(FakePipeline.instances) == 2 and st.state == "recording"
        await sup._tick()             # 新会话稳定：不再重启
        assert not FakePipeline.instances[-1].stopped and len(FakePipeline.instances) == 2

    asyncio.run(run())
    sm.io.shutdown()


def test_publisher_unknown_never_triggers_restart(tmp_path, monkeypatch):
    """暂时拿不到推流会话（流媒体接口抖动、源刚掉线）：不能据此重启。"""
    _fake_ffmpeg8(tmp_path, monkeypatch)
    sup, sm, ch = _build(tmp_path, monkeypatch, "h265")
    ch["publisherId"] = "pub-1"

    async def run():
        await sup._tick()
        ch["publisherId"] = None
        await sup._tick()
        assert not FakePipeline.instances[-1].stopped
        ch["publisherId"] = "pub-1"   # 抖动恢复，还是同一个会话
        await sup._tick()
        assert not FakePipeline.instances[-1].stopped and len(FakePipeline.instances) == 1

    asyncio.run(run())
    sm.io.shutdown()


def test_reader_started_before_publisher_known_adopts_first_seen(tmp_path, monkeypatch):
    """起录时还不知道会话：首次得知只补记（读端连的就是它），之后再变才重启。"""
    _fake_ffmpeg8(tmp_path, monkeypatch)
    sup, sm, ch = _build(tmp_path, monkeypatch, "h265")

    async def run():
        await sup._tick()
        first = FakePipeline.instances[-1]
        ch["publisherId"] = "pub-1"
        await sup._tick()
        assert not first.stopped
        ch["publisherId"] = "pub-2"
        await sup._tick()
        assert first.stopped

    asyncio.run(run())
    sm.io.shutdown()
