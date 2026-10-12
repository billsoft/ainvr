import base64
import hashlib
import hmac
import json
import urllib.parse
import pytest
import license_client as lc

KEY = bytes(32)
DEVICE = "0123456789ABCDEFGHJKMNPQ"


def test_permission_diagnostics_exclude_credentials():
    c, _ = rig()
    c._tick()
    d = c.decision_diagnostics()
    assert d["signed_lease_ms"] == 30000
    assert d["lease_deadline_sec"] == 1030
    assert "key" not in d and "nonce" not in d and "license_id" not in d


def envelope(nonce, **changes):
    p = {"v": 2, "device_id": DEVICE, "audience": "recorder",
         "nonce": nonce, "epoch": "a"*32, "license_id": "b"*32,
         "grant_seq": 1, "revision": 1, "state": "valid",
         "remaining_seconds": 60, "lease_ms": 30000, "reason": ""}
    p.update(changes)
    raw = base64.urlsafe_b64encode(json.dumps(p, separators=(",", ":"), sort_keys=True).encode()).rstrip(b"=").decode()
    return {"payload": raw, "sig": hmac.new(KEY, ("AINVR/lease/v2|"+raw).encode(), hashlib.sha256).hexdigest()}


def rig(**changes):
    now = [1000.0]
    def transport(query):
        nonce = urllib.parse.parse_qs(urllib.parse.urlsplit(query).query)["nonce"][0]
        return 200, json.dumps(envelope(nonce, **changes)).encode()
    c = lc.LicenseSignalClient("recorder", KEY, device_id=DEVICE, clock=lambda: now[0], transport=transport)
    return c, now


def test_lease_expires_without_wall_clock():
    c, now = rig()
    c.challenge_once()
    assert c.is_licensed()
    now[0] += 59
    assert c.phase() == "dormant"


def test_request_delay_does_not_extend_lease():
    c, now = rig()
    original = c._transport
    def delayed(query):
        result = original(query)
        now[0] += 61
        return result
    c._transport = delayed
    c.challenge_once()
    assert not c.is_licensed()


@pytest.mark.parametrize("changes", [
    {"device_id": "X"*24}, {"audience": "ai-service"}, {"nonce": "old"},
    {"lease_ms": 30001}, {"lease_ms": -1}, {"lease_ms": True},
    {"lease_ms": 10000, "remaining_seconds": 1}, {"state": "expired", "lease_ms": 10},
    {"revision": 1.1}, {"epoch": ""}, {"v": 1},
])
def test_bad_binding_and_schema_fail_closed(changes):
    c, _ = rig(**changes)
    with pytest.raises((lc.LicenseSignalError, TypeError, ValueError)):
        c.challenge_once()
    assert not c.is_licensed()


def test_explicit_revocation_is_immediate():
    c, _ = rig(state="expired", lease_ms=0)
    c.challenge_once()
    assert c.phase() == "invalid"


def test_wrong_signature_rejected():
    c, _ = rig()
    original = c._transport
    def bad(query):
        status, data = original(query)
        j = json.loads(data)
        j["sig"] = "f"*64
        return status, json.dumps(j).encode()
    c._transport = bad
    with pytest.raises(lc.LicenseSignalError):
        c.challenge_once()


def test_missing_or_malformed_key_never_disables_gate(monkeypatch):
    monkeypatch.setenv("AINVR_PROFILE", "production")
    monkeypatch.setenv("LICENSE_ENABLED", "false")
    monkeypatch.delenv("LICENSE_SIGNAL_KEY", raising=False)
    c = lc.client_from_env("recorder")
    assert c is not None and c.phase() == "configuration_error"
    monkeypatch.setenv("LICENSE_SIGNAL_KEY", "not-hex")
    assert not lc.client_from_env("recorder").is_licensed()


def test_development_environment_cannot_disable_gate(monkeypatch):
    monkeypatch.setenv("AINVR_PROFILE", "development")
    monkeypatch.setenv("LICENSE_ENABLED", "false")
    monkeypatch.delenv("LICENSE_SIGNAL_KEY", raising=False)
    client = lc.client_from_env("recorder")
    assert client is not None and not client.is_licensed()


@pytest.mark.parametrize("suffix", ["", " (deleted)"])
def test_peer_is_authority_uid_not_consumer_uid(monkeypatch, suffix):
    from types import SimpleNamespace
    import struct
    monkeypatch.setattr(lc.pwd, 'getpwnam', lambda _: SimpleNamespace(pw_uid=1000))
    monkeypatch.setattr(lc.os, 'getuid', lambda: 0)
    monkeypatch.setattr(lc.os, 'readlink', lambda _: '/opt/license_service' + suffix)
    monkeypatch.setattr(lc.Path, 'read_text', lambda _: '0::/system.slice/ainvr-license.service\n')
    sock = SimpleNamespace(getsockopt=lambda *_: struct.pack('3i', 123, 1000, 1000))
    lc._verify_peer(sock)
    monkeypatch.setattr(lc.Path, 'read_text', lambda _: '0::/system.slice/fake-ainvr-license.service\n')
    with pytest.raises(lc.LicenseSignalError):
        lc._verify_peer(sock)
    sock = SimpleNamespace(getsockopt=lambda *_: struct.pack('3i', 123, 0, 0))
    with pytest.raises(lc.LicenseSignalError):
        lc._verify_peer(sock)


