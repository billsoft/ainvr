"""V2 verified activation deadlines, measured with the internal clock."""
from __future__ import annotations
import base64
import hashlib
import hmac
import json
import logging
import os
import pwd
import re
from pathlib import Path
import secrets
import socket
import struct
import threading
import time
from typing import Callable, Optional

logger = logging.getLogger(__name__)
DEFAULT_UDS_PATH = "/run/ainvr-license/license.sock"
SIGNED_STATUS_PATH = "/api/v1/license/signed-status"
# 明确的停止信号：到期/未授权，以及时钟异常与被篡改（线上状态名 recovery_required）这类攻击信号，立即清除已验证截止。
# 存储故障（storage_error）可能只是磁盘卡顿，仍只降级、不清除。
STOP_STATES = ("unlicensed", "expired", "clock_error", "recovery_required")
VALID_STATES = {"valid", "unlicensed", "expired", "recovery_required", "storage_error", "clock_error"}
MAX_RESPONSE = 16384
FAILURE_LOG_INTERVAL = 30.0   # 连续失败时的日志限频：首次立即记，之后每 30 秒一条摘要
RETRY_AFTER_FAILURE = 1.0     # 失败后的重试间隔：租约最长 30 秒，不能干等一个 5 秒周期
# 已验证的激活截止时间决定业务权限；续查故障不延长该截止时间。
SHORT_LEASE_MS = 10000

SLOW_REQUEST = 1.0            # 单次请求超过这个耗时就值得记一笔


class LicenseSignalError(RuntimeError):
    pass


def elapsed_clock() -> float:
    """Includes suspend; conservative even if the wall clock is stepped back."""
    return max(time.clock_gettime(time.CLOCK_BOOTTIME), time.monotonic())


def load_env_file(path: str) -> None:
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _verify_peer(sock: socket.socket) -> None:
    pid, uid, _ = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    # Authority identity is independent of the consumer (recorder runs as root).
    try:
        authority_uid = pwd.getpwnam("sunrise").pw_uid
    except KeyError as exc:
        raise LicenseSignalError("license service account missing") from exc
    if pid <= 0 or uid != authority_uid:
        raise LicenseSignalError("untrusted UDS peer")
    exe = os.path.basename(os.readlink(f"/proc/{pid}/exe"))
    # Atomic replacement unlinks the old inode; it does not change its identity.
    if exe.endswith(" (deleted)"):
        exe = exe[:-10]
    cgroup = Path(f"/proc/{pid}/cgroup").read_text()
    in_service = any(line.split(":", 2)[-1].rstrip("/").split("/")[-1]
                     == "ainvr-license.service" for line in cgroup.splitlines())
    if exe != "license_service" or not in_service:
        raise LicenseSignalError("untrusted license service process")


def _http_request_uds(uds_path: str, query: str, timeout: float, verify_peer: bool = True) -> tuple[int, bytes]:
    deadline = time.monotonic() + timeout
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect(uds_path)
        if verify_peer:
            _verify_peer(sock)  # verify the connection that actually carries the response
        sock.sendall(f"GET {query} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".encode())
        raw = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LicenseSignalError("license request deadline exceeded")
            sock.settimeout(remaining)
            part = sock.recv(min(4096, MAX_RESPONSE + 1 - len(raw)))
            if not part:
                break
            raw.extend(part)
            if len(raw) > MAX_RESPONSE:
                raise LicenseSignalError("license response too large")
    head, sep, body = bytes(raw).partition(b"\r\n\r\n")
    if not sep:
        raise LicenseSignalError("invalid HTTP response")
    first = head.split(b"\r\n", 1)[0].split()
    if len(first) < 2:
        raise LicenseSignalError("invalid HTTP status")
    lengths = [v.strip() for line in head.split(b"\r\n")[1:] for k, _, v in [line.partition(b":")] if k.lower() == b"content-length"]
    if len(lengths) != 1 or not lengths[0].isdigit() or int(lengths[0]) != len(body):
        raise LicenseSignalError("invalid HTTP content length")
    return int(first[1]), body


def normalize_device(value: str) -> str:
    return value.upper().replace("-", "").replace(" ", "")


