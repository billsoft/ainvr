"""
NetworkManager (nmcli) 封装层 — os-helper 网卡管理模块

职责:
  1. 枚举物理网卡(有线 / 无线), 过滤 docker / l4tbr0 / usb0 等系统虚拟网卡
  2. 读取运行时状态 (IP / 网关 / DNS / 链路) 与配置文件 (auto / manual)
  3. 修改 IPv4 / IPv6 配置, 并带"安全回滚": 应用后 N 秒内未确认则自动还原
  4. Wi-Fi 扫描 / 连接 / 断开
  5. 连通性检测: 网关 ping、外网 ping、DNS 解析 (全部绑定到指定网卡)

安全约束:
  - 只用 subprocess 参数列表调用 nmcli / ping, 绝不拼 shell 字符串
  - 网卡名严格正则校验, 防止命令注入
  - 系统虚拟网卡默认不展示、不允许修改
  - 所有写操作有白名单校验

从 system-service/et_demo/jetson-web/backend/nm.py 迁移并适配。
"""
from __future__ import annotations

import ipaddress
import fcntl
import json
import os
import random
import re
import socket
import struct
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

# =========================== 安全常量 ===========================

IFACE_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,16}$")
"""网卡名严格正则，防止命令注入。Linux 网卡名最长 IFNAMSIZ-1=15 字符，但 p2p-* 前缀会超。"""

# Jetson 上这些是系统内部 / 虚拟网卡, 默认不展示, 也不允许改 IP
#   l4tbr0 / usb0 / rndis0 : USB Device Mode (192.168.55.1), 刷机和 SSH-over-USB 用, 改了会失联
SYSTEM_PREFIXES = (
    "lo", "docker", "veth", "br-", "virbr", "l4tbr", "usb", "rndis",
    "tun", "tap", "zt", "tailscale", "dummy", "nvethernet", "can",
    "p2p-dev-",
)

# 连通性检测用的公网 IP / 域名
INTERNET_V4 = os.getenv("CHECK_V4", "223.5.5.5,1.1.1.1").split(",")
INTERNET_V6 = os.getenv("CHECK_V6", "2400:3200::1,2606:4700:4700::1111").split(",")
DNS_TEST_NAME = os.getenv("CHECK_DOMAIN", "www.baidu.com")

# 安全回滚默认超时（秒）
DEFAULT_ROLLBACK_SECONDS = 30
MAX_ROLLBACK_SECONDS = 300

# 出厂兜底地址配置文件路径。只读——由独立的 provisioning 组件在开机时写入，
# os-helper 自己永远不写这个文件。文件不存在时，本模块所有写操作行为与
# "没有兜底地址功能"完全一致，不是降级，是没走 provisioning 流程的正常状态。
FALLBACK_CONFIG_PATH = os.getenv("FALLBACK_CONFIG_PATH", "/etc/ainvr-ai/fallback.json")


class NMError(RuntimeError):
    """NetworkManager 操作错误。"""
    pass


# =========================== 底层工具 ===========================

def _validate_iface(name: str) -> str:
    """校验网卡名合法性，不通过直接抛错。返回规范化的名字。"""
    if not IFACE_RE.match(name):
        raise NMError(f"非法网卡名: {name}")
    return name


def _is_system_iface(name: str) -> bool:
    """判断是否为系统虚拟网卡（默认不展示、不允许修改）。"""
    return any(name.startswith(p) for p in SYSTEM_PREFIXES)


def run(cmd: list[str], timeout: int = 15, check: bool = True) -> str:
    """安全执行外部命令。用参数列表，绝不拼 shell。"""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise NMError(f"命令超时: {' '.join(cmd[:4])}")
    except FileNotFoundError:
        raise NMError(f"找不到命令 {cmd[0]}, 请确认已安装 NetworkManager")
    if check and p.returncode != 0:
        raise NMError((p.stderr or p.stdout).strip() or f"{cmd[0]} 执行失败")
    return p.stdout


def nmcli(*args: str, timeout: int = 15) -> str:
    """调用 nmcli -t（terse 输出，便于解析）。"""
    return run(["nmcli", "-t", *args], timeout=timeout)


