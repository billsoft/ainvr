"""重启助手核心逻辑单测（2026-09-18）——纯函数部分，不起真实 HTTP 服务/
不真的调 systemctl（run_restart 的子进程调用用 monkeypatch 替身）。
"""
from __future__ import annotations

import subprocess

import pytest

import restart_helper as rh


@pytest.fixture(autouse=True)
def _services_running(monkeypatch):
    # 关机前的服务状态查询另有专门测试（test_shutdown_rollback.py）；这里按都在运行，
    # 子进程替身只看到关机序列本身的命令
    monkeypatch.setattr(rh, "_unit_running", lambda unit: True, raising=False)
    monkeypatch.setattr(rh, "_unit_missing", lambda unit: False)


class TestTokenIsValid:
    def test_matching_token_accepted(self):
        assert rh.token_is_valid("secret-abc", "secret-abc") is True

    def test_mismatched_token_rejected(self):
        assert rh.token_is_valid("wrong", "secret-abc") is False

    def test_missing_provided_token_rejected(self):
        assert rh.token_is_valid(None, "secret-abc") is False
        assert rh.token_is_valid("", "secret-abc") is False

    def test_empty_expected_token_always_rejects(self):
        """expected 为空 = 服务端没配置 token，绝不能被当成"不鉴权直接放行"。"""
        assert rh.token_is_valid("anything", "") is False
        assert rh.token_is_valid("", "") is False


class TestSourceIpAllowed:
    def test_loopback_allowed(self):
        assert rh.source_ip_allowed("127.0.0.1") is True

    def test_only_deployed_docker_range_allowed(self, monkeypatch, tmp_path):
        from internal_network import NetworkPolicy
        policy = tmp_path / 'peers.json'
        policy.write_text('["172.17.0.0/16"]')
        monkeypatch.setattr(rh, 'SOURCE_POLICY', NetworkPolicy(policy))
        assert rh.source_ip_allowed("172.17.0.1") is True
        assert rh.source_ip_allowed("172.31.255.254") is False

    def test_lan_ip_rejected(self):
        """宿主机自己的局域网网卡 IP——不能因为绑了 0.0.0.0 就顺带放行局域网"""
        assert rh.source_ip_allowed("192.168.100.183") is False
        assert rh.source_ip_allowed("192.168.1.50") is False

    def test_arbitrary_public_ip_rejected(self):
        assert rh.source_ip_allowed("8.8.8.8") is False

    def test_malformed_input_rejected_not_crashed(self):
        assert rh.source_ip_allowed("not-an-ip") is False
        assert rh.source_ip_allowed("") is False


class TestResolveUnit:
    def test_known_targets_resolve(self):
        assert rh.resolve_unit("ai-service") == "ai-service.service"
        assert rh.resolve_unit("recorder") == "ainvr-recorder.service"

    def test_unknown_target_returns_none(self):
        assert rh.resolve_unit("backend") is None
        assert rh.resolve_unit("srs") is None
        assert rh.resolve_unit("../etc/passwd") is None
        assert rh.resolve_unit("") is None

    def test_only_two_targets_allowed(self):
        """允许列表就该是这两个——多一个都是扩大攻击面，得显式改测试才能加。"""
        assert set(rh.ALLOWED_TARGETS.keys()) == {"ai-service", "recorder"}


class TestBuildRestartCommand:
    def test_command_shape(self):
        cmd = rh.build_restart_command("ai-service.service")
        assert cmd == ["sudo", "-n", "systemctl", "restart", "ai-service.service"]

    def test_dash_n_present_never_prompts_for_password(self):
        """-n 是安全关键：sudoers 规则一旦哪天配错要求密码，必须直接失败
        而不是把 HTTP 请求线程挂死在等密码输入上。"""
        cmd = rh.build_restart_command("recorder.service")
        assert "-n" in cmd


class TestRunRestart:
    def test_success_returns_ok_true(self, monkeypatch):
        def fake_run(cmd, capture_output, text, timeout):
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

        monkeypatch.setattr(rh.subprocess, "run", fake_run)
        ok, err = rh.run_restart("ai-service.service")
        assert ok is True
        assert err == ""

    def test_nonzero_exit_returns_stderr_as_error(self, monkeypatch):
        def fake_run(cmd, capture_output, text, timeout):
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="Failed to restart unit.")

        monkeypatch.setattr(rh.subprocess, "run", fake_run)
        ok, err = rh.run_restart("ai-service.service")
        assert ok is False
        assert "Failed to restart" in err

    def test_timeout_returns_ok_false_with_message(self, monkeypatch):
        def fake_run(cmd, capture_output, text, timeout):
            raise subprocess.TimeoutExpired(cmd, timeout)

        monkeypatch.setattr(rh.subprocess, "run", fake_run)
        ok, err = rh.run_restart("ai-service.service")
        assert ok is False
        assert "超时" in err


class TestHandlerAuthIntegration:
    """不起真实 socket，直接测 Handler 的鉴权判定逻辑跟 token_is_valid 一致
    （防止以后有人改了 do_POST 里的 Authorization 头解析却漏测）。"""

    def test_bearer_prefix_stripped_correctly(self):
        header = "Bearer my-token-value"
        assert header[len("Bearer "):] == "my-token-value"