def verify_envelope(envelope: dict, key: bytes, device: str, audience: str, nonce: str) -> dict:
    encoded, sig = envelope["payload"], envelope["sig"]
    if not isinstance(encoded, str) or len(encoded) > 12000 or not isinstance(sig, str):
        raise LicenseSignalError("invalid envelope")
    expected = hmac.new(key, ("AINVR/lease/v2|" + encoded).encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        raise LicenseSignalError("invalid signature")
    raw = base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True)
    p = json.loads(raw)
    if p.get("v") != 2 or p.get("device_id") != device or p.get("audience") != audience or p.get("nonce") != nonce:
        raise LicenseSignalError("lease binding mismatch")
    if p.get("state") not in VALID_STATES:
        raise LicenseSignalError("unknown license state")
    for field, upper in (("lease_ms", 30000), ("remaining_seconds", 315360000), ("revision", 9007199254740991), ("grant_seq", 9007199254740991)):
        if type(p.get(field)) is not int or not 0 <= p[field] <= upper:
            raise LicenseSignalError("invalid lease number")
    if p["lease_ms"] > p["remaining_seconds"] * 1000 or (p["state"] != "valid" and p["lease_ms"]):
        raise LicenseSignalError("invalid lease budget")
    if not isinstance(p.get("epoch"), str) or len(p["epoch"]) != 32:
        raise LicenseSignalError("invalid epoch")
    if not isinstance(p.get("license_id"), str) or len(p["license_id"]) not in (0, 32) or (p["state"] in ("valid", "expired") and not re.fullmatch(r"[0-9a-f]{32}", p["license_id"])):
        raise LicenseSignalError("invalid license identity")
    if "authorization_ms" in p:
        value = p["authorization_ms"]
        if type(value) is not int or not 0 <= value <= p["remaining_seconds"] * 1000:
            raise LicenseSignalError("invalid authorization duration")
    return p