def _unescape(v: str) -> str:
    """nmcli -t 会把值里的 ':' 转成 '\\:' (IPv6 / MAC 地址全是冒号!), '\\' 转成 '\\\\'"""
    return v.replace("\\:", ":").replace("\\\\", "\\")


def parse_kv(text: str) -> dict[str, str]:
    """解析 nmcli -t show 输出的 KEY:VALUE 格式。"""
    d: dict[str, str] = {}
    for line in text.splitlines():
        if not line:
            continue
        k, _, v = line.partition(":")  # key 里没有冒号, 只切第一个
        d[k] = _unescape(v)
    return d


def split_terse(line: str) -> list[str]:
    """按未转义的冒号拆分 terse 行。"""
    return [_unescape(p) for p in re.split(r"(?<!\\):", line)]


# =========================== 网卡列表 ===========================

def list_interfaces(include_system: bool = False) -> list[dict[str, Any]]:
    """
    列出所有网卡，返回列表。
    默认过滤系统虚拟网卡（docker/veth/lo/l4tbr 等）。
    """
    try:
        out = nmcli("device", "status")
    except NMError:
        return _list_interfaces_ip(include_system)

    devices: list[dict[str, Any]] = []
    for line in out.splitlines():
        if not line:
            continue
        parts = split_terse(line)
        if len(parts) < 4:
            continue
        name, dtype, state, conn = parts[0], parts[1], parts[2], parts[3]

        if not include_system and _is_system_iface(name):
            continue

        dev = {
            "name": name,
            "kind": _classify_kind(name, dtype),
            "state": state,
            "connected": state in ("已连接", "connected", "已连接（外部）", "connected (external)"),
            "carrier": _check_carrier(name),
            "connection": conn if conn and conn != "--" else None,
            "system": _is_system_iface(name),
        }
        dev.update(_iface_detail(name))
        devices.append(dev)

    return devices


def _classify_kind(name: str, nm_type: str) -> str:
    if nm_type in ("wifi", "无线"):
        return "wifi"
    if nm_type in ("ethernet", "以太网"):
        return "ethernet"
    if nm_type in ("bridge", "网桥"):
        return "bridge"
    if name.startswith("wl"):
        return "wifi"
    return "ethernet"


def _check_carrier(name: str) -> bool:
    """通过 sysfs 检查物理链路是否 UP（网线插上了）。读取失败返回 False。"""
    try:
        path = f"/sys/class/net/{_validate_iface(name)}/carrier"
        return open(path).read().strip() == "1"
    except (FileNotFoundError, PermissionError, ValueError, OSError):
        return False


def _iface_detail(name: str) -> dict[str, Any]:
    """获取单个网卡的详细信息（IP、MAC、网关、DNS 等）。查询失败降级返回基础结构。"""
    detail: dict[str, Any] = {
        "mac": None, "mtu": None, "speed": None,
        "ipv4": {"method": "disabled", "addresses": [], "gateway": None, "dns": []},
        "ipv6": {"method": "disabled", "addresses": [], "gateway": None, "dns": []},
    }

    # 用 ip 命令拿运行时信息
    try:
        ip_out = run(["ip", "-j", "addr", "show", name], timeout=3)
        info = json.loads(ip_out)
        if info:
            iface = info[0]
            detail["mac"] = iface.get("address")
            detail["mtu"] = iface.get("mtu")
            for a in iface.get("addr_info", []):
                family = a.get("family")
                addr = a.get("local", "")
                prefix = a.get("prefixlen", 0)
                if family == "inet":
                    detail["ipv4"]["addresses"].append(f"{addr}/{prefix}")
                elif family == "inet6" and not addr.startswith("fe80"):
                    detail["ipv6"]["addresses"].append(f"{addr}/{prefix}")
    except (subprocess.SubprocessError, ValueError, ImportError, NMError):
        pass

    # 用 NM 拿配置方式和网关/DNS
    try:
        conn_out = nmcli("-f", "NAME,DEVICE,STATE", "connection", "show", "--active")
        for line in conn_out.splitlines():
            parts = split_terse(line)
            if len(parts) >= 3 and parts[1] == name and parts[2] == "activated":
                conn_name = parts[0]
                detail["connection"] = conn_name
                try:
                    show_out = nmcli("connection", "show", conn_name)
                    show = parse_kv(show_out)
                    detail["ipv4"]["method"] = show.get("ipv4.method", "auto")
                    detail["ipv6"]["method"] = show.get("ipv6.method", "auto")
                    gw4 = show.get("ipv4.gateway")
                    gw6 = show.get("ipv6.gateway")
                    if gw4 and gw4 != "--":
                        detail["ipv4"]["gateway"] = gw4
                    if gw6 and gw6 != "--":
                        detail["ipv6"]["gateway"] = gw6
                    dns4 = show.get("ipv4.dns", "")
                    dns6 = show.get("ipv6.dns", "")
                    if dns4 and dns4 != "--":
                        detail["ipv4"]["dns"] = dns4.split(",")
                    if dns6 and dns6 != "--":
                        detail["ipv6"]["dns"] = dns6.split(",")
                except NMError:
                    pass
                break
    except NMError:
        pass

    return detail


