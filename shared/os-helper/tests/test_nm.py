"""
os-helper 网卡管理模块单元测试
只测纯逻辑（不调用真实 nmcli），不依赖 root 权限。
"""
from __future__ import annotations

import sys
import os
import unittest
from unittest.mock import patch, MagicMock

# 确保能 import 同目录的 nm
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import nm


class TestIfaceValidation(unittest.TestCase):
    """网卡名校验测试"""

    def test_valid_names(self):
        for name in ["eth0", "wlP1p1s0", "enP8p1s0", "br-abc", "docker0"]:
            self.assertEqual(nm._validate_iface(name), name)

    def test_invalid_names(self):
        for name in ["", "eth0;rm -rf /", "../etc/passwd", "eth 0", "a" * 17]:
            with self.assertRaises(nm.NMError):
                nm._validate_iface(name)

    def test_system_iface_detection(self):
        sys_ifaces = [
            "lo", "docker0", "vethabc123", "br-abcdef", "virbr0",
            "l4tbr0", "usb0", "rndis0", "tun0", "tap0",
            "ztabc", "tailscale0", "dummy0", "nvethernet0", "can0",
            "p2p-dev-wlan0",
        ]
        for name in sys_ifaces:
            self.assertTrue(nm._is_system_iface(name), f"{name} 应被识别为系统网卡")

    def test_physical_iface_not_system(self):
        for name in ["eth0", "wlP1p1s0", "enP8p1s0", "wlan0"]:
            self.assertFalse(nm._is_system_iface(name))


class TestTerseParsing(unittest.TestCase):
    """nmcli terse 输出解析测试"""

    def test_unescape_colons(self):
        self.assertEqual(nm._unescape("foo\\:bar"), "foo:bar")
        self.assertEqual(nm._unescape("a\\\\b"), "a\\b")
        self.assertEqual(nm._unescape("normal"), "normal")

    def test_parse_kv(self):
        text = "NAME:TestCon\nDEVICE:eth0\nIP4.ADDRESS:192.168.1.100/24\n"
        result = nm.parse_kv(text)
        self.assertEqual(result["NAME"], "TestCon")
        self.assertEqual(result["DEVICE"], "eth0")
        self.assertEqual(result["IP4.ADDRESS"], "192.168.1.100/24")

    def test_split_terse(self):
        line = "eth0:ethernet:connected:Wired\\:con1"
        parts = nm.split_terse(line)
        self.assertEqual(len(parts), 4)
        self.assertEqual(parts[0], "eth0")
        self.assertEqual(parts[3], "Wired:con1")


class TestPendingState(unittest.TestCase):
    """安全回滚状态机测试（不真实改网卡）"""

    def setUp(self):
        nm._pending = None
        if nm._rollback_timer:
            nm._rollback_timer.cancel()
            nm._rollback_timer = None

    def tearDown(self):
        nm._pending = None
        if nm._rollback_timer:
            nm._rollback_timer.cancel()
            nm._rollback_timer = None

    def test_pending_info_none_when_no_pending(self):
        self.assertIsNone(nm.pending_info())

    @patch.object(nm, "_snapshot_connection", return_value={"type": "new", "iface": "eth0"})
    @patch.object(nm, "_apply_config")
    def test_start_apply_sets_pending(self, mock_apply, mock_snapshot):
        nm.start_apply("eth0", {"ipv4": {"method": "auto"}}, rollback_seconds=30)
        info = nm.pending_info()
        self.assertIsNotNone(info)
        self.assertEqual(info["iface"], "eth0")
        self.assertTrue(0 < info["remaining"] <= 30)
        mock_apply.assert_called_once()

    @patch.object(nm, "_snapshot_connection", return_value={"type": "new", "iface": "eth0"})
    @patch.object(nm, "_apply_config")
    def test_confirm_clears_pending(self, mock_apply, mock_snapshot):
        nm.start_apply("eth0", {"ipv4": {"method": "auto"}}, rollback_seconds=30)
        self.assertIsNotNone(nm.pending_info())
        nm.confirm_pending()
        self.assertIsNone(nm.pending_info())

    @patch.object(nm, "_snapshot_connection", return_value={"type": "new", "iface": "eth0"})
    @patch.object(nm, "_apply_config")
    def test_reject_second_apply_when_pending(self, mock_apply, mock_snapshot):
        nm.start_apply("eth0", {"ipv4": {"method": "auto"}}, rollback_seconds=30)
        with self.assertRaises(nm.NMError):
            nm.start_apply("eth0", {"ipv4": {"method": "manual"}}, rollback_seconds=30)

    def test_confirm_without_pending_raises(self):
        with self.assertRaises(nm.NMError):
            nm.confirm_pending()

    def test_system_iface_rejected(self):
        with self.assertRaises(nm.NMError):
            nm.start_apply("lo", {"ipv4": {"method": "auto"}})

    def test_invalid_rollback_seconds(self):
        with self.assertRaises(nm.NMError):
            nm.start_apply("eth0", {"ipv4": {"method": "auto"}}, rollback_seconds=0)
        with self.assertRaises(nm.NMError):
            nm.start_apply("eth0", {"ipv4": {"method": "auto"}}, rollback_seconds=999)


