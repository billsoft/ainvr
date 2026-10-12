"""文件名/时间工具——规则必须与前端 utils/recording.ts 保持一致。

## 为什么通道名只保留 ASCII / 拼音，不要直接写中文

历史教训（2026-09 "毒文件"事件）：
1. Jetson Tegra 内核的 cifs.ko 没有编 nls_utf8.ko，显式加 iocharset=utf8
   会 mount error(79)；不加的话不同内核版本/服务端组合下中文文件名编码不稳。
2. Windows 资源管理器访问某些 UTF-8 多字节序列组成的长路径时会进入
   不可中断睡眠（D 状态），Linux 侧 ffprobe / ls 同样可能挂死——
   这就是"一碰就死的毒文件"。
3. 即使 Linux 侧 UTF-8 正常，Windows 侧默认按 GBK/Latin-1 读 SMB 文件名
   也会出现 mojibake（如 `_大门口_` → `_å¤§é¨å£_`）。

根治办法：磁盘文件名一律 ASCII-only。通道名（中文）只在 UI 上展示，
不落到磁盘文件名里。文件前缀用 `<channelId>` 足够区分不同通道，
且 channelId 本身就是 ASCII（UUID 或英文 slug）。
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta

_INVALID_PART = re.compile(r"[\\/:*?\"<>|\s]+")
# 磁盘文件名只允许 ASCII 可打印字符（排除控制字符与空格），其余一律替换为下划线。
# 范围：0x21(!) - 0x7E(~)，但把路径非法字符提前交给 _INVALID_PART 处理。
_NON_ASCII_PART = re.compile(r"[^\x21-\x7E]+")


def sanitize_file_part(part: str) -> str:
    """非法字符、空白与非 ASCII 字符 → 下划线；空 → 'channel'。

    与前端 utils/recording.ts sanitizeFilePart 完全同语义（不 strip 下划线）。
    额外保证结果为纯 ASCII，避免 SMB/CIFS 跨平台编码乱码与"毒文件"。
    """
    step1 = _INVALID_PART.sub("_", (part or "").strip())
    step2 = _NON_ASCII_PART.sub("_", step1)
    return step2 or "channel"


def file_key(channel_id: str, channel_name: str) -> str:
    """文件前缀：<channelId>（通道名仅作 UI 展示，不落磁盘。

    历史版本曾把通道名拼进文件名（`<channelId>_<通道名>`），但中文通道名
    在 SMB NAS 上会触发编码乱码与 D 状态挂死的"毒文件"问题，故移除。
    channelId 本身全局唯一且为 ASCII，足以区分不同通道。
    """
    return sanitize_file_part(channel_id)


def segment_filename(channel_id: str, channel_name: str, ts: datetime) -> str:
    return f"{file_key(channel_id, channel_name)}_{ts.strftime('%Y%m%d_%H%M%S')}.{ts.microsecond // 1000:03d}.mp4"


_FN_RE = re.compile(r"^(?P<key>.+)_(?P<date>\d{8})_(?P<time>\d{6})(?:\.(?P<ms>\d{3}))?\.mp4$")


def parse_segment_filename(name: str) -> tuple[str, datetime] | None:
    """→ (文件前缀 key, 起始墙钟时间)；不符合命名规则返回 None。"""
    m = _FN_RE.match(name)
    if not m:
        return None
    try:
        ts = datetime.strptime(m.group("date") + m.group("time"), "%Y%m%d%H%M%S")
    except ValueError:
        return None
    ts = ts.replace(microsecond=int(m.group("ms") or 0) * 1000)
    return m.group("key"), ts


def segment_time_precision_ms(name: str) -> int:
    match = _FN_RE.match(name)
    return (1 if match.group("ms") is not None else 1000) if match else 0


def day_dir(ts: datetime) -> str:
    return ts.strftime("%Y%m%d")


def start_of_day(ts: datetime | None = None) -> datetime:
    ts = ts or datetime.now()
    return ts.replace(hour=0, minute=0, second=0, microsecond=0)


def ms_between(a: datetime, b: datetime) -> int:
    return int((b - a).total_seconds() * 1000)


def today_range_ms() -> tuple[int, int]:
    now = datetime.now()
    s = start_of_day(now)
    return int(s.timestamp() * 1000), int(now.timestamp() * 1000)


def fmt_clock(ms: int) -> str:
    s = max(0, ms // 1000)
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}"


def retention_days(oldest_ts_ms: int | None, now_ms: int | None = None) -> int | None:
    if oldest_ts_ms is None:
        return None
    now_ms = now_ms or int(datetime.now().timestamp() * 1000)
    days = (now_ms - oldest_ts_ms) // 86_400_000
    return max(0, days)
