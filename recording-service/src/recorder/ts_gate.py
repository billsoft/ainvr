"""GOP 闸门（纯逻辑，无 IO）：MPEG-TS 解析 + 按完整 GOP 缓冲/丢弃/分段。

为什么需要它（设计见 docs/recording-write-backpressure-design-2026-09-24.md）：
存储写得慢时若让 ffmpeg 同步写文件拖慢读流，SRS 播放队列超限会 shrink——
整队清空只留编码头、不对齐 I 帧，录像出现"P 帧无参考"的花屏且完全静默。
闸门让读端永远及时读走，写不过来时由我们按完整 GOP 丢弃并精确计量。

- TsParser：增量解析 188 字节 TS 包；只用 C 级 bytes.find 定位 PAT/PMT/视频 PES
  起始包（每帧一个），不逐包循环，事件循环开销与码率基本无关。
  H.264：I 帧 = 视频 PES 起始包带 adaptation field 的 random_access_indicator
  （ffmpeg mpegts 封装对关键帧必置）。
  H.265：random_access_indicator 对 CRA 也置位，而从 CRA 切开会让新文件开头的 RASL
  帧缺参考而花屏，所以改为扫 NAL：只有首个 VCL 是 IDR（19/20）的帧才算关键帧。
  首个 VCL 前面有 VPS/SPS/PPS/SEI，常落在第 2、3 个 TS 包里、起始码也可能跨包——
  分类未完成的帧连同其后字节先留在 carry 里（上限 AU_SCAN_CAP），下次 feed 再判。
  同时记录参数集摘要：参数集变化后的第一个 IDR 标记 params_changed（fMP4 的 moov
  在文件头固定，闸门据此强制换文件）。设计：docs/h265-codec12-support-design-2026-09-29.md §7.2。
- TimeMapper：PTS（33 位回绕展开）→ 墙钟。锚点取近期 min(到达时间 − PTS)：
  实时到达的包取到最小值，读端刚连上时 SRS gop_cache 突发送来的旧 GOP
  不会把文件名/丢弃区间时间拉晚。
- GopGate：GOP 队列 + 两级上限。软上限：新到 GOP 整组丢弃，水位回落到
  low_ratio 以下才在下一个 I 帧恢复（滞回，丢弃成段而非碎片）；硬上限：单个
  超长 GOP 撑爆时截掉它的尾部。恢复写入必开新文件，文件内部没有时间空洞。
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Callable

TS = 188
PTS_WRAP = 1 << 33
VIDEO_TYPES = {0x1B: "h264", 0x24: "h265"}
ADTS_AAC = 0x0F
EVENTS_KEPT = 100
HEVC_IDR = (19, 20)             # IDR_W_RADL / IDR_N_LP：唯一允许的切段/恢复点
HEVC_OPEN_GOP = (16, 17, 18, 21)  # BLA / CRA：随机接入点但可能带 RASL，不作切点
HEVC_PARAMS = (32, 33, 34)      # VPS / SPS / PPS
AU_SCAN_CAP = 64 * 1024         # 一帧里找首个 VCL 最多看的载荷字节数


@dataclass
class VideoStart:
    offset: int          # 在本次 feed 返回的对齐块内的字节偏移（188 的倍数）
    key: bool            # H.264：RAI；H.265：首个 VCL 为 IDR
    pts: int | None      # 90kHz 原始 PTS（未展开回绕）
    params_changed: bool = False  # H.265：参数集变化后的第一个 IDR


def _aligned(block: bytes, pattern: bytes):
    i = block.find(pattern)
    while i >= 0:
        if i % TS == 0:
            yield i
            i = block.find(pattern, i + TS)
        else:
            i = block.find(pattern, i + 1)


def _psi_section(packet: bytes) -> bytes | None:
    afc = (packet[3] >> 4) & 3
    pos = 4 + (1 + packet[4] if afc in (2, 3) else 0)
    if pos >= TS:
        return None
    pos += 1 + packet[pos]  # pointer_field
    return packet[pos:] if pos < TS else None


def _parse_pts(packet: bytes) -> tuple[bool, int | None]:
    afc = (packet[3] >> 4) & 3
    key = False
    pos = 4
    if afc in (2, 3):
        alen = packet[4]
        key = alen > 0 and bool(packet[5] & 0x40)
        pos = 5 + alen
    pes = packet[pos:pos + 14]
    if len(pes) < 14 or pes[:3] != b"\x00\x00\x01" or not (pes[7] & 0x80):
        return key, None
    p = pes[9:14]
    pts = (((p[0] >> 1) & 0x07) << 30 | p[1] << 22 | (p[2] >> 1) << 15
           | p[3] << 7 | p[4] >> 1)
    return key, pts


class TsParser:
    def __init__(self) -> None:
        self._carry = b""
        self.lost_bytes = 0
        self.pmt_pid: int | None = None
        self.video_pid: int | None = None
        self.video_codec: str | None = None
        self.audio_adts = False
        self._pat: bytes | None = None
        self._pmt: bytes | None = None
        # H.265 诊断计数（运行时准入检查：开放 GOP、找不到 VCL 的帧）
        self.idr_aus = 0
        self.open_gop_aus = 0
        self.unknown_aus = 0
        self._param_sig: tuple[tuple[int, bytes], ...] | None = None
        self._params_dirty = False

    @property
    def psi_header(self) -> bytes:
        """新 writer 的输入前缀：最近一次的 PAT + PMT。"""
        return (self._pat or b"") + (self._pmt or b"")

    def _resync(self, buf: bytes) -> bytes:
        i = 0
        while i < len(buf):
            if buf[i] == 0x47 and (i + TS >= len(buf) or buf[i + TS] == 0x47):
                break
            i += 1
        self.lost_bytes += i
        return buf[i:]

    def feed(self, chunk: bytes) -> tuple[bytes, list[VideoStart]]:
        """→ (188 对齐的完整包块, 块内视频 PES 起始)。失步字节丢弃并计入 lost_bytes。

        H.265 下尚未分类完的帧（及其后字节）暂不返回，留到下次 feed/flush。
        """
        out, starts, rest = self._align(self._carry + chunk)
        if self.video_codec == "h265" and starts:
            out, starts, held = self._classify_hevc(out, starts, final=False)
            rest = held + rest
        self._carry = rest
        return out, starts

    def flush(self) -> tuple[bytes, list[VideoStart]]:
        """输入结束：交出所有留存的完整包，未分类完的帧按已有数据定案。"""
        out, starts, rest = self._align(self._carry)
        self._carry = b""
        self.lost_bytes += len(rest)
        if self.video_codec == "h265" and starts:
            out, starts, _ = self._classify_hevc(out, starts, final=True)
        return out, starts

    def _align(self, buf: bytes) -> tuple[bytes, list[VideoStart], bytes]:
        out = bytearray()
        starts: list[VideoStart] = []
        while True:
            if buf and buf[0] != 0x47:
                buf = self._resync(buf)
            n = len(buf) // TS
            if n == 0:
                break
            # 每个包头同步字节一次性 C 级检查：第一个非 0x47 处即失步点
            syncs = buf[0:n * TS:TS]
            good = n - len(syncs.lstrip(b"G"))
            block, buf = buf[:good * TS], buf[good * TS:]
            base = len(out)
            out += block
            starts += [VideoStart(s.offset + base, s.key, s.pts) for s in self._scan(block)]
            if good == n:
                break
        return bytes(out), starts, buf

    # ---------- H.265 帧分类 ----------

    def _classify_hevc(self, out: bytes, starts: list[VideoStart],
                       final: bool) -> tuple[bytes, list[VideoStart], bytes]:
        """逐帧定 key/params_changed；遇到数据不够判定的帧就在它的起点切开留存。"""
        kept: list[VideoStart] = []
        for s in starts:
            res = self._classify_au(out, s.offset, final)
            if res is None:
                return out[:s.offset], kept, out[s.offset:]
            kept.append(VideoStart(s.offset, res[0], s.pts, res[1]))
        return out, kept, b""

    def _classify_au(self, out: bytes, off: int, final: bool) -> tuple[bool, bool] | None:
        """从视频 PES 起始包往后收集载荷找首个 VCL。→ (是否 IDR, 参数集是否变化)；
        数据不够且未到流尾 → None。"""
        data = bytearray()
        nals: list[tuple[int, int]] = []  # (NAL 头在 data 中的位置, 类型)
        scan = 0
        first = True
        pos = off
        while pos + TS <= len(out):
            pkt = out[pos:pos + TS]
            pos += TS
            if (((pkt[1] & 0x1F) << 8) | pkt[2]) != self.video_pid:
                continue
            if pkt[1] & 0x40 and not first:
                break  # 下一帧的 PES 开始了：本帧没有 VCL
            afc = (pkt[3] >> 4) & 3
            if afc in (0, 2):
                first = False
                continue
            payload = pkt[4 + (1 + pkt[4] if afc == 3 else 0):]
            if first:
                first = False
                if len(payload) < 9 or payload[:3] != b"\x00\x00\x01":
                    self.unknown_aus += 1
                    return False, False
                payload = payload[9 + payload[8]:]
            data += payload
            i = data.find(b"\x00\x00\x01", scan)
            while i >= 0 and i + 3 < len(data):
                ntype = (data[i + 3] >> 1) & 0x3F
                nals.append((i + 3, ntype))
                if ntype <= 31:
                    return self._on_vcl(data, nals)
                scan = i + 3
                i = data.find(b"\x00\x00\x01", scan)
            if i >= 0:
                scan = i  # 起始码已到、NAL 头字节还没到
            else:
                scan = max(scan, len(data) - 2)
            if len(data) > AU_SCAN_CAP:
                self.unknown_aus += 1
                return False, False
        else:
            if not final:
                return None
        self.unknown_aus += 1
        return False, False

    def _on_vcl(self, data: bytearray, nals: list[tuple[int, int]]) -> tuple[bool, bool]:
        vcl_type = nals[-1][1]
        key = vcl_type in HEVC_IDR
        if vcl_type in HEVC_OPEN_GOP:
            self.open_gop_aus += 1
        # Transmuxers may prepend the same parameter sets several times or in
        # another order. Their repetition is not a decoder parameter change.
        params = set()
        for (start, ntype), (nxt, _) in zip(nals, nals[1:]):
            if ntype in HEVC_PARAMS:
                params.add((ntype, bytes(data[start:nxt - 3]).rstrip(b"\x00")))
        if params:
            sig = tuple(sorted(params))
            if self._param_sig is not None and sig != self._param_sig:
                self._params_dirty = True
            self._param_sig = sig
        changed = False
        if key:
            self.idr_aus += 1
            changed, self._params_dirty = self._params_dirty, False
        return key, changed

    def _scan(self, block: bytes) -> list[VideoStart]:
        for off in _aligned(block, b"\x47\x40\x00"):
            self._on_pat(block[off:off + TS])
        if self.pmt_pid is not None:
            pat = bytes([0x47, 0x40 | (self.pmt_pid >> 8), self.pmt_pid & 0xFF])
            for off in _aligned(block, pat):
                self._on_pmt(block[off:off + TS])
        starts: list[VideoStart] = []
        if self.video_pid is not None:
            pat = bytes([0x47, 0x40 | (self.video_pid >> 8), self.video_pid & 0xFF])
            for off in _aligned(block, pat):
                key, pts = _parse_pts(block[off:off + TS])
                starts.append(VideoStart(off, key, pts))
        return starts

    def _on_pat(self, packet: bytes) -> None:
        sec = _psi_section(packet)
        if not sec or len(sec) < 12 or sec[0] != 0x00:
            return
        self._pat = packet
        self.pmt_pid = ((sec[10] & 0x1F) << 8) | sec[11]

    def _on_pmt(self, packet: bytes) -> None:
        sec = _psi_section(packet)
        if not sec or len(sec) < 12 or sec[0] != 0x02:
            return
        self._pmt = packet
        end = min(len(sec), 3 + (((sec[1] & 0x0F) << 8) | sec[2]) - 4)
        i = 12 + (((sec[10] & 0x0F) << 8) | sec[11])
        video_pid = codec = None
        adts = False
        while i + 5 <= end:
            stype, pid = sec[i], ((sec[i + 1] & 0x1F) << 8) | sec[i + 2]
            if stype in VIDEO_TYPES and video_pid is None:
                video_pid, codec = pid, VIDEO_TYPES[stype]
            elif stype == ADTS_AAC:
                adts = True
            i += 5 + (((sec[i + 3] & 0x0F) << 8) | sec[i + 4])
        if video_pid is not None:
            self.video_pid, self.video_codec = video_pid, codec
        self.audio_adts = adts


class TimeMapper:
    """展开后的 PTS 秒 ↔ 墙钟秒。"""

    def __init__(self, window: float = 300.0) -> None:
        self.window = window
        self._ref: float | None = None  # 最近观测的展开 PTS（90kHz）
        self._mins: deque[tuple[float, float]] = deque()  # (arrival, arrival-pts) 单调递增

    def unwrap(self, raw: int) -> float:
        """无副作用：取与最近观测值最接近的回绕周期（B 帧乱序、回绕都成立）。"""
        if self._ref is None:
            return raw / 90000.0
        k = round((self._ref - raw) / PTS_WRAP)
        return (raw + k * PTS_WRAP) / 90000.0

    def observe(self, pts_sec: float, arrival: float) -> None:
        self._ref = pts_sec * 90000.0
        offset = arrival - pts_sec
        while self._mins and self._mins[-1][1] >= offset:
            self._mins.pop()
        self._mins.append((arrival, offset))
        while len(self._mins) > 1 and self._mins[0][0] < arrival - self.window:
            self._mins.popleft()

    def wall(self, pts_sec: float) -> float:
        if not self._mins:
            raise ValueError("尚无时间样本")
        return pts_sec + self._mins[0][1]


@dataclass
class Chunk:
    data: bytes
    new_file: bool = False
    file_pts: float | None = None  # new_file 时：该文件首个 GOP 的 PTS 秒
    pts: float | None = None       # 入队时最近的视频 PTS 秒（算积压时长）


class GopGate:
    def __init__(self, segment_seconds: float, soft_cap: int, hard_cap: int,
                 low_ratio: float = 0.5,
                 on_event: Callable[[dict], None] | None = None) -> None:
        self.segment_seconds = segment_seconds
        self.soft_cap = soft_cap
        self.hard_cap = max(hard_cap, soft_cap)
        self.low = int(soft_cap * low_ratio)
        self.on_event = on_event
        self.queue: deque[Chunk] = deque()
        self.queued_bytes = 0
        self.dropped_bytes = 0
        self.events: list[dict] = []
        self._accepting = False      # 当前 GOP 是否在写入（首个 I 帧之前为 False）
        self._file_pts: float | None = None
        self._force_new = True
        self._episode: dict | None = None
        self._last_pts: float | None = None
        self._first_pts: float | None = None
        self._last_key_pts: float | None = None
        # 正在接收、尚不完整的一帧：下一帧起始包到达才入队，队列里永远是整帧，
        # 截断/停止时写端拿到的最后一帧也完整可解码
        self._frame = bytearray()
        self._frame_meta: tuple[bool, float | None, float | None] = (False, None, None)

    @property
    def dropping(self) -> bool:
        return self._episode is not None

    def backlog_seconds(self) -> float:
        head = self.queue[0].pts if self.queue else None
        if head is None or self._last_pts is None:
            return 0.0
        return max(0.0, self._last_pts - head)

    def episode(self) -> dict | None:
        return dict(self._episode) if self._episode else None

    def seconds_since_key(self) -> float:
        """距最近一个关键帧（尚无则距首帧）的内容时长：H.265 源长时间无 IDR 时
        闸门不会开新文件，由上层据此报出原因。"""
        ref = self._last_key_pts if self._last_key_pts is not None else self._first_pts
        if ref is None or self._last_pts is None:
            return 0.0
        return max(0.0, self._last_pts - ref)

    def push(self, block: bytes, starts: list[VideoStart], mapper: TimeMapper) -> None:
        """调用方须先对 starts 逐个 mapper.observe（闸门只读映射）。"""
        pos = 0
        for s in starts:
            sec = mapper.unwrap(s.pts) if s.pts is not None else self._last_pts
            if sec is None:
                continue  # 无 PTS 的首帧无法定时，并入前一帧的数据
            self._data(block[pos:s.offset])
            pos = s.offset
            if s.key and s.params_changed:
                self._force_new = True  # 参数集变了：fMP4 头固定，必须换文件
            self._frame_start(sec, s.key, mapper)
            self._last_pts = sec
            if self._first_pts is None:
                self._first_pts = sec
            if s.key:
                self._last_key_pts = sec
        self._data(block[pos:])

    def finish(self, mapper: TimeMapper) -> None:
        """输入结束：最后一帧已完整（流到头了）入队；仍在丢弃中的段以最后 PTS 收口记账。"""
        self._flush_frame()
        if self._episode is not None and self._last_pts is not None:
            self._close_episode(self._last_pts, mapper)

    def discard_queue(self, mapper: TimeMapper, reason: str = "stopped") -> None:
        """停止时限内写不完的积压：丢弃也必须记账，绝不静默。

        积压的内容止于正在进行的丢弃段起点（其后的内容已由该段记过账），
        否则止于最新 PTS——两段区间不重叠、不重复计时。
        """
        end = self._episode["startPts"] if self._episode is not None else self._last_pts
        # 未完整的当前帧不能交给写端（半帧解码报错），同样计入丢弃
        partial, self._frame = len(self._frame), bytearray()
        self._accepting = False
        if self._episode is not None and self._last_pts is not None:
            self._close_episode(self._last_pts, mapper)
        if not self.queue:
            return
        start, n = self.queue[0].pts, self.queued_bytes + partial
        self.queue.clear()
        self.queued_bytes = 0
        self._open_episode(start, reason, mapper)
        self._episode["bytes"] += n
        self.dropped_bytes += n
        self._close_episode(end if end is not None else start, mapper)

    def pop(self, max_bytes: int = 1 << 20) -> Chunk | None:
        """取出一批待写数据：首块之后的同文件整帧合并到 max_bytes，减少写调用。"""
        if not self.queue:
            return None
        first = self.queue.popleft()
        parts, size = [first.data], len(first.data)
        while self.queue and not self.queue[0].new_file and size < max_bytes:
            nxt = self.queue.popleft()
            parts.append(nxt.data)
            size += len(nxt.data)
        self.queued_bytes -= size
        return Chunk(b"".join(parts), first.new_file, first.file_pts, first.pts)

    # ---------- 内部 ----------

    def _flush_frame(self) -> None:
        if not self._frame:
            return
        new_file, file_pts, pts = self._frame_meta
        data, self._frame = bytes(self._frame), bytearray()
        self.queue.append(Chunk(data, new_file, file_pts, pts))
        self.queued_bytes += len(data)

    def _frame_start(self, sec: float, key: bool, mapper: TimeMapper) -> None:
        self._flush_frame()  # 上一帧到此完整
        if key:
            self._gop_start(sec, mapper)
        elif self._accepting and self.queued_bytes >= self.hard_cap:
            # 单个超长 GOP 撑爆硬上限：从这一帧起截掉该 GOP 余下部分，
            # 已入队的头部（整帧）仍可解码；下一个 I 帧再判断恢复
            self._accepting = False
            self._open_episode(sec, "truncated", mapper)
        if self._accepting and not key:
            self._frame_meta = (False, None, sec)

    def _gop_start(self, sec: float, mapper: TimeMapper) -> None:
        if self._episode is not None:
            if self.queued_bytes <= self.low:
                self._close_episode(sec, mapper)
            else:
                self._episode["gops"] += 1
                self._accepting = False
                return
        elif self.queued_bytes >= self.soft_cap:
            self._open_episode(sec, "backlog", mapper)
            self._episode["gops"] += 1
            self._accepting = False
            return
        self._accepting = True
        new_file = (self._force_new or self._file_pts is None
                    or sec - self._file_pts >= self.segment_seconds)
        if new_file:
            self._file_pts = sec
            self._force_new = False
        self._frame_meta = (new_file, sec if new_file else None, sec)

    def _data(self, data: bytes) -> None:
        if not data:
            return
        if self._accepting:
            self._frame += data
        elif self._episode is not None:
            self._episode["bytes"] += len(data)
            self.dropped_bytes += len(data)
        # 否则：首个 I 帧之前的数据没有参考帧，静默丢弃

    def _open_episode(self, sec: float | None, reason: str, mapper: TimeMapper) -> None:
        self._episode = {"reason": reason, "startPts": sec, "gops": 0, "bytes": 0,
                         "startTs": self._wall_ms(sec, mapper)}

    def _close_episode(self, sec: float, mapper: TimeMapper) -> None:
        ep, self._episode = self._episode, None
        self._force_new = True  # 恢复点开新文件：文件内部不留时间空洞
        start = ep["startPts"] if ep["startPts"] is not None else sec
        event = {
            "reason": ep["reason"],
            "startTs": ep["startTs"],
            "endTs": self._wall_ms(sec, mapper),
            "droppedMs": max(0, int(round((sec - start) * 1000))),
            "gops": max(1, ep["gops"]),
            "bytes": ep["bytes"],
        }
        self.events.append(event)
        del self.events[:-EVENTS_KEPT]  # 仅留近期供诊断；持久记录走 on_event 入库
        if self.on_event is not None:
            self.on_event(event)

    @staticmethod
    def _wall_ms(sec: float | None, mapper: TimeMapper) -> int | None:
        if sec is None:
            return None
        try:
            return int(mapper.wall(sec) * 1000)
        except ValueError:
            return None