class TestRunSafety(unittest.TestCase):
    """子进程调用安全测试"""

    @patch("subprocess.run")
    def test_run_with_arg_list(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="ok", stderr="")
        nm.run(["echo", "hello"])
        args, kwargs = mock_run.call_args
        self.assertIsInstance(args[0], list)
        self.assertEqual(args[0], ["echo", "hello"])


class TestApplyConfigValidation(unittest.TestCase):
    """_apply_config 输入校验测试（IP/网关/DNS 格式校验）"""

    def setUp(self):
        nm._pending = None

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_invalid_ipv4_address(self, mock_nmcli, _):
        with self.assertRaises(nm.NMError):
            nm._apply_config("eth0", {"ipv4": {"method": "manual", "address": "not-an-ip", "netmask": "24"}})

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_ipv6_address_in_ipv4_family(self, mock_nmcli, _):
        with self.assertRaises(nm.NMError):
            nm._apply_config("eth0", {"ipv4": {"method": "manual", "address": "2001:db8::1", "netmask": "24"}})

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_invalid_gateway(self, mock_nmcli, _):
        with self.assertRaises(nm.NMError):
            nm._apply_config("eth0", {"ipv4": {"method": "manual", "address": "192.168.1.10", "netmask": "24", "gateway": "bad-gw"}})

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_invalid_netmask(self, mock_nmcli, _):
        with self.assertRaises(nm.NMError):
            nm._apply_config("eth0", {"ipv4": {"method": "manual", "address": "192.168.1.10", "netmask": "abc"}})

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_invalid_dns_not_list(self, mock_nmcli, _):
        with self.assertRaises(nm.NMError):
            nm._apply_config("eth0", {"ipv4": {"method": "manual", "address": "192.168.1.10", "netmask": "24", "dns": "not-a-list"}})

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_invalid_dns_format(self, mock_nmcli, _):
        with self.assertRaises(nm.NMError):
            nm._apply_config("eth0", {"ipv4": {"method": "manual", "address": "192.168.1.10", "netmask": "24", "dns": ["not-an-ip"]}})

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_invalid_method(self, mock_nmcli, _):
        with self.assertRaises(nm.NMError):
            nm._apply_config("eth0", {"ipv4": {"method": "hacked"}})

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_valid_manual_config_passes(self, mock_nmcli, _):
        mock_nmcli.return_value = ""
        # 不抛异常就对了
        nm._apply_config("eth0", {
            "ipv4": {"method": "manual", "address": "192.168.1.10", "netmask": "24",
                     "gateway": "192.168.1.1", "dns": ["8.8.8.8", "1.1.1.1"]},
            "ipv6": {"method": "auto"},
        })
        self.assertTrue(mock_nmcli.called)

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_command_injection_in_address(self, mock_nmcli, _):
        """地址里带分号或空格应该被 ipaddress 拒绝，不能透传给 nmcli"""
        with self.assertRaises(nm.NMError):
            nm._apply_config("eth0", {"ipv4": {"method": "manual", "address": "192.168.1.10; rm -rf /", "netmask": "24"}})

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_switch_to_auto_clears_stale_manual_fields(self, mock_nmcli, _):
        """从 manual 切回 auto：上一次手动配置的地址/网关/DNS 必须被显式清空，
        不能让 nmcli 保留残留的静态字段（否则 DHCP 结果和旧静态值会一起生效）"""
        mock_nmcli.return_value = ""
        nm._apply_config("eth0", {"ipv4": {"method": "auto"}})
        # nmcli 被调两次：先 connection modify（带所有字段），再 connection up；
        # 取第一次调用的参数，不是 call_args（那是最后一次）
        args = mock_nmcli.call_args_list[0][0]
        self.assertIn("ipv4.addresses", args)
        self.assertEqual(args[args.index("ipv4.addresses") + 1], "")
        self.assertIn("ipv4.gateway", args)
        self.assertEqual(args[args.index("ipv4.gateway") + 1], "")
        self.assertIn("ipv4.dns", args)
        self.assertEqual(args[args.index("ipv4.dns") + 1], "")

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_disabled_method_also_clears_fields(self, mock_nmcli, _):
        mock_nmcli.return_value = ""
        nm._apply_config("eth0", {"ipv6": {"method": "disabled"}})
        args = mock_nmcli.call_args_list[0][0]
        self.assertEqual(args[args.index("ipv6.addresses") + 1], "")
        self.assertEqual(args[args.index("ipv6.gateway") + 1], "")
        self.assertEqual(args[args.index("ipv6.dns") + 1], "")

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_manual_config_still_sets_real_values(self, mock_nmcli, _):
        """回归护栏：清空非 manual 字段的改动不能连累 manual 模式本身的取值"""
        mock_nmcli.return_value = ""
        nm._apply_config("eth0", {
            "ipv4": {"method": "manual", "address": "192.168.1.10", "netmask": "24",
                     "gateway": "192.168.1.1", "dns": ["8.8.8.8", "1.1.1.1"]},
        })
        args = mock_nmcli.call_args_list[0][0]
        self.assertEqual(args[args.index("ipv4.addresses") + 1], "192.168.1.10/24")
        self.assertEqual(args[args.index("ipv4.gateway") + 1], "192.168.1.1")
        self.assertEqual(args[args.index("ipv4.dns") + 1], "8.8.8.8,1.1.1.1")