class LicenseSignalClient:
    def __init__(self, client_id: str, key: bytes, *, device_id: str = "",
                 uds_path: str = DEFAULT_UDS_PATH, poll_interval: float = 5,
                 timeout: float = 3, verify_peer: bool = True,
                 clock: Callable[[], float] = elapsed_clock, on_change=None,
                 transport=None, configuration_error: str = "",
                 retain_verified_grant: bool = True, **_obsolete):
        self.client_id = client_id
        self.key = key
        self.device_id = normalize_device(device_id)
        self._uds_path = uds_path
        self._poll_interval = min(5.0, max(.1, poll_interval))
        self._timeout = min(5.0, max(.1, timeout))
        self._verify_peer = verify_peer
        self._clock = clock
        self._on_change = on_change
        self._transport = transport
        self._lock = threading.RLock()
        self._challenge_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._last_payload = None
        self._deadline = 0.0
        self._last_contact = None
        self._last_error = configuration_error
        self._last_attempt_ok = True
        self._failures = 0                     # 连续失败次数
        self._first_failure_at = None          # 本轮故障开始时刻（时钟）
        self._last_success_at = None
        self._last_failure_log = None
        self._last_duration = 0.0
        self._config_error = configuration_error or (
            "" if len(key) == 32 and len(self.device_id) == 24 else "device credentials missing")
        self._phase = "starting"
        self._retain_verified_grant = retain_verified_grant
        self._was_degraded = False
        self._short_since = None               # 开始连续收到"短租约"的时刻
        self._licensed_until = 0.0             # 签名里的总授权剩余折算成的截止时刻：业务不能越过它
        self._last_took = 0.0                  # 最近一次成功请求的往返耗时

    def challenge_once(self) -> dict:
        with self._challenge_lock:  # no out-of-order replies across activations
            if self._config_error:
                raise LicenseSignalError(self._config_error)
            started = self._clock()
            nonce = secrets.token_hex(16)
            query = f"{SIGNED_STATUS_PATH}?client_id={self.client_id}&nonce={nonce}"
            if self._transport:
                status, body = self._transport(query)
            else:
                status, body = _http_request_uds(self._uds_path, query, self._timeout, self._verify_peer)
            if status != 200:
                raise LicenseSignalError(f"license HTTP {status}")
            p = verify_envelope(json.loads(body), self.key, self.device_id, self.client_id, nonce)
            with self._lock:
                self._last_payload = p
                # Anchor at request send, never response receipt.
                self._deadline = started + p["lease_ms"] / 1000
                self._last_contact = self._clock()
                self._last_took = self._last_contact - started
                if p["state"] == "valid":
                    self._licensed_until = started + p.get("authorization_ms", max(0, p["remaining_seconds"] - 1) * 1000) / 1000
                elif p["state"] in STOP_STATES:
                    self._licensed_until = 0.0
                self._last_error = ""
                if p["state"] == "valid" and p["lease_ms"] < SHORT_LEASE_MS:
                    if self._short_since is None:
                        self._short_since = self._last_contact
                else:
                    self._short_since = None
            return p

    def phase(self) -> str:
        with self._lock:
            if self._config_error:
                return "configuration_error"
            if self._last_payload is None:
                return "starting"
            if self._last_payload["state"] in STOP_STATES:
                return "invalid"
            try:
                now = self._clock()
                if (self._last_payload["state"] == "valid" and now < self._deadline) or self._retains_grant(now):
                    return "valid"
                if self._last_payload["state"] != "valid" and not self._licensed_until:
                    return "starting"
                return "dormant"
            except Exception:
                return "dormant"

    def _retains_grant(self, now: float) -> bool:
        """Retain only a verified grant until its original internal deadline.
        Transport/storage failures never extend this deadline. Signed stop states
        clear it immediately; disabling retention is for isolated strict tests.
        """
        return self._retain_verified_grant and now < self._licensed_until

    def degraded(self) -> bool:
        with self._lock:
            try:
                return self._last_payload is not None and self._clock() >= self._deadline and self._retains_grant(self._clock())
            except Exception:
                return False

    def is_licensed(self) -> bool:
        return self.phase() == "valid"

    def status(self) -> dict:
        with self._lock:
            try:
                remaining = max(0, int((self._deadline - self._clock()) * 1000))
            except Exception:
                remaining = 0
            return {**(self._last_payload or {}), "phase": self.phase(), "degraded": self.degraded(),
                    "last_error": self._last_error or self._config_error,
                    "lease_remaining_ms": remaining}

    def _lease_remaining(self) -> float:
        try:
            return max(0.0, self._deadline - self._clock())
        except Exception:
            return 0.0

    def decision_diagnostics(self) -> dict:
        """Sanitized snapshot of the inputs used by permission decisions."""
        with self._lock:
            try:
                now = self._clock()
            except Exception:
                now = None
            p = self._last_payload or {}
            return {"client": self.client_id, "phase": self.phase(),
                    "wall_sec": time.time(), "internal_sec": now,
                    "lease_deadline_sec": self._deadline,
                    "licensed_until_sec": self._licensed_until,
                    "last_contact_sec": self._last_contact,
                    "short_since_sec": self._short_since,
                    "retain_verified_grant": self._retain_verified_grant,
                    "last_request_seconds": self._last_took,
                    "consecutive_failures": self._failures,
                    "last_error": self._last_error or self._config_error,
                    "signed_state": p.get("state"), "signed_lease_ms": p.get("lease_ms"),
                    "signed_remaining_seconds": p.get("remaining_seconds"),
                    "authority_reason": p.get("reason"),
                    "authority": p.get("diagnostics", {})}

    def _next_wait(self) -> float:
        """上一次失败就快速重试；租约只由成功的签名续，重试更勤快不会延长授权。"""
        with self._lock:
            if not self._last_attempt_ok:
                return min(self._poll_interval, RETRY_AFTER_FAILURE)
            wait = self._poll_interval
            if self._last_payload is not None and self._last_payload["state"] == "valid":
                remaining = self._lease_remaining()
                # Renew short leases promptly without extending their deadline.
                if remaining < 2 * self._poll_interval:
                    wait = min(wait, max(.1, min(RETRY_AFTER_FAILURE, remaining / 2)))
            return wait

    def _note_failure(self, exc: Exception, took: float) -> None:
        now = self._clock()
        with self._lock:
            self._last_error = f"{type(exc).__name__}: {exc}" if not isinstance(exc, LicenseSignalError) else str(exc)
            self._last_attempt_ok = False
            self._failures += 1
            self._last_duration = took
            if self._first_failure_at is None:
                self._first_failure_at = now
            due = self._last_failure_log is None or now - self._last_failure_log >= FAILURE_LOG_INTERVAL
            if due:
                self._last_failure_log = now
            failures, reason = self._failures, self._last_error
            remaining = self._lease_remaining()
        if due:
            logger.warning("license request failed: %s (took %.2fs, %d consecutive, lease remaining %.1fs)",
                           reason, took, failures, remaining)

    def _note_success(self, took: float) -> None:
        now = self._clock()
        with self._lock:
            failures, since = self._failures, self._first_failure_at
            self._last_attempt_ok = True
            self._failures = 0
            self._first_failure_at = None
            self._last_failure_log = None
            self._last_success_at = now
            self._last_duration = took
        if failures:
            logger.info("license request recovered after %d consecutive failures (outage %.1fs)",
                        failures, (now - since) if since is not None else 0.0)
        elif took >= SLOW_REQUEST:
            logger.warning("license request slow: took %.2fs (lease remaining %.1fs)", took, self._lease_remaining())

    def _tick(self) -> None:
        started = self._clock()
        try:
            self.challenge_once()
        except Exception as exc:
            self._note_failure(exc, self._clock() - started)
        else:
            self._note_success(self._clock() - started)
        degraded = self.degraded()
        if degraded != self._was_degraded:
            self._was_degraded = degraded
            if degraded:
                with self._lock:
                    lease = (self._last_payload or {}).get("lease_ms", -1)
                logger.warning("license renewal degraded (lease_ms=%s); retaining verified grant until internal_sec=%.3f",
                               lease, self._licensed_until)
            else:
                logger.warning("license lease back to normal")
        new = self.phase()
        if new != self._phase:
            old, self._phase = self._phase, new
            logger.warning("license permission decision: %s", json.dumps(self.decision_diagnostics(), ensure_ascii=False, separators=(",", ":")))
            if new == "dormant":
                with self._lock:
                    reason = self._last_error or "no error recorded"
                    since = (self._clock() - self._last_success_at) if self._last_success_at is not None else -1.0
                    failures, took = self._failures, self._last_duration
                    payload = self._last_payload or {}
                    signed_state = payload.get("state", "unknown")
                    signed_lease_ms = payload.get("lease_ms", -1)
                    authority_reason = payload.get("reason", "")
                    remaining_ms = int(self._lease_remaining() * 1000)
                logger.warning("license phase %s -> %s (last_error=%s; %.1fs since last success; "
                               "%d consecutive failures; last request took %.2fs; "
                               "signed_state=%s; signed_lease_ms=%s; remaining_ms=%d; authority_reason=%s)",
                               old, new, reason, since, failures, took,
                               signed_state, signed_lease_ms, remaining_ms, authority_reason)
            else:
                logger.warning("license phase %s -> %s", old, new)
            if self._on_change:
                try:
                    self._on_change(old, new)
                except Exception:
                    logger.exception("license callback failed")

    def _run(self) -> None:
        while not self._stop.is_set():
            self._tick()
            self._stop.wait(self._next_wait())

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name=f"license-{self.client_id}")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=self._timeout + 1)
            if not self._thread.is_alive():
                self._thread = None

    def wait_for_valid(self, timeout: Optional[float] = None) -> bool:
        deadline = None if timeout is None else time.monotonic() + timeout
        while not self._stop.is_set():
            if self.is_licensed():
                return True
            if deadline is not None and time.monotonic() >= deadline:
                return False
            self._stop.wait(.1)
        return False


def client_from_env(client_id: str, env_file: Optional[str] = None, on_change=None):
    error = ""
    try:
        if env_file:
            load_env_file(env_file)
    except Exception as exc:
        error = str(exc)
    # Runtime environment must never disable licensing. Tests inject clients.
    try:
        key = bytes.fromhex(os.environ.get("LICENSE_SIGNAL_KEY", ""))
    except ValueError:
        key = b""
    return LicenseSignalClient(
        client_id, key, device_id=os.environ.get("LICENSE_DEVICE_ID", ""),
        uds_path=os.environ.get("LICENSE_UDS_PATH", DEFAULT_UDS_PATH),
        on_change=on_change, configuration_error=error)