def _list_interfaces_ip(include_system: bool = False) -> list[dict[str, Any]]:
    """降级方案：NM 不可用时用 ip 命令列网卡。"""
    try:
        out = run(["ip", "-j", "link", "show"], timeout=3)
        ifaces = json.loads(out)
    except Exception:
        return []

    result = []
    for iface in ifaces:
        name = iface.get("ifname", "")
        if not name:
            continue
        if not include_system and _is_system_iface(name):
            continue
        result.append({
            "name": name,
            "kind": "wifi" if name.startswith("wl") else "ethernet",
            "state": iface.get("operstate", "UNKNOWN"),
            "connected": iface.get("operstate") == "UP",
            "carrier": _check_carrier(name),
            "connection": None,
            "system": _is_system_iface(name),
            **_iface_detail(name),
        })
    return result


# =========================== 出厂兜底地址 ===========================

def _load_fallback_config() -> dict[str, Any] | None:
    """读取出厂兜底地址配置。不存在/格式非法一律返回 None（见 FALLBACK_CONFIG_PATH 注释）。"""
    try:
        with open(FALLBACK_CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        iface = _validate_iface(cfg["interface"])
        addr = cfg["address"]
        prefix = int(cfg["prefix"])
        if not isinstance(ipaddress.ip_address(addr), ipaddress.IPv4Address):
            raise ValueError("兜底地址必须是 IPv4")
        if not 0 <= prefix <= 32:
            raise ValueError("非法前缀")
        return {"interface": iface, "address": addr, "prefix": prefix}
    except (FileNotFoundError, ValueError, KeyError, TypeError, OSError,
            json.JSONDecodeError, NMError, ipaddress.AddressValueError):
        return None


def get_fallback_info() -> dict[str, Any] | None:
    """出厂兜底地址信息，供 GET /network/fallback 使用。

    reachable 表示该地址此刻是否真的挂在网卡上——网线没插、profile 被外部
    删掉、还没走完 provisioning 都会让它暂时是 False，这不代表配置错误。
    """
    cfg = _load_fallback_config()
    if cfg is None:
        return None
    reachable = False
    try:
        detail = _iface_detail(cfg["interface"])
        cidr = f"{cfg['address']}/{cfg['prefix']}"
        reachable = cidr in detail["ipv4"]["addresses"]
    except Exception:
        pass
    return {
        "interface": cfg["interface"],
        "address": cfg["address"],
        "prefix": cfg["prefix"],
        "reachable": reachable,
    }


def _inject_protected_address(
    iface: str, family: str, addr_value: str, fb: dict[str, Any] | None = None,
) -> str:
    """把兜底地址结构性地并入 ipv4.addresses 的最终取值。

    不是"校验用户有没有删掉兜底地址再拒绝"，是根本不给客户端提交的内容
    决定兜底地址在不在——只要这张网卡是兜底网卡，兜底地址就必定出现在
    最终写给 nmcli 的 addresses 值里（method 是否为 disabled 由调用方
    负责改写，见 _apply_config——addresses 里有值但 method=disabled 时
    NM 根本不会把任何 IPv4 地址带上网卡，单靠这个函数保证不了"活着"）。

    幂等：addr_value 里已经带着兜底地址也不会重复注入（_apply_snapshot
    回滚时可能会拿一个已经注入过的值再走一遍这里）。

    fb: 调用方如果已经 _load_fallback_config() 过，传进来复用，省一次
    读文件；不传时自己读一次（默认行为，兼容旧调用方）。
    """
    if family != "ipv4":
        return addr_value
    if fb is None:
        fb = _load_fallback_config()
    if not fb or fb["interface"] != iface:
        return addr_value

    protected_cidr = f"{fb['address']}/{fb['prefix']}"
    entries = [e for e in addr_value.split(",") if e]
    if protected_cidr in entries:
        return addr_value

    others = [e for e in entries if e.split("/")[0] != fb["address"]]
    if len(others) != len(entries):
        # 有一条用了兜底地址的主机位但前缀不一样——当成冲突，不能悄悄改前缀
        raise NMError(f"{fb['address']} 是系统保留的兜底地址，不能用作主地址")

    # 主地址与兜底地址同网段（或网段重叠）会与兜底路由冲突：兜底地址和主地址是
    # 同一张网卡上两个独立的地址，主地址必须在别的网段
    protected_net = ipaddress.ip_network(protected_cidr, strict=False)
    for entry in others:
        try:
            net = ipaddress.ip_network(entry, strict=False)
        except ValueError:
            continue
        if net.version == 4 and net.overlaps(protected_net):
            raise NMError(f"主地址 {entry} 与出厂兜底地址 {protected_cidr} 网段重叠，会与兜底路由冲突，请使用其他网段")

    return ",".join([protected_cidr] + others) if others else protected_cidr


# =========================== IP 配置（带安全回滚） ===========================

_pending_lock = threading.Lock()
_pending: dict[str, Any] | None = None
_rollback_timer: threading.Timer | None = None


def pending_info() -> dict[str, Any] | None:
    """获取当前待确认的变更状态（供前端轮询）。"""
    with _pending_lock:
        if _pending is None:
            return None
        remaining = max(0, _pending["deadline"] - time.time())
        return {
            "id": _pending["id"],
            "iface": _pending["iface"],
            "state": "applying" if remaining >= _pending["seconds"] - 0.5 else "waiting_confirm",
            "remaining": int(remaining),
        }


def start_apply(iface: str, config: dict[str, Any], rollback_seconds: int = DEFAULT_ROLLBACK_SECONDS) -> None:
    """
    应用新的 IP 配置，并启动安全回滚计时器。
    rollback_seconds 秒内未调用 confirm_pending() 则自动还原。
    """
    _validate_iface(iface)
    if _is_system_iface(iface):
        raise NMError("系统网卡不允许修改")
    if rollback_seconds <= 0 or rollback_seconds > MAX_ROLLBACK_SECONDS:
        raise NMError(f"回滚时间必须在 1-{MAX_ROLLBACK_SECONDS} 秒")

    current = _snapshot_connection(iface)
    if current is None:
        raise NMError(f"无法获取网卡 {iface} 当前配置，不能安全修改")

    with _pending_lock:
        global _pending, _rollback_timer
        if _pending is not None:
            raise NMError("已有待确认的变更，请先确认或回滚")

        _apply_config(iface, config)

        _pending = {
            # 每次变更唯一：前端按它计"连续可访问"并在确认时带回，旧页面/旧计时
            # 不会误确认一次新的变更
            "id": uuid.uuid4().hex[:16],
            "iface": iface,
            "snapshot": current,
            "seconds": rollback_seconds,
            "deadline": time.time() + rollback_seconds,
        }

        if _rollback_timer:
            _rollback_timer.cancel()
        _rollback_timer = threading.Timer(rollback_seconds, _auto_rollback)
        _rollback_timer.daemon = True
        _rollback_timer.start()


def confirm_pending(change_id: str | None = None) -> None:
    """确认当前变更，取消回滚计时器。

    change_id 为前端看到的变更 ID：与当前待确认变更不符时拒绝（那是另一次变更）。
    不带 ID 时按旧行为确认当前变更（兼容未升级的控制台）。
    """
    with _pending_lock:
        global _pending, _rollback_timer
        if _pending is None:
            raise NMError("没有待确认的变更")
        if change_id is not None and change_id != _pending["id"]:
            raise NMError("待确认的变更已变化，请刷新页面后重新确认")
        if _rollback_timer:
            _rollback_timer.cancel()
            _rollback_timer = None
        _pending = None


def revert_pending() -> None:
    """手动回滚到上一个配置。"""
    with _pending_lock:
        if _pending is None:
            raise NMError("没有待回滚的变更")
        _do_rollback()


def _auto_rollback() -> None:
    """超时自动回滚（在计时器线程中调用）。"""
    with _pending_lock:
        if _pending is None:
            return
        try:
            _do_rollback()
        except Exception:
            pass


def _do_rollback() -> None:
    """执行回滚。调用前必须持有 _pending_lock。"""
    global _pending, _rollback_timer
    if _pending is None:
        return
    iface = _pending["iface"]
    snapshot = _pending["snapshot"]
    try:
        _apply_snapshot(iface, snapshot)
    finally:
        if _rollback_timer:
            _rollback_timer.cancel()
            _rollback_timer = None
        _pending = None


def _snapshot_connection(iface: str) -> dict[str, Any] | None:
    """获取当前 connection 的完整配置（用于回滚）。"""
    try:
        conn_name = _get_active_connection(iface)
        if not conn_name:
            return {"type": "new", "iface": iface}
        out = nmcli("connection", "show", conn_name)
        show = parse_kv(out)
        return {
            "type": "existing",
            "conn_name": conn_name,
            "ipv4.method": show.get("ipv4.method", "auto"),
            "ipv4.addresses": show.get("ipv4.addresses", ""),
            "ipv4.gateway": show.get("ipv4.gateway", ""),
            "ipv4.dns": show.get("ipv4.dns", ""),
            "ipv6.method": show.get("ipv6.method", "auto"),
            "ipv6.addresses": show.get("ipv6.addresses", ""),
            "ipv6.gateway": show.get("ipv6.gateway", ""),
            "ipv6.dns": show.get("ipv6.dns", ""),
        }
    except NMError:
        return None


def _get_active_connection(iface: str) -> str | None:
    """获取指定网卡当前活动的 connection 名称。"""
    try:
        out = nmcli("-f", "NAME,DEVICE,STATE", "connection", "show", "--active")
        for line in out.splitlines():
            parts = split_terse(line)
            if len(parts) >= 3 and parts[1] == iface and parts[2] == "activated":
                return parts[0]
    except NMError:
        pass
    return None


def _apply_config(iface: str, config: dict[str, Any]) -> None:
    """
    应用 IP 配置到指定网卡。
    config 格式: {
        "ipv4": {"method": "auto|manual|disabled|link-local", "address": "", "netmask": "", "gateway": "", "dns": []},
        "ipv6": {"method": "auto|manual|disabled|link-local", "address": "", "netmask": "", "gateway": "", "dns": []},
    }

    非 manual 模式（auto/disabled/link-local）会把 addresses/gateway/dns 显式清空
    （传空字符串给 nmcli）。NetworkManager 不会因为切到 auto 就自动丢弃 profile 上
    残留的静态字段——之前只在 manual 分支里才写这三个属性，切回 auto 后旧的静态
    DNS/网关仍留在 profile 上继续生效，"切回自动"名不副实。
    """
    conn_name = _get_active_connection(iface)
    if not conn_name:
        dtype = "wifi" if iface.startswith("wl") else "ethernet"
        conn_name = f"os-helper-{iface}"
        nmcli("connection", "add", "type", dtype, "ifname", iface, "con-name", conn_name)

    args = ["connection", "modify", conn_name]

    for family in ("ipv4", "ipv6"):
        fc = config.get(family, {})
        method = fc.get("method", "auto")
        if method not in ("auto", "manual", "disabled", "link-local"):
            raise NMError(f"非法的 {family} method: {method}")

        addr_value = ""
        gw_value = ""
        dns_value = ""

        if method == "manual":
            addr = fc.get("address", "").strip()
            netmask = fc.get("netmask", "").strip()
            if not addr:
                raise NMError(f"手动模式需要指定 {family} 地址")
            # 格式校验：IP 必须合法
            try:
                ip_addr = ipaddress.ip_address(addr)
                if family == "ipv4" and not isinstance(ip_addr, ipaddress.IPv4Address):
                    raise ValueError("not v4")
                if family == "ipv6" and not isinstance(ip_addr, ipaddress.IPv6Address):
                    raise ValueError("not v6")
            except (ValueError, ipaddress.AddressValueError):
                raise NMError(f"非法的 {family} 地址: {addr}")
            # 前缀/掩码校验
            if netmask and "." in netmask and family == "ipv4":
                try:
                    prefix = sum(bin(int(x)).count("1") for x in netmask.split("."))
                except (ValueError, IndexError):
                    raise NMError(f"非法的子网掩码: {netmask}")
                if not 0 <= prefix <= 32:
                    raise NMError(f"非法的子网掩码: {netmask}")
            elif netmask:
                try:
                    prefix = int(netmask)
                except ValueError:
                    raise NMError(f"非法的前缀长度: {netmask}")
                max_prefix = 32 if family == "ipv4" else 128
                if not 0 <= prefix <= max_prefix:
                    raise NMError(f"前缀长度超出范围: {prefix}")
            else:
                prefix = 24 if family == "ipv4" else 64
            addr_value = f"{addr}/{prefix}"

            gw = fc.get("gateway", "").strip()
            if gw:
                try:
                    gw_ip = ipaddress.ip_address(gw)
                    if family == "ipv4" and not isinstance(gw_ip, ipaddress.IPv4Address):
                        raise ValueError("not v4")
                    if family == "ipv6" and not isinstance(gw_ip, ipaddress.IPv6Address):
                        raise ValueError("not v6")
                except (ValueError, ipaddress.AddressValueError):
                    raise NMError(f"非法的 {family} 网关: {gw}")
                gw_value = gw

            dns = fc.get("dns", [])
            if dns:
                if not isinstance(dns, list):
                    raise NMError("DNS 必须是列表")
                if len(dns) > 6:
                    raise NMError("DNS 服务器最多 6 个")
                for d in dns:
                    if not isinstance(d, str) or len(d) > 45:
                        raise NMError(f"非法 DNS 地址: {str(d)[:20]}")
                    try:
                        ipaddress.ip_address(d)
                    except (ValueError, ipaddress.AddressValueError):
                        raise NMError(f"非法 DNS 地址: {d}")
                dns_value = ",".join(dns)

        fb = _load_fallback_config() if family == "ipv4" else None
        if fb and fb["interface"] == iface:
            addr_value = _inject_protected_address(iface, family, addr_value, fb=fb)
            if method != "manual":
                # 只有 manual 能 100% 确定 NM 会把 addresses 里的静态地址
                # 带上网卡——disabled 直接跳过 IPv4；link-local 走自动生成；
                # auto/DHCP 理论上支持叠加静态地址，但这台设备没法在没插
                # 网线的情况下实测验证（nmcli connection up 无 carrier 直接
                # 拒绝），干脆不赌，统一强改成 manual。代价是这张网卡永远
                # 不能再用真 DHCP 当主配置——兜底地址的可靠性优先于这点
                # 灵活性。用户如果想让这张口继续用 DHCP，只能换一张网卡。
                method = "manual"

        args += [f"{family}.method", method]
        args += [f"{family}.addresses", addr_value,
                 f"{family}.gateway", gw_value,
                 f"{family}.dns", dns_value]

        if fb and fb["interface"] == iface:
            # 兜底地址本身没有网关；只有当用户没有在这张网卡上配置真实
            # 网关时才强制 never-default，防止兜底 profile 被 NM 误选为
            # 默认路由来源。用户若把这张网卡当成真正的主网卡用（配了
            # 自己的网关），必须让它能正常参选默认路由，这里就不再强锁。
            args += ["ipv4.never-default", "no" if gw_value else "yes"]

    nmcli(*args)
    nmcli("connection", "up", conn_name)


def _apply_snapshot(iface: str, snapshot: dict[str, Any]) -> None:
    """从快照恢复配置（回滚用）。"""
    if snapshot["type"] == "new":
        conn_name = f"os-helper-{iface}"
        try:
            nmcli("connection", "delete", conn_name)
        except NMError:
            pass
        fb = _load_fallback_config()
        if fb and fb["interface"] == iface:
            # 回滚前这张网卡本来就没有 profile（说明还没走完 provisioning），
            # 但兜底地址不能跟着这次回滚一起被删掉——重建一个只带兜底地址
            # 的 profile，等价于"恢复出厂"那条路径。
            try:
                _apply_config(iface, {"ipv4": {"method": "disabled"}, "ipv6": {"method": "disabled"}})
            except NMError:
                pass
        return

    conn_name = snapshot["conn_name"]
    fb = _load_fallback_config()
    is_fallback_iface = bool(fb and fb["interface"] == iface)
    args = ["connection", "modify", conn_name]
    for key in ("ipv4.method", "ipv4.addresses", "ipv4.gateway", "ipv4.dns",
                "ipv6.method", "ipv6.addresses", "ipv6.gateway", "ipv6.dns"):
        val = snapshot.get(key, "")
        val = val if val != "--" else ""
        if key == "ipv4.addresses":
            # 快照本应已经带着兜底地址（它一直都在网卡上），这里是防御性兜底，
            # 不依赖"快照拍的时候兜底地址刚好在"这个假设。
            val = _inject_protected_address(iface, "ipv4", val, fb=fb)
        if key == "ipv4.method" and is_fallback_iface and val != "manual":
            # 快照里存的 method 可能是 disabled/auto/link-local——地址字段会被
            # 上面的防御性注入补回来，但只有 manual 能保证 NM 真把它带上网卡，
            # 回滚就白回了。跟 _apply_config 用同一条规则（含 auto 一并强改）。
            val = "manual"
        args += [key, val]

    try:
        nmcli(*args)
        nmcli("connection", "up", conn_name)
    except NMError:
        try:
            nmcli("connection", "up", conn_name)
        except NMError:
            pass


# =========================== Wi-Fi ===========================

def wifi_scan(iface: str, rescan: bool = True) -> list[dict[str, Any]]:
    """扫描附近的 Wi-Fi 网络。"""
    _validate_iface(iface)
    if _is_system_iface(iface):
        raise NMError("系统网卡不允许操作")

    if rescan:
        try:
            run(["nmcli", "device", "wifi", "rescan", "ifname", iface], timeout=10, check=False)
        except NMError:
            pass
        time.sleep(0.5)

    try:
        out = run(["nmcli", "-t", "-f", "SSID,BSSID,MODE,CHAN,RATE,SIGNAL,SECURITY,ACTIVE",
                   "device", "wifi", "list", "ifname", iface], timeout=8)
    except NMError:
        return []

    aps_by_ssid: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for line in out.splitlines():
        if not line:
            continue
        parts = split_terse(line)
        if len(parts) < 7:
            continue
        ssid = parts[0]
        if not ssid or ssid == "--":
            continue
        ap = {
            "ssid": ssid,
            "bssid": parts[1],
            "mode": parts[2],
            "channel": int(parts[3]) if parts[3].isdigit() else None,
            "rate": parts[4],
            "signal": int(parts[5]) if parts[5].isdigit() else 0,
            "security": parts[6],
            # nmcli 的 ACTIVE 列随系统 locale 输出 yes/no 或 是/否
            "active": parts[7] in ("yes", "是") if len(parts) > 7 else False,
        }
        # 同一 SSID 常有多个 BSSID（双频/多 AP），nmcli 会输出多行，
        # 当前关联的那个 BSSID 不一定排第一。合并：active 标记 OR 保留
        # （否则前端永远看不到"已连接"，断开按钮也永远禁用），展示信息
        # 取信号最强的那一行。
        if ssid in aps_by_ssid:
            existing = aps_by_ssid[ssid]
            existing["active"] = existing["active"] or ap["active"]
            if ap["signal"] > existing["signal"]:
                existing.update({
                    "bssid": ap["bssid"], "channel": ap["channel"],
                    "rate": ap["rate"], "signal": ap["signal"],
                })
        else:
            aps_by_ssid[ssid] = ap
            order.append(ssid)
    return [aps_by_ssid[s] for s in order]


def wifi_connect(iface: str, ssid: str, password: str | None = None, hidden: bool = False) -> None:
    """连接到指定 Wi-Fi 网络。"""
    _validate_iface(iface)
    if _is_system_iface(iface):
        raise NMError("系统网卡不允许操作")
    if not ssid or len(ssid) > 32:
        raise NMError("SSID 长度必须在 1-32 之间")

    args = ["device", "wifi", "connect", ssid, "ifname", iface]
    if password:
        if len(password) > 64:
            raise NMError("Wi-Fi 密码不能超过 64 位")
        args += ["password", password]
    if hidden:
        args += ["hidden", "yes"]

    nmcli(*args, timeout=30)


def wifi_disconnect(iface: str) -> None:
    """断开 Wi-Fi 连接。"""
    _validate_iface(iface)
    if _is_system_iface(iface):
        raise NMError("系统网卡不允许操作")
    try:
        nmcli("device", "disconnect", iface, timeout=10)
    except NMError as e:
        if "not connected" in str(e).lower():
            return
        raise


# =========================== 连通性检测 ===========================

def _ping(target: str, iface: str, timeout: float = 3.0) -> tuple[bool, float | None]:
    """
    在指定网卡上 ping 一个目标地址。
    返回 (是否成功, 延迟毫秒)。
    """
    try:
        ipaddress.ip_address(target)
    except ValueError:
        return False, None

    is_v6 = ":" in target
    cmd = ["ping", "-6" if is_v6 else "-4", "-c", "1", "-W", str(int(timeout)),
           "-I", iface, target]
    try:
        start = time.time()
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 1)
        elapsed = (time.time() - start) * 1000
        if p.returncode == 0:
            return True, round(elapsed, 1)
    except subprocess.TimeoutExpired:
        pass
    return False, None