class TestFallbackAddress(unittest.TestCase):
    """出厂兜底地址：写路径结构性保留逻辑测试（_load_fallback_config 全程打桩，
    不落真文件——文件缺失时的默认行为由 TestApplyConfigValidation 那组既有测试
    间接覆盖：CI/开发机上不存在 /etc/ainvr-ai/fallback.json，走的正是 None 分支）"""

    FB = {"interface": "enP8p1s0", "address": "10.250.100.1", "prefix": 24}

    def test_no_fallback_config_is_noop(self):
        with patch.object(nm, "_load_fallback_config", return_value=None):
            self.assertEqual(nm._inject_protected_address("enP8p1s0", "ipv4", ""), "")
            self.assertEqual(nm._inject_protected_address("enP8p1s0", "ipv4", "1.2.3.4/24"), "1.2.3.4/24")

    def test_ipv6_never_touched(self):
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            self.assertEqual(nm._inject_protected_address("enP8p1s0", "ipv6", ""), "")

    def test_other_interface_untouched(self):
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            self.assertEqual(nm._inject_protected_address("wlP1p1s0", "ipv4", "1.2.3.4/24"), "1.2.3.4/24")

    def test_disabled_or_auto_leaves_only_protected(self):
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            self.assertEqual(nm._inject_protected_address("enP8p1s0", "ipv4", ""), "10.250.100.1/24")

    def test_manual_address_coexists_with_protected(self):
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            result = nm._inject_protected_address("enP8p1s0", "ipv4", "192.168.1.10/24")
            self.assertEqual(result, "10.250.100.1/24,192.168.1.10/24")

    def test_idempotent_when_already_injected(self):
        """回滚路径可能会把已经注入过的值再喂一次进来，不能被误判成冲突 (回归)"""
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            already = "10.250.100.1/24,192.168.1.10/24"
            self.assertEqual(nm._inject_protected_address("enP8p1s0", "ipv4", already), already)
            self.assertEqual(nm._inject_protected_address("enP8p1s0", "ipv4", "10.250.100.1/24"), "10.250.100.1/24")

    def test_reject_manual_address_reusing_protected_host_different_prefix(self):
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            with self.assertRaises(nm.NMError):
                nm._inject_protected_address("enP8p1s0", "ipv4", "10.250.100.1/16")

    def test_reject_main_address_inside_fallback_subnet(self):
        """主地址落在兜底网段（或与之重叠）会和兜底路由冲突，必须拒绝；其他网段照常"""
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            for bad in ("10.250.100.5/24", "10.250.100.200/28", "10.250.0.9/16"):
                with self.subTest(bad=bad), self.assertRaises(nm.NMError) as ctx:
                    nm._inject_protected_address("enP8p1s0", "ipv4", bad)
                self.assertIn("兜底", str(ctx.exception))
            self.assertEqual(nm._inject_protected_address("enP8p1s0", "ipv4", "192.168.100.185/17"),
                             "10.250.100.1/24,192.168.100.185/17")

    @patch.object(nm, "_get_active_connection", return_value="factory-fallback")
    @patch.object(nm, "nmcli")
    def test_apply_config_disabled_on_fallback_iface_keeps_protected(self, mock_nmcli, _):
        """回归：光把地址塞进 ipv4.addresses 不够——method 还是 disabled 的话
        NM 根本不会把任何 IPv4 地址带上网卡，"恢复出厂"点了之后兜底地址反而
        会失联。method 必须一并纠偏成 manual，地址才是真的活的。"""
        mock_nmcli.return_value = ""
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            nm._apply_config("enP8p1s0", {"ipv4": {"method": "disabled"}})
        args = mock_nmcli.call_args_list[0][0]
        self.assertEqual(args[args.index("ipv4.addresses") + 1], "10.250.100.1/24")
        self.assertEqual(args[args.index("ipv4.method") + 1], "manual")
        self.assertEqual(args[args.index("ipv4.never-default") + 1], "yes")

    @patch.object(nm, "_get_active_connection", return_value="factory-fallback")
    @patch.object(nm, "nmcli")
    def test_apply_config_link_local_on_fallback_iface_forced_manual(self, mock_nmcli, _):
        mock_nmcli.return_value = ""
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            nm._apply_config("enP8p1s0", {"ipv4": {"method": "link-local"}})
        args = mock_nmcli.call_args_list[0][0]
        self.assertEqual(args[args.index("ipv4.method") + 1], "manual")
        self.assertEqual(args[args.index("ipv4.addresses") + 1], "10.250.100.1/24")

    @patch.object(nm, "_get_active_connection", return_value="factory-fallback")
    @patch.object(nm, "nmcli")
    def test_apply_config_auto_on_fallback_iface_forced_manual(self, mock_nmcli, _):
        """auto（DHCP）在这台设备上没法实测"DHCP+叠加静态地址"这个 NM 行为
        是否真的会保留兜底地址（板子没插网线，connection up 无 carrier 直接
        拒绝）——不赌，统一按 manual 处理，兜底网卡从此不支持真 DHCP 当主
        配置（用户已确认接受这个取舍）。"""
        mock_nmcli.return_value = ""
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            nm._apply_config("enP8p1s0", {"ipv4": {"method": "auto"}})
        args = mock_nmcli.call_args_list[0][0]
        self.assertEqual(args[args.index("ipv4.method") + 1], "manual")
        self.assertEqual(args[args.index("ipv4.addresses") + 1], "10.250.100.1/24")

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_apply_config_disabled_on_non_fallback_iface_stays_disabled(self, mock_nmcli, _):
        """强改 method 只对兜底网卡生效，别的网卡该 disabled 还是 disabled (回归)"""
        mock_nmcli.return_value = ""
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            nm._apply_config("eth0", {"ipv4": {"method": "disabled"}})
        args = mock_nmcli.call_args_list[0][0]
        self.assertEqual(args[args.index("ipv4.method") + 1], "disabled")

    @patch.object(nm, "_get_active_connection", return_value="factory-fallback")
    @patch.object(nm, "nmcli")
    def test_apply_config_loads_fallback_config_once_per_family(self, mock_nmcli, _):
        mock_nmcli.return_value = ""
        with patch.object(nm, "_load_fallback_config", return_value=self.FB) as mock_load:
            nm._apply_config("enP8p1s0", {"ipv4": {"method": "disabled"}})
        self.assertEqual(mock_load.call_count, 1)

    @patch.object(nm, "_get_active_connection", return_value="factory-fallback")
    @patch.object(nm, "nmcli")
    def test_apply_config_manual_on_fallback_iface_coexists(self, mock_nmcli, _):
        mock_nmcli.return_value = ""
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            nm._apply_config("enP8p1s0", {
                "ipv4": {"method": "manual", "address": "192.168.1.10", "netmask": "24",
                         "gateway": "192.168.1.1"},
            })
        args = mock_nmcli.call_args_list[0][0]
        self.assertEqual(args[args.index("ipv4.addresses") + 1], "10.250.100.1/24,192.168.1.10/24")
        # 用户自己配了网关，说明这张网卡就是当主网卡用的，不能再强锁 never-default
        self.assertEqual(args[args.index("ipv4.never-default") + 1], "no")

    @patch.object(nm, "_get_active_connection", return_value="factory-fallback")
    @patch.object(nm, "nmcli")
    def test_apply_config_manual_address_equal_to_protected_collapses_harmlessly(self, mock_nmcli, _):
        """手动地址跟兜底地址主机位+前缀完全一样：不算冲突（没有产生重复地址），
        幂等地折叠成一条——真正需要拒绝的是"同主机位不同前缀"那种没法共存的情况"""
        mock_nmcli.return_value = ""
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            nm._apply_config("enP8p1s0", {
                "ipv4": {"method": "manual", "address": "10.250.100.1", "netmask": "24"},
            })
        args = mock_nmcli.call_args_list[0][0]
        self.assertEqual(args[args.index("ipv4.addresses") + 1], "10.250.100.1/24")

    @patch.object(nm, "_get_active_connection", return_value="factory-fallback")
    @patch.object(nm, "nmcli")
    def test_apply_config_rejects_protected_host_with_different_prefix(self, mock_nmcli, _):
        mock_nmcli.return_value = ""
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            with self.assertRaises(nm.NMError):
                nm._apply_config("enP8p1s0", {
                    "ipv4": {"method": "manual", "address": "10.250.100.1", "netmask": "16"},
                })

    @patch.object(nm, "_get_active_connection", return_value="TestCon")
    @patch.object(nm, "nmcli")
    def test_apply_config_untouched_on_non_fallback_iface(self, mock_nmcli, _):
        """不是兜底网卡，行为跟没有这个功能之前完全一样 (回归)"""
        mock_nmcli.return_value = ""
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            nm._apply_config("eth0", {"ipv4": {"method": "auto"}})
        args = mock_nmcli.call_args_list[0][0]
        self.assertEqual(args[args.index("ipv4.addresses") + 1], "")
        self.assertNotIn("ipv4.never-default", args)

    def test_get_fallback_info_none_without_config(self):
        with patch.object(nm, "_load_fallback_config", return_value=None):
            self.assertIsNone(nm.get_fallback_info())

    def test_get_fallback_info_reachable_flag(self):
        detail_with = {"ipv4": {"addresses": ["10.250.100.1/24"]}}
        with patch.object(nm, "_load_fallback_config", return_value=self.FB), \
             patch.object(nm, "_iface_detail", return_value=detail_with):
            info = nm.get_fallback_info()
            self.assertEqual(info["interface"], "enP8p1s0")
            self.assertEqual(info["address"], "10.250.100.1")
            self.assertTrue(info["reachable"])

    def test_get_fallback_info_unreachable_when_absent_from_iface(self):
        detail_without = {"ipv4": {"addresses": []}}
        with patch.object(nm, "_load_fallback_config", return_value=self.FB), \
             patch.object(nm, "_iface_detail", return_value=detail_without):
            info = nm.get_fallback_info()
            self.assertFalse(info["reachable"])


