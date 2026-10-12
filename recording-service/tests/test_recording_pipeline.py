"""录像管线端到端（真实 ffmpeg，lavfi 现场生成测试源）：

- 分段一帧不丢：各分段视频帧数、音频包数之和 = 源；每个文件零解码错误、首帧为关键帧；
- I 帧间隔任意（1s / 30s 长 GOP）、B 帧、open-GOP、H.265 同一路径；
- 写得慢：只按完整 GOP 丢弃并记账，留下的文件全部可正常解码；
- 写卡死 → stalled；写报错 → 管线结束并带原因；同名文件绝不覆盖。
"""
import asyncio
import glob
import json
import os
import shutil
import subprocess
import sys

import pytest

from recorder.ffmpeg_recorder import build_writer_command
from recorder.recording_pipeline import RecordingPipeline
from recorder.storage_io import IsolatedIO

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="需要 ffmpeg")

FPS = 25


def _make_ts(path, seconds, gop, codec="h264", bframes=2, open_gop=False):
    video = (["-c:v", "libx264", "-preset", "ultrafast", "-g", str(gop), "-keyint_min", str(gop),
              "-sc_threshold", "0", "-bf", str(bframes)]
             + (["-x264-params", "open-gop=1"] if open_gop else []))
    if codec == "h265":
        # x265 默认开放 GOP（周期关键帧是 CRA）；open_gop=False 时强制闭合 GOP（周期 IDR）
        video = ["-c:v", "libx265", "-preset", "ultrafast", "-x265-params",
                 f"keyint={gop}:min-keyint={gop}:scenecut=0:bframes={bframes}:"
                 f"open-gop={1 if open_gop else 0}:log-level=error"]
    subprocess.run(["ffmpeg", "-y", "-nostdin", "-loglevel", "error",
                    "-f", "lavfi", "-i", f"testsrc2=size=320x240:rate={FPS}",
                    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
                    "-t", str(seconds), *video, "-c:a", "aac", "-f", "mpegts", path], check=True)
    return path


def _count(path, stream):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", stream, "-count_packets",
                          "-show_entries", "stream=nb_read_packets", "-of", "json", path],
                         capture_output=True, text=True).stdout
    streams = json.loads(out or "{}").get("streams") or [{}]
    return int(streams[0].get("nb_read_packets") or 0)


def _decode_errors(path):
    r = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-f", "null", "-"],
                       capture_output=True, text=True)
    return r.returncode, r.stderr.strip()


def _video_tag(path):
    return subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                           "stream=codec_tag_string", "-of", "csv=p=0", path],
                          capture_output=True, text=True).stdout.strip()


def _first_is_key(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "packet=flags", "-of", "csv=p=0", "-read_intervals", "%+#1", path],
                         capture_output=True, text=True).stdout
    return out.strip().startswith("K")


def _run(tmp_path, src, *, segment_seconds=4, writer_cmd=None, soft_cap=64 << 20,
         hard_cap=96 << 20, stall_sec=60.0, until=None, timeout=90, clock=None, reader_cmd=None):
    events = []
    root = tmp_path / "videos"
    root.mkdir(exist_ok=True)
    io = IsolatedIO()

    async def go():
        p = RecordingPipeline(
            channel_id="ch-1", rtmp_url="unused", root=str(root),
            segment_seconds=segment_seconds, io=io, soft_cap=soft_cap, hard_cap=hard_cap,
            on_event=events.append, reader_cmd=reader_cmd or ["cat", src],
            writer_cmd=writer_cmd or build_writer_command, stall_sec=stall_sec, settle_sec=0,
            **({"clock": clock} if clock else {}))
        await p.start()
        t0 = asyncio.get_running_loop().time()
        while p.returncode is None:
            if until is not None and until(p):
                break
            if asyncio.get_running_loop().time() - t0 > timeout:
                raise AssertionError("管线超时未结束")
            await asyncio.sleep(0.05)
        return p, await p.stop(term_timeout=2, kill_timeout=2)

    try:
        p, stopped = asyncio.run(go())
    finally:
        io.shutdown()
    files = sorted(glob.glob(str(root / "*" / "*.mp4")))
    return p, stopped, files, events


