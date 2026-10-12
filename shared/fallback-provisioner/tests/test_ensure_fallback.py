"""
fallback-provisioner 单元测试。只测纯逻辑：接口识别用真实临时目录模拟 sysfs
结构（比 mock 每一次 os.path 调用更贴近真实行为)，nmcli/subprocess 全部打桩，
不碰真实网络配置。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ensure_fallback as ef


def _make_iface(root: str, name: str, *, wireless=False, pci=True, has_device=True) -> None:
    base = os.path.join(root, name)
    os.makedirs(base, exist_ok=True)
    if wireless:
        os.makedirs(os.path.join(base, "wireless"), exist_ok=True)
    if has_device:
        device = os.path.join(base, "device")
        os.makedirs(device, exist_ok=True)
        with open(os.path.join(device, "uevent"), "w") as f:
            if pci:
                f.write("DRIVER=r8168\nPCI_SLOT_NAME=0008:01:00.0\n")
            else:
                f.write("DRIVER=usbnet\n")


class TestInterfaceResolution(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.patcher = patch.object(ef, "SYS_CLASS_NET", self.tmp.name)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.hint_patcher = patch.object(ef, "IFACE_HINT", "")
        self.hint_patcher.start()
        self.addCleanup(self.hint_patcher.stop)

    def test_single_physical_pci_nic_resolved(self):
        _make_iface(self.tmp.name, "enP8p1s0", pci=True)
        _make_iface(self.tmp.name, "wlP1p1s0", wireless=True)
        _make_iface(self.tmp.name, "lo", has_device=False)
        _make_iface(self.tmp.name, "docker0", has_device=False)
        self.assertEqual(ef.resolve_fallback_interface(), "enP8p1s0")

    def test_no_candidates_raises(self):
        _make_iface(self.tmp.name, "wlP1p1s0", wireless=True)
        _make_iface(self.tmp.name, "lo", has_device=False)
        with self.assertRaises(ef.ProvisionError):
            ef.resolve_fallback_interface()

    def test_multiple_candidates_raises_without_hint(self):
        _make_iface(self.tmp.name, "enP8p1s0", pci=True)
        _make_iface(self.tmp.name, "enP1p1s0", pci=True)
        with self.assertRaises(ef.ProvisionError):
            ef.resolve_fallback_interface()

    def test_usb_ethernet_excluded(self):
        """USB 网卡/USB Device Mode 不能被当成兜底口——uevent 里没有 PCI_SLOT_NAME"""
        _make_iface(self.tmp.name, "usb0", pci=False)
        with self.assertRaises(ef.ProvisionError):
            ef.resolve_fallback_interface()

    def test_hint_overrides_autodetect(self):
        _make_iface(self.tmp.name, "enP8p1s0", pci=True)
        _make_iface(self.tmp.name, "enP1p1s0", pci=True)
        with patch.object(ef, "IFACE_HINT", "enP1p1s0"):
            self.assertEqual(ef.resolve_fallback_interface(), "enP1p1s0")

    def test_hint_nonexistent_iface_raises(self):
        with patch.object(ef, "IFACE_HINT", "doesNotExist0"):
            with self.assertRaises(ef.ProvisionError):
                ef.resolve_fallback_interface()

    def test_carrier_up_reads_sysfs(self):
        base = os.path.join(self.tmp.name, "enP8p1s0")
        os.makedirs(base, exist_ok=True)
        with open(os.path.join(base, "carrier"), "w") as f:
            f.write("1\n")
        self.assertTrue(ef.carrier_up("enP8p1s0"))

    def test_carrier_down_or_missing_is_false(self):
        self.assertFalse(ef.carrier_up("doesNotExist0"))
        base = os.path.join(self.tmp.name, "enP8p1s0")
        os.makedirs(base, exist_ok=True)
        with open(os.path.join(base, "carrier"), "w") as f:
            f.write("0\n")
        self.assertFalse(ef.carrier_up("enP8p1s0"))


class TestWriteConfig(unittest.TestCase):
    def test_writes_atomic_json(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "sub", "fallback.json")
            with patch.object(ef, "CONFIG_PATH", path):
                ef.write_config("enP8p1s0")
            with open(path) as f:
                data = json.load(f)
            self.assertEqual(data["interface"], "enP8p1s0")
            self.assertEqual(data["address"], ef.FALLBACK_ADDRESS)
            self.assertEqual(data["profile"], ef.FALLBACK_PROFILE)
            self.assertFalse(os.path.exists(path + ".tmp"))

    def test_unchanged_config_is_not_rewritten(self):
        """timer 每 60s 跑一次：内容没变就不该再换文件（每分钟一次元数据写盘）"""
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "fallback.json")
            with patch.object(ef, "CONFIG_PATH", path):
                ef.write_config("enP8p1s0")
                first = os.stat(path).st_ino
                with patch.object(ef.os, "replace") as mock_replace:
                    ef.write_config("enP8p1s0")
                mock_replace.assert_not_called()
                self.assertEqual(os.stat(path).st_ino, first)
                self.assertFalse(os.path.exists(path + ".tmp"))

    def test_changed_config_is_rewritten(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "fallback.json")
            with patch.object(ef, "CONFIG_PATH", path):
                ef.write_config("enP8p1s0")
                ef.write_config("enP1p1s0")
            with open(path) as f:
                self.assertEqual(json.load(f)["interface"], "enP1p1s0")


class TestEnsureProfile(unittest.TestCase):
    """nmcli 全打桩，只验证调了什么"""

    @patch.object(ef, "carrier_up", return_value=True)
    @patch.object(ef, "profile_exists", return_value=False)
    @patch.object(ef, "existing_connections_on", return_value=["Wired connection 1"])
    @patch.object(ef, "run")
    @patch.object(ef, "nmcli")
    def test_creates_profile_and_deletes_ghost(self, mock_nmcli, mock_run, *_):
        ef.ensure_profile("enP8p1s0")
        # 幽灵 profile 被删
        delete_calls = [c for c in mock_run.call_args_list if "delete" in c[0][0]]
        self.assertTrue(any("Wired connection 1" in c[0][0] for c in delete_calls))
        # 新建 profile 带上了关键字段
        add_call = next(c for c in mock_nmcli.call_args_list if c[0][0] == "connection" and c[0][1] == "add")
        args = add_call[0]
        self.assertIn("ipv4.never-default", args)
        self.assertEqual(args[args.index("ipv4.never-default") + 1], "yes")
        self.assertIn(f"{ef.FALLBACK_ADDRESS}/{ef.FALLBACK_PREFIX}", args)
        # carrier up，应该尝试激活
        up_calls = [c for c in mock_run.call_args_list if "up" in c[0][0]]
        self.assertTrue(any("connection" in c[0][0] and "up" in c[0][0] for c in up_calls))

    @patch.object(ef, "carrier_up", return_value=False)
    @patch.object(ef, "profile_exists", return_value=True)
    @patch.object(ef, "existing_connections_on", return_value=[ef.FALLBACK_PROFILE])
    @patch.object(ef, "run")
    @patch.object(ef, "nmcli")
    def test_no_carrier_skips_activation(self, mock_nmcli, mock_run, *_):
        mock_nmcli.return_value = "ipv4.addresses:10.250.100.1/24\n"
        ef.ensure_profile("enP8p1s0")
        up_calls = [c for c in mock_run.call_args_list if c[0][0][:2] == ["nmcli", "connection"] and "up" in c[0][0]]
        self.assertEqual(up_calls, [])

    @patch.object(ef, "carrier_up", return_value=True)
    @patch.object(ef, "profile_exists", return_value=True)
    @patch.object(ef, "existing_connections_on", return_value=[ef.FALLBACK_PROFILE])
    @patch.object(ef, "run")
    @patch.object(ef, "nmcli")
    def test_existing_profile_missing_protected_addr_gets_repaired(self, mock_nmcli, mock_run, *_):
        mock_nmcli.side_effect = [
            # current show — 只有用户地址，兜底地址被删了；method 本身没被带偏
            "ipv4.addresses:192.168.1.10/24\nipv4.method:manual\n",
            "",  # addr modify
            "",  # autoconnect modify
        ]
        ef.ensure_profile("enP8p1s0")
        modify_call = next(
            c for c in mock_nmcli.call_args_list
            if c[0][0] == "connection" and c[0][1] == "modify" and "ipv4.addresses" in c[0]
        )
        args = modify_call[0]
        addr_arg = args[args.index("ipv4.addresses") + 1]
        self.assertIn(f"{ef.FALLBACK_ADDRESS}/{ef.FALLBACK_PREFIX}", addr_arg.split(","))
        # method 本来就是 manual，不该多余地再发一次 method 纠偏调用
        method_calls = [
            c for c in mock_nmcli.call_args_list
            if c[0][0] == "connection" and c[0][1] == "modify" and "ipv4.method" in c[0]
        ]
        self.assertEqual(method_calls, [])

    @patch.object(ef, "carrier_up", return_value=True)
    @patch.object(ef, "profile_exists", return_value=True)
    @patch.object(ef, "existing_connections_on", return_value=[ef.FALLBACK_PROFILE])
    @patch.object(ef, "run")
    @patch.object(ef, "nmcli")
    def test_existing_profile_method_disabled_gets_repaired_to_manual(self, mock_nmcli, mock_run, *_):
        """回归：点"恢复出厂网络设置"曾经会把 profile 的 ipv4.method 改成
        disabled——地址字段里还留着兜底地址，但 NM 不会把它带上网卡。自愈
        脚本必须把 method 纠偏回 manual，光看 addresses 字段不够。"""
        cidr = f"{ef.FALLBACK_ADDRESS}/{ef.FALLBACK_PREFIX}"
        mock_nmcli.side_effect = [
            f"ipv4.addresses:{cidr}\nipv4.method:disabled\n",  # current show
            "",  # method modify
            "",  # autoconnect modify
        ]
        ef.ensure_profile("enP8p1s0")
        method_call = next(
            c for c in mock_nmcli.call_args_list
            if c[0][0] == "connection" and c[0][1] == "modify" and "ipv4.method" in c[0]
        )
        args = method_call[0]
        self.assertEqual(args[args.index("ipv4.method") + 1], "manual")

    @patch.object(ef, "carrier_up", return_value=False)
    @patch.object(ef, "profile_exists", return_value=True)
    @patch.object(ef, "existing_connections_on", return_value=[ef.FALLBACK_PROFILE])
    @patch.object(ef, "run")
    @patch.object(ef, "nmcli")
    def test_correct_profile_without_carrier_issues_no_modify(self, mock_nmcli, mock_run, *_):
        """回归：没插网线时每轮都进 ensure_profile，曾经无条件 modify
        autoconnect——每分钟改写一次 NM keyfile，慢盘上还会 nmcli 超时失败。
        profile 已经完全正确时不得发出任何 modify。"""
        cidr = f"{ef.FALLBACK_ADDRESS}/{ef.FALLBACK_PREFIX}"
        mock_nmcli.return_value = (
            f"connection.autoconnect:yes\nipv4.method:manual\nipv4.addresses:{cidr}\n"
        )
        ef.ensure_profile("enP8p1s0")
        modify_calls = [
            c for c in mock_nmcli.call_args_list
            if c[0][:2] == ("connection", "modify")
        ]
        self.assertEqual(modify_calls, [])

    @patch.object(ef, "carrier_up", return_value=False)
    @patch.object(ef, "profile_exists", return_value=True)
    @patch.object(ef, "existing_connections_on", return_value=[ef.FALLBACK_PROFILE])
    @patch.object(ef, "run")
    @patch.object(ef, "nmcli")
    def test_autoconnect_off_gets_repaired(self, mock_nmcli, mock_run, *_):
        cidr = f"{ef.FALLBACK_ADDRESS}/{ef.FALLBACK_PREFIX}"
        mock_nmcli.return_value = (
            f"connection.autoconnect:no\nipv4.method:manual\nipv4.addresses:{cidr}\n"
        )
        ef.ensure_profile("enP8p1s0")
        autoconnect_calls = [
            c for c in mock_nmcli.call_args_list
            if c[0][:2] == ("connection", "modify") and "connection.autoconnect" in c[0]
        ]
        self.assertEqual(len(autoconnect_calls), 1)
        args = autoconnect_calls[0][0]
        self.assertEqual(args[args.index("connection.autoconnect") + 1], "yes")


class TestExistingConnectionsOn(unittest.TestCase):
    """真实设备上验证过的坑：NM 自动生成的幽灵 profile 从没激活过，DEVICE 列
    是空的，只能靠 connection.interface-name 这个静态字段识别 (回归)"""

    @patch.object(ef, "nmcli")
    def test_matches_by_static_interface_name_even_when_device_column_empty(self, mock_nmcli):
        def fake_nmcli(*args, **kwargs):
            if args[:3] == ("-f", "NAME", "connection"):
                return "factory-fallback\nWired connection 1\nother-wifi-profile\n"
            if args[:2] == ("-f", "connection.interface-name"):
                name = args[-1]
                bound = {
                    "factory-fallback": "connection.interface-name:enP8p1s0",
                    "Wired connection 1": "connection.interface-name:enP8p1s0",
                    "other-wifi-profile": "connection.interface-name:--",
                }[name]
                return bound + "\n"
            raise AssertionError(f"unexpected nmcli args: {args}")
        mock_nmcli.side_effect = fake_nmcli

        result = ef.existing_connections_on("enP8p1s0")
        self.assertEqual(sorted(result), ["Wired connection 1", "factory-fallback"])


class TestMain(unittest.TestCase):
    @patch.object(ef, "resolve_fallback_interface", return_value="enP8p1s0")
    @patch.object(ef, "write_config")
    @patch.object(ef, "carrier_up", return_value=True)
    @patch.object(ef, "address_present", return_value=True)
    @patch.object(ef, "profile_exists", return_value=True)
    @patch.object(ef, "ensure_profile")
    def test_steady_state_is_noop(self, mock_ensure, *_):
        self.assertEqual(ef.main(), 0)
        mock_ensure.assert_not_called()

    @patch.object(ef, "resolve_fallback_interface", return_value="enP8p1s0")
    @patch.object(ef, "write_config")
    @patch.object(ef, "carrier_up", return_value=True)
    @patch.object(ef, "address_present", return_value=False)
    @patch.object(ef, "profile_exists", return_value=True)
    @patch.object(ef, "ensure_profile")
    def test_missing_address_triggers_repair(self, mock_ensure, *_):
        self.assertEqual(ef.main(), 0)
        mock_ensure.assert_called_once_with("enP8p1s0")

    @patch.object(ef, "resolve_fallback_interface", side_effect=ef.ProvisionError("多张网卡，无法判断"))
    def test_unresolvable_interface_exits_nonzero_without_touching_anything(self, _):
        self.assertEqual(ef.main(), 1)


if __name__ == "__main__":
    unittest.main()