class TestApplySnapshotFallbackPreservation(unittest.TestCase):
    """回滚路径（_apply_snapshot）不能把兜底地址一起回滚没了"""

    FB = {"interface": "enP8p1s0", "address": "10.250.100.1", "prefix": 24}

    @patch.object(nm, "nmcli")
    def test_existing_snapshot_reinjects_if_missing(self, mock_nmcli):
        mock_nmcli.return_value = ""
        snapshot = {
            "type": "existing", "conn_name": "factory-fallback",
            "ipv4.method": "auto", "ipv4.addresses": "", "ipv4.gateway": "", "ipv4.dns": "",
            "ipv6.method": "disabled", "ipv6.addresses": "", "ipv6.gateway": "", "ipv6.dns": "",
        }
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            nm._apply_snapshot("enP8p1s0", snapshot)
        args = mock_nmcli.call_args_list[0][0]
        self.assertEqual(args[args.index("ipv4.addresses") + 1], "10.250.100.1/24")
        # 快照里存的是 auto，也要被强改成 manual——跟 _apply_config 同一条规则
        self.assertEqual(args[args.index("ipv4.method") + 1], "manual")

    @patch.object(nm, "nmcli")
    def test_existing_snapshot_with_disabled_method_forced_manual(self, mock_nmcli):
        """快照里存的 ipv4.method 是修复前留下的 disabled：光靠防御性地址
        注入不够，method 也必须纠偏，不然自动回滚会把网卡回滚回"看起来有
        地址、实际不生效"的状态 (回归)"""
        mock_nmcli.return_value = ""
        snapshot = {
            "type": "existing", "conn_name": "factory-fallback",
            "ipv4.method": "disabled", "ipv4.addresses": "10.250.100.1/24",
            "ipv4.gateway": "", "ipv4.dns": "",
            "ipv6.method": "disabled", "ipv6.addresses": "", "ipv6.gateway": "", "ipv6.dns": "",
        }
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            nm._apply_snapshot("enP8p1s0", snapshot)
        args = mock_nmcli.call_args_list[0][0]
        self.assertEqual(args[args.index("ipv4.method") + 1], "manual")

    @patch.object(nm, "nmcli")
    def test_existing_snapshot_disabled_method_untouched_on_non_fallback_iface(self, mock_nmcli):
        mock_nmcli.return_value = ""
        snapshot = {
            "type": "existing", "conn_name": "TestCon",
            "ipv4.method": "disabled", "ipv4.addresses": "",
            "ipv4.gateway": "", "ipv4.dns": "",
            "ipv6.method": "disabled", "ipv6.addresses": "", "ipv6.gateway": "", "ipv6.dns": "",
        }
        with patch.object(nm, "_load_fallback_config", return_value=self.FB):
            nm._apply_snapshot("eth0", snapshot)
        args = mock_nmcli.call_args_list[0][0]
        self.assertEqual(args[args.index("ipv4.method") + 1], "disabled")

    @patch.object(nm, "nmcli")
    def test_new_snapshot_on_fallback_iface_recreates_protected_only(self, mock_nmcli):
        """连一个 profile 都没有的情况下回滚（provisioning 还没跑完时的边界情况）：
        不能只删了事，得把兜底地址重新建回来 (回归)"""
        mock_nmcli.return_value = ""
        with patch.object(nm, "_load_fallback_config", return_value=self.FB), \
             patch.object(nm, "_get_active_connection", return_value=None):
            nm._apply_snapshot("enP8p1s0", {"type": "new", "iface": "enP8p1s0"})
        # 第一次 nmcli 调用是 delete；后面 _apply_config 会走 connection add + modify + up
        calls = [c[0] for c in mock_nmcli.call_args_list]
        self.assertIn(("connection", "delete", "os-helper-enP8p1s0"), calls)
        modify_call = next(c for c in calls if c[:2] == ("connection", "modify"))
        self.assertEqual(modify_call[modify_call.index("ipv4.addresses") + 1], "10.250.100.1/24")
        # 这条路径内部也是走 _apply_config({"method": "disabled"})，同样吃
        # 强改 manual 那条规则，不然重建出来的 profile 一样是个死的 (回归)
        self.assertEqual(modify_call[modify_call.index("ipv4.method") + 1], "manual")


if __name__ == "__main__":
    unittest.main()