def test_outage_does_not_renew_lease():
    c, now = rig()
    c.challenge_once()
    c._transport = lambda _: (_ for _ in ()).throw(OSError("offline"))
    c._tick()
    now[0] += 59
    c._tick()
    assert c.phase() == "dormant"


# ---- 可观测性：为什么拿不到签名（2026-10-01：14 小时内进入休眠约 20 次，原因在日志里查不到） ----

import logging


def failing_rig(exc_factory, spend=0.0):
    """transport 每次先花 spend 秒再失败。"""
    now = [1000.0]
    calls = []

    def transport(query):
        calls.append(query)
        now[0] += spend
        raise exc_factory()
    c = lc.LicenseSignalClient("recorder", KEY, device_id=DEVICE, clock=lambda: now[0], transport=transport)
    return c, now, calls


def test_failed_request_logs_reason_duration_and_lease_remaining(caplog):
    c, now = rig()
    c.challenge_once()                       # 先有一份有效租约
    c._transport = lambda q: (_ for _ in ()).throw(lc.LicenseSignalError("license request deadline exceeded"))
    now[0] += 12
    with caplog.at_level(logging.WARNING, logger=lc.logger.name):
        c._tick()
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "license request failed" in text
    assert "deadline exceeded" in text       # 失败原因
    assert "took" in text                    # 请求耗时
    assert "lease remaining" in text         # 当前租约还剩多久


def test_failure_logs_are_rate_limited_not_a_flood(caplog):
    c, now, _ = failing_rig(lambda: OSError("connection refused"))
    with caplog.at_level(logging.WARNING, logger=lc.logger.name):
        for _ in range(40):
            now[0] += 1
            c._tick()
    lines = [r for r in caplog.records if "license request failed" in r.getMessage()]
    assert 1 <= len(lines) <= 3, len(lines)  # 40 次连续失败只记首次 + 限频摘要


def test_failure_reports_consecutive_count_and_recovery(caplog):
    c, now = rig()
    c.challenge_once()
    good = c._transport
    c._transport = lambda q: (_ for _ in ()).throw(OSError("boom"))
    with caplog.at_level(logging.INFO, logger=lc.logger.name):
        for _ in range(3):
            now[0] += 1
            c._tick()
        c._transport = good
        now[0] += 1
        c._tick()
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "recovered" in text and "3" in text   # 恢复时说明连续失败了几次


def test_dormant_transition_log_carries_the_last_error(caplog):
    c, now = rig()
    c._tick()                                # starting -> valid
    c._transport = lambda q: (_ for _ in ()).throw(lc.LicenseSignalError("license HTTP 503"))
    with caplog.at_level(logging.WARNING, logger=lc.logger.name):
        now[0] += 59
        c._tick()
    dormant = [r.getMessage() for r in caplog.records if "-> dormant" in r.getMessage()]
    assert dormant and "license HTTP 503" in dormant[0]
    assert "since last success" in dormant[0]


# ---- 失败后要在租约有效期内尽快重试，而不是干等一个完整轮询周期 ----

def test_retry_quickly_after_a_failure_but_poll_normally_after_success():
    c, now = rig()
    c._tick()
    assert c._next_wait() == c._poll_interval        # 成功后按正常周期
    c._transport = lambda q: (_ for _ in ()).throw(OSError("boom"))
    now[0] += 1
    c._tick()
    assert c._next_wait() <= 1.0                     # 失败后 1 秒内重试


def test_quick_retry_never_extends_or_revives_an_expired_lease():
    """重试更勤快，但租约只由成功的签名续；过期了仍然是休眠。"""
    c, now = rig()
    c._tick()
    c._transport = lambda q: (_ for _ in ()).throw(OSError("boom"))
    for _ in range(60):
        now[0] += 1
        c._tick()
    assert c.phase() == "dormant"
    assert not c.is_licensed()


# ---- 短租约或通信故障不提前撤销已验证激活；明确失权信号立即停止 ----

def continuity_rig(lease_ms=0, retain=True, took=0.0, remaining=3600):
    now = [1000.0]
    box = {"lease_ms": lease_ms, "alive": True, "state": "valid"}

    def transport(query):
        if not box["alive"]:
            raise OSError("service gone")
        nonce = urllib.parse.parse_qs(urllib.parse.urlsplit(query).query)["nonce"][0]
        now[0] += took
        lease = box["lease_ms"] if box["state"] == "valid" else 0
        return 200, json.dumps(envelope(nonce, lease_ms=lease, state=box["state"],
                                        remaining_seconds=remaining)).encode()
    c = lc.LicenseSignalClient("recorder", KEY, device_id=DEVICE, clock=lambda: now[0],
                               transport=transport, retain_verified_grant=retain)
    return c, now, box