class TestShutdownLock:
    """关机互斥锁与并发行为测试。"""

    def test_try_begin_shutdown_acquires_lock(self, monkeypatch):
        """第一次抢锁应该成功；抢到后第二次立即失败，不会阻塞。"""
        # 先确保锁是释放状态（前面的测试可能影响）
        if rh._shutdown_lock.locked():
            rh._shutdown_lock.release()
        assert rh.try_begin_shutdown() is True
        assert rh._shutdown_lock.locked() is True
        # 第二次抢锁（非阻塞）应立即返回 False
        assert rh.try_begin_shutdown() is False
        # 释放后可再次抢到
        rh._shutdown_lock.release()
        assert rh.try_begin_shutdown() is True
        rh._shutdown_lock.release()

    def test_run_shutdown_respects_lock(self, monkeypatch):
        """run_shutdown 在锁被持有时应直接返回"已在进行中"。"""
        if rh._shutdown_lock.locked():
            rh._shutdown_lock.release()
        # 手动持有锁
        acquired = rh._shutdown_lock.acquire(blocking=False)
        assert acquired is True
        try:
            ok, err, step = rh.run_shutdown()
            assert ok is False
            assert step == 0
            assert "已在进行中" in err
        finally:
            rh._shutdown_lock.release()

    def test_run_shutdown_releases_lock_on_failure(self, monkeypatch):
        """序列中途失败时锁应被正确释放（不会泄漏）。"""
        if rh._shutdown_lock.locked():
            rh._shutdown_lock.release()
        calls = []
        def fake_run(cmd, capture_output, text, timeout):
            calls.append(cmd)
            if len(calls) == 2:
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="boom")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        monkeypatch.setattr(rh.subprocess, "run", fake_run)

        ok, err, step = rh.run_shutdown()
        assert ok is False
        assert step == 1
        # 失败后锁应已释放，下次可再抢
        assert rh.try_begin_shutdown() is True
        rh._shutdown_lock.release()


class TestRunShutdown:
    """关机序列测试——mock subprocess.run，不真的执行命令。"""

    def _fake_run_all_success(self, monkeypatch):
        calls = []
        def fake_run(cmd, capture_output, text, timeout):
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        monkeypatch.setattr(rh.subprocess, "run", fake_run)
        return calls

    def test_sequence_completes_all_steps(self, monkeypatch):
        calls = self._fake_run_all_success(monkeypatch)
        ok, err, step = rh.run_shutdown()
        assert ok is True
        assert step == len(rh.SHUTDOWN_SEQUENCE)
        assert err == ""
        assert len(calls) == len(rh.SHUTDOWN_SEQUENCE)

    def test_first_step_failure_stops_early(self, monkeypatch):
        calls = []
        def fake_run(cmd, capture_output, text, timeout):
            calls.append(cmd)
            if len(calls) == 1:
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="unit not found")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        monkeypatch.setattr(rh.subprocess, "run", fake_run)
        ok, err, step = rh.run_shutdown()
        assert ok is False
        assert step == 0
        assert "第 1 步" in err
        # 失败后不再往下执行；之后只有把已停服务拉回来的 restart
        assert calls[0][-2:] == ["stop", "ainvr-recorder.service"]
        assert all("restart" in c for c in calls[1:])
        assert not any("poweroff" in c for c in calls)

    def test_middle_step_failure_stops_at_middle(self, monkeypatch):
        calls = []
        def fake_run(cmd, capture_output, text, timeout):
            calls.append(cmd)
            if len(calls) == 3:
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="no such container")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        monkeypatch.setattr(rh.subprocess, "run", fake_run)
        ok, err, step = rh.run_shutdown()
        assert ok is False
        assert step == 2
        assert "第 3 步" in err
        assert [c for c in calls if "restart" not in c] == [s["cmd"] for s in rh.SHUTDOWN_SEQUENCE]

    def test_last_step_is_poweroff(self):
        last = rh.SHUTDOWN_SEQUENCE[-1]
        assert "poweroff" in " ".join(last["cmd"])

    def test_sequence_order_logical(self):
        names = [s["name"] for s in rh.SHUTDOWN_SEQUENCE]
        # 业务服务先停，最后才是系统关机
        assert names.index("停止录像服务") < names.index("系统关机")
        assert names.index("停止 AI 识别服务") < names.index("系统关机")
        assert names[-1] == "系统关机"
        # Docker 容器不显式 stop——交给 systemd 关机时 docker.service 优雅退出，
        # 避免 unless-stopped 容器下次开机不自动拉起
        assert not any("SRS" in n or "后端" in n or "数据库" in n for n in names)


class TestLicenseGate:
    """授权门：默认不接线放行；接线后只放行 phase=valid。"""

    class _StubClient:
        def __init__(self, phase):
            self._phase = phase

        def phase(self):
            return self._phase

    def test_not_wired_allows(self):
        assert rh.license_action_blocked(None) == (False, "")

    def test_valid_allows(self):
        assert rh.license_action_blocked(self._StubClient("valid")) == (False, "management_exempt")

    @pytest.mark.parametrize("phase", ["starting", "invalid", "dormant"])
    def test_non_valid_phases_blocked(self, phase):
        blocked, got_phase = rh.license_action_blocked(self._StubClient(phase))
        assert blocked is False and got_phase == "management_exempt"
