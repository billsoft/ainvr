"""录像用 ffmpeg 子进程：读端（RTMP→TS 管道）、写端（TS 管道→fMP4 文件）、有界停止。

读写拆成两类进程，中间由 GopGate 按完整 GOP 缓冲/丢弃（见 recording_pipeline.py）：
读端永远及时读走，存储写得慢也不会拖慢 SRS 播放队列（SRS 超限 shrink 不对齐
I 帧，会造成花屏且静默）。已在 ffmpeg 4.4.2 实测：任意 I 帧处切开分别封装，
帧数守恒、首帧为关键帧。
"""
from __future__ import annotations

import asyncio
import os

from .logging_setup import get_logger

log = get_logger("recorder.ffmpeg")

# 写端每个文件开头都会报一次（H.264 buffering period SEI 早于 SPS），无害；
# 不过滤会每路每分钟刷一条日志。
BENIGN_STDERR = ("non-existing SPS", "Last message repeated")


# H.265 读端：系统 FFmpeg 4.4 读不了 FLV 里的 HEVC（codec12 / Enhanced 都不行），
# 用安装时从 SRS 镜像提取并校验过的 8.1.2（install.sh::ensure_ffmpeg8 → thirdparty_images.py ffmpeg8）。
# 264 仍走系统 ffmpeg，行为不变。
FFMPEG8 = os.environ.get("RECORDER_FFMPEG8", "/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg")


def reader_binary(codec: str | None) -> str:
    return FFMPEG8 if codec == "h265" else "ffmpeg"


def build_reader_command(rtmp_url: str, codec: str | None = None) -> list[str]:
    return [
        reader_binary(codec), "-hide_banner", "-nostdin", "-loglevel", "warning",
        "-rw_timeout", "15000000",
        "-rtmp_live", "live",
        "-fflags", "+genpts",
        "-i", rtmp_url,
        "-map", "0:v:0", "-map", "0:a?",
        "-c", "copy",
        "-f", "mpegts", "pipe:1",
    ]


def build_writer_command(path: str, audio_adts: bool, codec: str | None = None) -> list[str]:
    cmd = [
        "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error",
        # -n：同名文件已存在即失败，绝不覆盖已完成的录像
        "-n",
        "-f", "mpegts", "-i", "pipe:0",
        "-map", "0:v:0", "-map", "0:a?",
        "-c", "copy",
    ]
    if audio_adts:
        # ffmpeg 4.4 的 mp4 封装不会自动把 ADTS AAC 转成 ASC（实测报错退出）
        cmd += ["-bsf:a", "aac_adtstoasc"]
    if codec == "h265":
        # ffmpeg 默认写 hev1（参数集在帧内），Safari/iPad 只播 hvc1
        cmd += ["-tag:v", "hvc1"]
    cmd += [
        "-f", "mp4",
        # fMP4：moov 在头、每关键帧一个 fragment；崩溃只丢最后一个 fragment
        # Wait for the first fragment so the moov can represent starting A/V
        # offsets and negative video DTS. An immediate empty_moov clamps the
        # first timestamp and loses the original audio/video timing offset.
        "-movflags", "frag_keyframe+empty_moov+default_base_moof+delay_moov",
        path,
    ]
    return cmd


async def drain_stderr(stream, label: str) -> None:
    try:
        while True:
            line = await stream.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").strip()
            if text and not any(b in text for b in BENIGN_STDERR):
                log.warning("[%s] %s", label, text)
    except asyncio.CancelledError:
        raise


async def stop_processes(procs, term_timeout: float = 5.0,
                         kill_timeout: float = 3.0) -> bool:
    """有界停止一组子进程：SIGTERM→等→SIGKILL→再等。

    返回 True：全部已退出；False：SIGKILL 后仍有进程未退出（卡在 NAS 写入的
    D 状态，SIGKILL 也要等系统调用返回才生效）。False 时调用方**禁止继续 await**，
    应转入 orphan 集合并阻止同通道拉起新进程（防两个写者写同一文件）。
    2026-09 事故前这里是无超时 wait：一个卡死的 ffmpeg 就能挂死整个监督器。
    """
    alive = [p for p in procs if p is not None and p.returncode is None]
    for p in alive:
        try:
            p.terminate()
        except ProcessLookupError:
            pass
    if await _wait_all(alive, term_timeout):
        return True
    for p in alive:
        if p.returncode is None:
            try:
                p.kill()
            except ProcessLookupError:
                pass
    if await _wait_all(alive, kill_timeout):
        return True
    for p in alive:
        if p.returncode is None:
            log.error("ffmpeg pid=%s SIGKILL 后 %.0fs 仍未退出，疑似内核 D 状态"
                      "（进程未退出，需结合存储与阻塞栈诊断）；转入 orphan 后台收尸", p.pid, kill_timeout)
    return False


async def _wait_all(procs, timeout: float) -> bool:
    pending = [p for p in procs if p.returncode is None]
    if not pending:
        return True
    try:
        await asyncio.wait_for(asyncio.gather(*(p.wait() for p in pending)), timeout)
        return True
    except asyncio.TimeoutError:
        return all(p.returncode is not None for p in procs)