@pytest.mark.parametrize("gop,codec,bframes", [
    (FPS, "h264", 2),        # 1s GOP + B 帧
    (FPS * 30, "h264", 0),   # 30s 长 GOP：分段只能在 I 帧切，一帧不丢
    (FPS * 2, "h265", 2),    # H.265 闭合 GOP：闸门按 IDR 切段，写端打 hvc1
])
def test_segments_conserve_every_frame_and_decode_cleanly(tmp_path, gop, codec, bframes):
    seconds = 70 if gop == FPS * 30 else 13
    src = _make_ts(str(tmp_path / "src.ts"), seconds, gop, codec, bframes)
    p, stopped, files, events = _run(tmp_path, src)
    assert stopped and p.error is None and events == []
    assert len(files) >= 2
    assert sum(_count(f, "v:0") for f in files) == _count(src, "v:0")
    # 音频：首个 I 帧之前的少量音频无视频可依附，属预期；其余全部守恒
    audio_src, audio_out = _count(src, "a:0"), sum(_count(f, "a:0") for f in files)
    assert 0 <= audio_src - audio_out <= 3
    for f in files:
        rc, err = _decode_errors(f)
        assert rc == 0 and err == "", (f, err)
        assert _first_is_key(f), f
    names = [os.path.basename(f) for f in files]
    assert names == sorted(set(names)) and all(n.startswith("ch-1_") for n in names)
    if codec == "h265":
        assert all(_video_tag(f) == "hvc1" for f in files)  # Safari/iPad 只播 hvc1


def test_open_gop_conserves_frames(tmp_path):
    """open-GOP：帧数守恒；切点后领头 B 帧引用上一 GOP，可能各坏 1~2 帧（设计文档已注明）。"""
    src = _make_ts(str(tmp_path / "src.ts"), 13, FPS, "h264", 2, open_gop=True)
    p, stopped, files, events = _run(tmp_path, src)
    assert stopped and p.error is None and len(files) >= 2
    assert sum(_count(f, "v:0") for f in files) == _count(src, "v:0")
    for f in files:
        assert _decode_errors(f)[0] == 0


def test_h265_open_gop_only_segments_on_idr_and_reports_it(tmp_path):
    """x265 默认开放 GOP：周期关键帧是 CRA。从 CRA 切开新文件开头的 RASL 缺参考会花屏，
    所以只在 IDR 切——整段只有开头一个 IDR 时只出一个文件，帧数守恒、全帧可解码，
    并把开放 GOP 报出来（设计 §2/§7.2）。"""
    src = _make_ts(str(tmp_path / "src.ts"), 13, FPS, "h265", 0, open_gop=True)
    p, stopped, files, events = _run(tmp_path, src, segment_seconds=4)
    assert stopped and p.error is None and events == []
    assert len(files) == 1
    assert _count(files[0], "v:0") == _count(src, "v:0")
    assert _decode_errors(files[0]) == (0, "")
    assert p.parser.open_gop_aus > 0 and p.stats()["openGopAus"] == p.parser.open_gop_aus


def test_last_frame_held_for_classification_is_flushed_at_eof(tmp_path):
    """H.265 帧分类未完成时字节暂留在解析器里：读端 EOF 必须交出，最后一帧不能丢。"""
    src = _make_ts(str(tmp_path / "src.ts"), 5, FPS, "h265", 0)
    p, stopped, files, _ = _run(tmp_path, src, segment_seconds=60)
    assert stopped and p.error is None and len(files) == 1
    assert _count(files[0], "v:0") == _count(src, "v:0")


def _throttled_writer(rate):
    throttle = ("import sys,time\nr=int(sys.argv[1])\ni=sys.stdin.buffer;o=sys.stdout.buffer\n"
                "while True:\n b=i.read(4096)\n if not b: break\n o.write(b);o.flush();time.sleep(len(b)/r)\n")

    def cmd(path, adts, codec=None):
        inner = " ".join(f"'{a}'" for a in build_writer_command(path, adts, codec))
        return ["sh", "-c", f"{sys.executable} -c \"$T\" {rate} | {inner}"]
    os.environ["T"] = throttle
    return cmd