def _dns_resolve(name: str, iface: str, timeout: float = 3.0) -> bool:
    """在指定网卡上做 DNS 解析。"""
    # 优先用 dig 测指定 DNS 服务器
    dns_server = INTERNET_V4[0]
    try:
        p = subprocess.run(
            ["dig", "+short", "+time=2", "+tries=1", f"@{dns_server}", name, "-b",
             _get_iface_ip(iface) or "0.0.0.0"],
            capture_output=True, text=True, timeout=timeout
        )
        return p.returncode == 0 and bool(p.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    # 降级：系统 DNS
    try:
        socket.setdefaulttimeout(timeout)
        socket.getaddrinfo(name, None)
        return True
    except (socket.gaierror, socket.timeout):
        return False


def _get_iface_ip(iface: str) -> str | None:
    """获取指定网卡的 IPv4 地址（用于 dig -b 绑定源 IP）。"""
    detail = _iface_detail(iface)
    addrs = detail["ipv4"]["addresses"]
    if addrs:
        return addrs[0].split("/")[0]
    return None


def check_connectivity(iface: str) -> dict[str, Any]:
    """
    检测指定网卡的连通性：网关、外网（IPv4/IPv6）、DNS。
    """
    _validate_iface(iface)

    result = {
        "iface": iface,
        "gateway": {"ok": False, "latency": None},
        "internet_v4": {"ok": False, "latency": None},
        "internet_v6": {"ok": False, "latency": None},
        "dns": {"ok": False, "latency": None},
    }

    detail = _iface_detail(iface)
    gw4 = detail["ipv4"]["gateway"]

    def test_gateway():
        if gw4:
            ok, lat = _ping(gw4, iface)
            result["gateway"] = {"ok": ok, "latency": lat}

    def test_inet4():
        for ip in INTERNET_V4:
            ok, lat = _ping(ip.strip(), iface)
            if ok:
                result["internet_v4"] = {"ok": True, "latency": lat}
                return

    def test_inet6():
        for ip in INTERNET_V6:
            ip = ip.strip()
            if not ip:
                continue
            ok, lat = _ping(ip, iface)
            if ok:
                result["internet_v6"] = {"ok": True, "latency": lat}
                return

    def test_dns():
        start = time.time()
        ok = _dns_resolve(DNS_TEST_NAME, iface)
        lat = round((time.time() - start) * 1000, 1) if ok else None
        result["dns"] = {"ok": ok, "latency": lat}

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [
            pool.submit(test_gateway),
            pool.submit(test_inet4),
            pool.submit(test_inet6),
            pool.submit(test_dns),
        ]
        for f in futures:
            try:
                f.result(timeout=5)
            except Exception:
                pass

    return result
