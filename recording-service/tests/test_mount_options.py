"""挂载选项加固：nolease（lease break 卡死的直接对策）+ echo_interval，
以及内核不支持 nolease（EINVAL）时摘除重试并记住的回退逻辑。"""
from unittest.mock import MagicMock, patch

from recorder.config import SmbConfig
from recorder.storage import StorageManager


def _cp(rc=0, stderr="", stdout=""):
    m = MagicMock()
    m.returncode = rc
    m.stderr = stderr
    m.stdout = stdout
    return m


def _smb():
    return SmbConfig(host="10.0.0.1", share="wanglei",
                     path="AI/videos", username="u", password="p",
                     smbVersion="3.0")


def test_mount_options_include_nolease_echo_soft(tmp_path):
    sm = StorageManager()
    try:
        with patch("recorder.storage._run", return_value=_cp(0)) as run, \
                patch("recorder.storage.is_mountpoint",
                      side_effect=[False, True]) as ismp, \
                patch("recorder.storage.mounted_options",
                      return_value="rw,relatime,vers=3.0,nolease,soft"):
            vers = sm._mount_cifs(_smb())

        assert vers == "3.0"
        assert run.call_count == 1
        opts = run.call_args[0][0][-1]
        assert "nolease" in opts
        assert "echo_interval=20" in opts
        assert "soft" in opts
        assert "vers=3.0" in opts
        assert ismp.call_count == 2
    finally:
        sm.io.shutdown()


def test_nolease_einval_falls_back_and_is_remembered(tmp_path):
    sm = StorageManager()
    try:
        calls: list[str] = []

        def fake_run(cmd, timeout=30):
            opts = cmd[-1]
            calls.append(opts)
            if "nolease" in opts:
                return _cp(255, stderr="mount error(22): Invalid argument")
            return _cp(0)

        # 序列：首轮 前检False → 失败后 busy检查False → 回退后 True；
        # 二次挂载（记住 nolease 不支持）：前检 False → 成功 True
        with patch("recorder.storage._run", side_effect=fake_run) as run, \
                patch("recorder.storage.is_mountpoint",
                      side_effect=[False, False, True, False, True]), \
                patch("recorder.storage.mounted_options",
                      return_value="rw,vers=3.0,soft"):
            v1 = sm._mount_cifs(_smb())
            v2 = sm._mount_cifs(_smb())

        assert v1 == "3.0" and v2 == "3.0"
        assert "nolease" in calls[0]      # 第一次尝试带 nolease
        assert "nolease" not in calls[1]  # EINVAL 后同版本回退
        assert "nolease" not in calls[2]  # 已记住：后续不再尝试
        assert sm._nolease_supported is False
        assert run.call_count == 3
    finally:
        sm.io.shutdown()


def test_invalid_option_detection():
    f = StorageManager._looks_invalid_option
    assert f("mount error(22): Invalid argument")
    assert f("Unknown mount option 'nolease'")
    assert not f("mount error(13): Permission denied")
    assert not f("Connection timed out")