def test_slow_storage_drops_whole_gops_and_accounts_them(tmp_path):
    src = _make_ts(str(tmp_path / "src.ts"), 20, FPS, "h264", 2)
    size = os.path.getsize(src)
    rate = size // 40  # 写入速度约为码率的一半
    p, stopped, files, events = _run(tmp_path, src, segment_seconds=60,
                                     writer_cmd=_throttled_writer(rate),
                                     soft_cap=size // 8, hard_cap=size // 2, timeout=120)
    assert stopped and p.error is None
    assert events, "写得慢必须按 GOP 丢弃并产生事件"
    for f in files:
        rc, err = _decode_errors(f)
        assert rc == 0 and err == "", (f, err)
        assert _first_is_key(f)
    written = sum(_count(f, "v:0") for f in files)
    dropped = sum(e["droppedMs"] for e in events) * FPS // 1000
    assert abs(written + dropped - _count(src, "v:0")) <= FPS  # 计量误差不超过 1 个 GOP
    assert all(e["reason"] in ("backlog", "truncated") for e in events)


def test_stopping_a_slow_writer_is_not_reported_as_write_error(tmp_path):
    """停止时我们主动终止写端（退出码 -15）不是存储写入报错。"""
    src = _make_ts(str(tmp_path / "src.ts"), 20, FPS, "h264", 2)
    p, stopped, files, events = _run(
        tmp_path, src, segment_seconds=60, writer_cmd=_throttled_writer(20_000),
        until=lambda p: len(p.files) >= 1 and p.gate.queued_bytes > 0)
    assert stopped is True
    assert p.error is None


def test_writer_that_accepts_nothing_is_reported_stalled(tmp_path):
    src = _make_ts(str(tmp_path / "src.ts"), 13, FPS)
    p, stopped, files, events = _run(
        tmp_path, src, writer_cmd=lambda path, adts, codec=None: ["sleep", "600"],
        soft_cap=64 << 20, stall_sec=1.0, until=lambda p: p.stalled())
    assert p.stalled() or stopped  # 触发时刻已判定卡死；停止必须有界完成
    assert stopped is True


def test_writer_error_ends_pipeline_with_reason(tmp_path):
    src = _make_ts(str(tmp_path / "src.ts"), 13, FPS)
    p, stopped, files, events = _run(
        tmp_path, src, writer_cmd=lambda path, adts, codec=None: ["sh", "-c", "exec 0<&-; exit 3"])
    assert p.returncode is not None and p.error and "写入" in p.error


class CountingIO:
    """记录存储车道调用次数：换文件不能每次都在共享车道上 stat NAS。"""

    def __init__(self):
        self.ops = {}

    async def run(self, fn, *args, timeout, op="io", **kwargs):
        self.ops[op] = self.ops.get(op, 0) + 1
        return fn(*args, **kwargs)


def test_rotation_touches_shared_storage_lane_only_for_first_file(tmp_path):
    src = _make_ts(str(tmp_path / "src.ts"), 13, FPS)
    root = tmp_path / "videos"
    root.mkdir()
    io = CountingIO()

    async def go():
        p = RecordingPipeline(channel_id="ch-1", rtmp_url="unused", root=str(root),
                              segment_seconds=2, io=io, soft_cap=64 << 20, hard_cap=96 << 20,
                              reader_cmd=["cat", src], settle_sec=0)
        await p.start()
        while p.returncode is None:
            await asyncio.sleep(0.05)
        return p

    p = asyncio.run(go())
    assert len(p.files) >= 4
    assert io.ops.get("segment-exists") == 1  # 只有重启后的首个文件可能与上一条管线撞名
    assert io.ops.get("mkdir-day") == 1
    # 连续运行数周：每分段的写端任务结束即释放，不随分段数累积
    assert not p._writer_logs and not p._reap_tasks and len(p._tasks) == 3


def test_midnight_rollover_splits_days_without_restart_or_loss(tmp_path):
    import time
    from datetime import datetime
    src = _make_ts(str(tmp_path / "src.ts"), 12, FPS)
    base, t0 = datetime(2026, 9, 24, 23, 59, 55).timestamp(), time.monotonic()
    # 实时节奏送流，墙钟从 23:59:55 走起：内容时间自然跨过 00:00
    p, stopped, files, events = _run(
        tmp_path, src, segment_seconds=4, clock=lambda: base + time.monotonic() - t0,
        reader_cmd=["ffmpeg", "-nostdin", "-loglevel", "error", "-re", "-i", src,
                    "-map", "0", "-c", "copy", "-f", "mpegts", "pipe:1"])
    assert stopped and p.error is None and events == []
    days = {os.path.basename(os.path.dirname(f)) for f in files}
    assert days == {"20260924", "20260925"}
    assert sum(_count(f, "v:0") for f in files) == _count(src, "v:0")


def test_never_overwrites_an_existing_segment(tmp_path):
    src = _make_ts(str(tmp_path / "src.ts"), 9, FPS)
    fixed = lambda: 1_790_000_000.0  # noqa: E731 两次运行映射出完全相同的候选文件名
    p, _, files, _ = _run(tmp_path, src, segment_seconds=60, clock=fixed)
    first = files[0]
    before = os.path.getsize(first)
    # 同一内容再录一遍：必须避让，绝不覆盖
    p2, _, files2, _ = _run(tmp_path, src, segment_seconds=60, clock=fixed)
    assert os.path.getsize(first) == before
    assert len(files2) == len(files) + 1
