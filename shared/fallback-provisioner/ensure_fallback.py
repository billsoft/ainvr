#!/usr/bin/env python3
"""
出厂兜底地址 provisioning + 自愈组件。

跟 os-helper / web 后端完全解耦独立部署：Web 服务挂了、容器没起来、正在升级，
这个脚本都不受影响——只认 NetworkManager 和 sysfs，不依赖任何 HTTP 服务，也不
被任何 HTTP 服务依赖（os-helper 只读它写的 /etc/ainvr-ai/fallback.json）。

两条 systemd 触发路径，同一个脚本：
  - fallback-provision.service (oneshot, WantedBy=multi-user.target)：开机跑一次，
    把 factory-fallback profile 建起来、fallback.json 写好。
  - fallback-provision.timer：每 60s 跑一次，用于自愈——有人手动删了地址、删了
    profile、或者 os-helper 某次写操作出了意外，下一轮自动纠偏回来。

没插网线（carrier=down）是正常状态，不重试、不报警，只保证 profile 和配置文件
本身是对的，等真的插上线再由下一轮 timer 去激活——见 main() 里的分支。
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import subprocess
import sys

FALLBACK_ADDRESS = os.environ.get("FALLBACK_ADDRESS", "10.250.100.1")
FALLBACK_PREFIX = int(os.environ.get("FALLBACK_PREFIX", "24"))
FALLBACK_PROFILE = os.environ.get("FALLBACK_PROFILE", "factory-fallback")
CONFIG_PATH = os.environ.get("FALLBACK_CONFIG_PATH", "/etc/ainvr-ai/fallback.json")
# 一张板子上如果有不止一张物理有线网卡，脚本不猜——必须显式指定用哪张
IFACE_HINT = os.environ.get("FALLBACK_IFACE_HINT", "").strip()

SYS_CLASS_NET = os.environ.get("FALLBACK_SYS_CLASS_NET", "/sys/class/net")
IFACE_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,16}$")


class ProvisionError(RuntimeError):
    pass


def run(cmd: list[str], timeout: int = 15, check: bool = True) -> str:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ProvisionError(f"命令超时: {' '.join(cmd[:4])}")
    if check and p.returncode != 0:
        raise ProvisionError((p.stderr or p.stdout).strip() or f"{cmd[0]} 执行失败")
    return p.stdout


def nmcli(*args: str, timeout: int = 15, check: bool = True) -> str:
    return run(["nmcli", "-t", *args], timeout=timeout, check=check)


# =========================== 接口识别 ===========================

def _is_physical_pci_ethernet(ifname: str) -> bool:
    """物理 PCI 有线网卡：排除无线（有 wireless 子目录）、排除没有 device 符号链接
    的虚拟网卡（docker/veth/bridge/lo/tun/l4tbr 等）、排除 USB 网卡/USB Device Mode
    （device/uevent 里没有 PCI_SLOT_NAME）。"""
    base = f"{SYS_CLASS_NET}/{ifname}"
    if os.path.isdir(f"{base}/wireless"):
        return False
    device_link = f"{base}/device"
    if not os.path.exists(device_link):
        return False
    try:
        with open(f"{device_link}/uevent") as f:
            uevent = f.read()
    except OSError:
        return False
    return "PCI_SLOT_NAME=" in uevent


def resolve_fallback_interface() -> str:
    """确定兜底地址挂在哪张网卡上。

    优先用 FALLBACK_IFACE_HINT 显式指定（多网卡板子必须配这个）；否则自动找
    "唯一一张物理 PCI 有线网卡"——找到 0 张或 >1 张都视为无法安全判断，直接
    报错退出，不瞎猜（猜错等于把兜底地址插错网卡，比没有兜底地址更危险）。
    """
    if IFACE_HINT:
        if not IFACE_RE.match(IFACE_HINT) or not os.path.isdir(f"{SYS_CLASS_NET}/{IFACE_HINT}"):
            raise ProvisionError(f"FALLBACK_IFACE_HINT={IFACE_HINT} 不是一张存在的网卡")
        return IFACE_HINT

    try:
        names = os.listdir(SYS_CLASS_NET)
    except OSError as e:
        raise ProvisionError(f"读不到 {SYS_CLASS_NET}: {e}")

    candidates = sorted(
        n for n in names if IFACE_RE.match(n) and _is_physical_pci_ethernet(n)
    )
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise ProvisionError("没找到任何物理 PCI 有线网卡，无法确定兜底地址挂哪张网卡")
    raise ProvisionError(
        f"发现 {len(candidates)} 张物理有线网卡 {candidates}，无法自动判断用哪张，"
        f"请设置环境变量 FALLBACK_IFACE_HINT 明确指定"
    )


def carrier_up(ifname: str) -> bool:
    try:
        with open(f"{SYS_CLASS_NET}/{ifname}/carrier") as f:
            return f.read().strip() == "1"
    except OSError:
        return False


# =========================== 配置文件 ===========================

def write_config(ifname: str) -> None:
    """原子写入 fallback.json，os-helper 只读这个文件，不会读到写一半的半份内容。"""
    directory = os.path.dirname(CONFIG_PATH)
    if directory:
        os.makedirs(directory, exist_ok=True)
    payload = {
        "interface": ifname,
        "address": FALLBACK_ADDRESS,
        "prefix": FALLBACK_PREFIX,
        "profile": FALLBACK_PROFILE,
    }
    content = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    # timer 每 60s 跑一次：内容没变就不换文件，免得每分钟一次元数据写盘
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            if f.read() == content:
                return
    except (OSError, UnicodeDecodeError):
        pass
    tmp_path = CONFIG_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(content)
    os.chmod(tmp_path, 0o644)
    os.replace(tmp_path, CONFIG_PATH)


# =========================== NetworkManager profile ===========================

def existing_connections_on(ifname: str) -> list[str]:
    """这张网卡上现存的所有 connection profile（不只是活跃的那个）。

    `nmcli -f NAME,DEVICE connection show` 的 DEVICE 列只在 profile 当前处于
    活跃状态时才有值——NetworkManager 自动生成但从没激活过的 "Wired
    connection N" 这类幽灵 profile，DEVICE 是空的，靠这一列过滤会漏掉它们
    （已经在真实设备上验证过这个坑：幽灵 profile 绑的是 connection.interface-
    name 这个静态配置字段，不是运行时 DEVICE 关联）。
    """
    names = [n for n in nmcli("-f", "NAME", "connection", "show", check=False).splitlines() if n]
    matched = []
    for name in names:
        out = nmcli("-f", "connection.interface-name", "connection", "show", name, check=False)
        bound_iface = out.split(":", 1)[1].strip() if ":" in out else ""
        if bound_iface == ifname:
            matched.append(name)
    return matched


def profile_exists(name: str) -> bool:
    out = nmcli("-f", "NAME", "connection", "show", check=False)
    return name in out.splitlines()


def ensure_profile(ifname: str) -> None:
    """确保 factory-fallback 是这张网卡上唯一的 profile，地址配置正确。

    NetworkManager 第一次看到没配置过的网卡会自己生成一个 autoconnect 的
    "Wired connection N" profile——这张幽灵 profile 和 factory-fallback 谁先
    启动是竞态，必须先清场，否则每次 provisioning 跑出来的结果不确定。
    """
    for name in existing_connections_on(ifname):
        if name != FALLBACK_PROFILE:
            print(f"[ensure_fallback] 清理网卡 {ifname} 上的旧 profile: {name}")
            run(["nmcli", "connection", "delete", name], check=False)

    cidr = f"{FALLBACK_ADDRESS}/{FALLBACK_PREFIX}"

    if not profile_exists(FALLBACK_PROFILE):
        print(f"[ensure_fallback] 创建 {FALLBACK_PROFILE} (ifname={ifname}, addr={cidr})")
        nmcli("connection", "add", "type", "ethernet", "ifname", ifname,
              "con-name", FALLBACK_PROFILE,
              "ipv4.method", "manual", "ipv4.addresses", cidr,
              "ipv4.gateway", "", "ipv4.dns", "",
              "ipv4.never-default", "yes",
              "ipv6.method", "disabled",
              "connection.autoconnect", "yes")
    else:
        # 已存在：纠偏，确保关键字段没被带偏——地址本身不强改回单一值，因为
        # 用户可能已经通过 web 控制台在同一个 profile 上叠加了自己的主地址
        # （nm.py 的 _inject_protected_address 会保证兜底地址一直在这个列表
        # 里），这里只需要保证 profile 没被整个改成别的 method。
        current = nmcli("connection", "show", FALLBACK_PROFILE, check=False)
        addrs = ""
        method = ""
        autoconnect = ""
        for line in current.splitlines():
            if line.startswith("ipv4.addresses:"):
                addrs = line.split(":", 1)[1]
            elif line.startswith("ipv4.method:"):
                method = line.split(":", 1)[1].strip()
            elif line.startswith("connection.autoconnect:"):
                autoconnect = line.split(":", 1)[1].strip()
        if cidr not in addrs.split(","):
            addrs = f"{cidr},{addrs}" if addrs and addrs != "--" else cidr
            print(f"[ensure_fallback] {FALLBACK_PROFILE} 缺兜底地址，纠偏回 {addrs}")
            nmcli("connection", "modify", FALLBACK_PROFILE, "ipv4.addresses", addrs)
        if method != "manual":
            # disabled/auto/link-local 都不保证地址真的落地（disabled 直接
            # 跳过 IPv4）——地址字段里有值不代表网卡上有值，这里必须连
            # method 一起纠偏，否则地址永远只活在 profile 文本里。
            print(f"[ensure_fallback] {FALLBACK_PROFILE} 的 ipv4.method 是 {method or '(空)'}，纠偏回 manual")
            nmcli("connection", "modify", FALLBACK_PROFILE, "ipv4.method", "manual")
        # 没插网线时每轮都会走到这里：已经是 yes 就别再改写 NM keyfile
        if autoconnect != "yes":
            nmcli("connection", "modify", FALLBACK_PROFILE, "connection.autoconnect", "yes")

    if carrier_up(ifname):
        run(["nmcli", "connection", "up", FALLBACK_PROFILE], check=False, timeout=20)
    else:
        print(f"[ensure_fallback] {ifname} 未插网线 (no carrier)，跳过激活，交给 autoconnect")


def address_present(ifname: str, cidr: str) -> bool:
    try:
        out = run(["ip", "-j", "addr", "show", ifname], timeout=5)
        info = json.loads(out)
        if not info:
            return False
        for a in info[0].get("addr_info", []):
            if a.get("family") == "inet" and f"{a.get('local')}/{a.get('prefixlen')}" == cidr:
                return True
    except (ProvisionError, ValueError, KeyError, IndexError):
        pass
    return False


# =========================== 入口 ===========================

def main() -> int:
    try:
        ifname = resolve_fallback_interface()
    except ProvisionError as e:
        print(f"[ensure_fallback] 致命: {e}", file=sys.stderr)
        return 1

    write_config(ifname)

    cidr = f"{FALLBACK_ADDRESS}/{FALLBACK_PREFIX}"
    up = carrier_up(ifname)
    if up and address_present(ifname, cidr) and profile_exists(FALLBACK_PROFILE):
        return 0  # 一切正常，自愈这一轮不产生任何 nmcli 调用

    print(f"[ensure_fallback] 网卡={ifname} carrier={up} 需要初始化/纠偏")
    try:
        ensure_profile(ifname)
    except ProvisionError as e:
        print(f"[ensure_fallback] 纠偏失败: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
