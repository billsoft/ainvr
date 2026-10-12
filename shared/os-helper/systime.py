"""
系统日期时间与局域网对时服务器（2026-10-09）

板子没有时钟备用电池：断电后硬件时钟清零，开机靠"上次保存时间"+联网对时。
离线现场对不上时，由系统设置页手动校时，或指向现场的局域网对时服务器。

- 校时：先关网络对时（开着时系统拒绝手动改时间）→ 设时间 → 写回硬件时钟（装了
  电池才有用，失败不致命）→ 重新打开网络对时（以后联网仍以网络时间为准）→
  重启正在运行的录像与 AI，让文件名/识别记录从新时间起保持一致（被人主动停掉的不拉起）。
- 时间范围 2026-01-01 ～ 2100-01-01：授权按"系统时间只快进"计费，年份打错到
  未来会一次性消耗授权，前端另有与电脑时间相差过大的二次确认。
- 对时服务器写成 systemd-timesyncd 的 drop-in（NTP=），清空即删除，回到默认公网池。
"""
from __future__ import annotations

import ipaddress
import logging
import os
import re
import subprocess
import time
from pathlib import Path

MIN_VALID_EPOCH = 1767225600  # 2026-01-01T00:00:00Z，与授权服务的可信下限一致
MAX_VALID_EPOCH = 4102444800  # 2100-01-01T00:00:00Z
MAX_NTP_SERVERS = 5
RESTART_UNITS = (("ainvr-recorder.service", "录像服务"), ("ai-service.service", "AI 识别服务"))
RUNNING_STATES = {"active", "activating", "reloading"}

_HOST_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
_HOST_RE = re.compile(rf"^{_HOST_LABEL}(?:\.{_HOST_LABEL})*$")


class SysTimeError(Exception):
    pass


def _valid_server(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return len(value) <= 253 and bool(_HOST_RE.match(value))


class SystemTime:
    def __init__(self, run=subprocess.run,
                 conf_path: Path = Path("/etc/systemd/timesyncd.conf.d/ainvr-ntp.conf"),
                 marker_path: Path = Path("/run/ainvr-time-set"),
                 clock=time.time):
        self._run = run
        self.conf_path = Path(conf_path)
        # /run 是内存盘：标记"本次开机已人工校时"，重启后自然清除
        self.marker_path = Path(marker_path)
        self._clock = clock

    def _cmd(self, *args: str, timeout: int = 20) -> str:
        try:
            p = self._run(list(args), capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as e:
            raise SysTimeError(f"命令超时：{args[0]}") from e
        if p.returncode != 0:
            raise SysTimeError((p.stderr or p.stdout or f"{args[0]} 执行失败").strip())
        return p.stdout or ""

    def _read_servers(self) -> list[str]:
        try:
            text = self.conf_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        for line in text.splitlines():
            if line.startswith("NTP="):
                return line[len("NTP="):].split()
        return []

    def status(self) -> dict:
        props: dict[str, str] = {}
        try:
            out = self._cmd("timedatectl", "show", "-p", "NTP", "-p", "NTPSynchronized", "-p", "Timezone")
            for line in out.splitlines():
                key, _, value = line.partition("=")
                props[key] = value.strip()
        except SysTimeError:
            logging.warning("读取系统对时状态失败")
        now = self._clock()
        return {
            "epoch_ms": int(now * 1000),
            "timezone": props.get("Timezone", ""),
            "ntp_enabled": props.get("NTP") == "yes",
            "ntp_synchronized": props.get("NTPSynchronized") == "yes",
            "manually_set": self.marker_path.exists(),
            "valid": now >= MIN_VALID_EPOCH,
            "min_valid_epoch_ms": MIN_VALID_EPOCH * 1000,
            "ntp_servers": self._read_servers(),
        }

    def set_time(self, epoch_ms) -> dict:
        if isinstance(epoch_ms, bool) or not isinstance(epoch_ms, int):
            raise SysTimeError("时间格式无效")
        if not MIN_VALID_EPOCH * 1000 <= epoch_ms <= MAX_VALID_EPOCH * 1000:
            raise SysTimeError("时间必须在 2026-01-01 到 2100-01-01 之间")
        self._cmd("timedatectl", "set-ntp", "false")
        try:
            self._cmd("date", "-u", "-s", f"@{epoch_ms // 1000}.{epoch_ms % 1000:03d}")
        finally:
            # 无论成败都恢复网络对时：以后能联网时仍以网络时间为准
            self._cmd("timedatectl", "set-ntp", "true")
        try:
            self._cmd("hwclock", "--systohc", "--utc")
        except SysTimeError:
            logging.warning("写回硬件时钟失败（不影响本次校时）")
        self.marker_path.write_text(str(epoch_ms), encoding="utf-8")
        logging.info("系统时间已手动校准为 epoch_ms=%d", epoch_ms)
        # 只重启正在运行的：调试/维护时被人主动停掉的服务，restart 会把它拉起来
        running = [(unit, name) for unit, name in RESTART_UNITS if self._running(unit)]
        if running:
            self._cmd("systemctl", "--no-block", "restart", *(unit for unit, _ in running))
        return {**self.status(), "restarted": [name for _, name in running]}

    def _running(self, unit: str) -> bool:
        """active / 正在启动（含崩溃后等待自动重启）算运行中；查不到状态按运行中处理。"""
        try:
            p = self._run(["systemctl", "show", "-p", "ActiveState", "--value", unit],
                          capture_output=True, text=True, timeout=5)
        except subprocess.TimeoutExpired:
            return True
        if p.returncode != 0:
            return True
        return (p.stdout or "").strip() in RUNNING_STATES

    def set_ntp_servers(self, servers) -> dict:
        if not isinstance(servers, list) or len(servers) > MAX_NTP_SERVERS:
            raise SysTimeError(f"对时服务器最多 {MAX_NTP_SERVERS} 个")
        cleaned: list[str] = []
        for s in servers:
            if not isinstance(s, str) or not _valid_server(s.strip()):
                raise SysTimeError(f"对时服务器地址无效：{s}")
            if s.strip() not in cleaned:
                cleaned.append(s.strip())
        if cleaned:
            self.conf_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.conf_path.with_suffix(".tmp")
            tmp.write_text("[Time]\nNTP=" + " ".join(cleaned) + "\n", encoding="utf-8")
            os.replace(tmp, self.conf_path)
        else:
            self.conf_path.unlink(missing_ok=True)
        self._cmd("systemctl", "restart", "systemd-timesyncd")
        self._cmd("timedatectl", "set-ntp", "true")
        logging.info("对时服务器已设置: %s", " ".join(cleaned) or "（默认）")
        return self.status()