def test_short_lease_retains_verified_activation():
    c, now, box = continuity_rig(lease_ms=0)
    c._tick()
    assert c.phase() == "valid" and c.is_licensed()
    assert c.status()["degraded"] is True


def test_verified_renewal_outlives_the_old_grace_window():
    c, now, box = continuity_rig(lease_ms=0, retain=True)
    c._tick()
    for _ in range(719):                    # 719 × 5s = 3595s
        now[0] += 5
        c._tick()
    assert c.phase() == "valid"
    for _ in range(3):
        now[0] += 5
        c._tick()
    assert c.phase() == "valid"


def test_normal_lease_clears_degraded_and_later_short_lease_retains_activation():
    c, now, box = continuity_rig(lease_ms=0, retain=True)
    c._tick()
    now[0] += 50
    box["lease_ms"] = 30000
    c._tick()
    assert c.status()["degraded"] is False
    box["lease_ms"] = 0
    now[0] += 40                            # 距首次已 90 秒，新签名仍确认激活有效
    c._tick()
    assert c.phase() == "valid"


def test_outage_retains_original_activation_deadline():
    c, now, box = continuity_rig(lease_ms=0)
    c._tick()
    box["alive"] = False
    now[0] += 5
    c._tick()
    now[0] += 20                            # 最后一次成功已 25 秒，激活仍有效
    c._tick()
    assert c.phase() == "valid"
    now[0] = 4599
    assert c.phase() == "dormant"


def test_expired_state_clears_verified_activation():
    c, now, box = continuity_rig(lease_ms=0)
    c._tick()
    box["state"] = "expired"
    now[0] += 5
    c._tick()
    assert c.phase() == "invalid"


def test_slow_response_does_not_discard_still_valid_activation():
    c, now, box = continuity_rig(lease_ms=30000, took=31)   # 完整租约，但响应来得太慢（重放/拖延）
    c._tick()
    assert c.phase() == "valid"


def test_disabled_retention_uses_strict_lease_deadline():
    c, now, box = continuity_rig(lease_ms=0, retain=False)
    c._tick()
    assert c.phase() == "dormant"


def test_retention_never_outlives_signed_remaining_time():
    """总授权只剩 10 秒时，保留策略不能越过真实授权截止。"""
    c, now, box = continuity_rig(lease_ms=0, remaining=10)
    c._tick()
    assert c.phase() == "valid"
    now[0] += 11                            # 总授权已到头，不得继续业务
    assert c.phase() == "dormant"


def test_precision_deadline_survives_outage_and_is_not_extended():
    c, now = rig(lease_ms=1000, authorization_ms=4250, remaining_seconds=5)
    c._tick()
    c._transport = lambda _: (_ for _ in ()).throw(OSError("offline"))
    now[0] = 1004.249
    c._tick()
    assert c.phase() == "valid" and c.degraded()
    now[0] = 1004.25
    c._tick()
    assert c.phase() == "dormant"


def test_signed_storage_error_does_not_replace_the_verified_deadline():
    c, now = rig(authorization_ms=60000)
    c.challenge_once()
    replacement, _ = rig(state="storage_error", lease_ms=0, remaining_seconds=999)
    c._transport = replacement._transport
    now[0] = 1050
    c.challenge_once()
    assert c.phase() == "valid"
    now[0] = 1060
    assert c.phase() == "dormant"


@pytest.mark.parametrize("value", [-1, True, 60001])
def test_invalid_authorization_duration_cannot_extend_permission(value):
    c, _ = rig(authorization_ms=value)
    with pytest.raises(lc.LicenseSignalError):
        c.challenge_once()
    assert not c.is_licensed()



@pytest.mark.parametrize("state", ["clock_error", "recovery_required"])
def test_tamper_and_clock_signals_clear_the_verified_deadline_at_once(state):
    """时钟异常/被篡改是攻击信号，不能靠"保留已验证截止"继续放行；存储故障（可能只是磁盘卡顿）仍只降级。"""
    c, now = rig(authorization_ms=600000, remaining_seconds=3600)
    c.challenge_once()
    assert c.phase() == "valid"
    bad, _ = rig(state=state, lease_ms=0, remaining_seconds=999)
    c._transport = bad._transport
    now[0] = 1005
    c.challenge_once()
    assert c.phase() == "invalid" and not c.is_licensed()
    # 之后即使恢复为 valid 且截止仍在，也必须由新的有效签名重新建立（这里直接验证没有残留截止）
    assert c._licensed_until == 0.0
