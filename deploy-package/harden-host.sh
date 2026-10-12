#!/usr/bin/env bash
# =============================================================================
# harden-host.sh —— 新板到手后必须做的主机调整（目前一项：关闭桌面文件索引器）。
#
# 为什么：板子默认是图形界面，GNOME 的 tracker-miner-fs / tracker-extract 在服务器上没有用处，
# 却会反复读写容器目录等大目录；系统盘 ext4 日志一卡，它们总在不可中断的磁盘等待里。授权服务要
# 在持锁时同步落盘，盘一卡就答不上请求，租约到期，授权执行器停掉流媒体服务（2026-10-01 实测）。
#
# 做法：只对 ainvr 用户的"用户级"单元 mask（可逆：systemctl --user unmask <单元>），不删文件、
# 不改默认 target、不动桌面本身。幂等；单元不存在就跳过；--check 只读，未做完返回非零。
#
# 用法：
#   sudo ./harden-host.sh          # 执行
#   ./harden-host.sh --check       # 只读核对（验收用）
# =============================================================================
set -euo pipefail

UNITS=(tracker-miner-fs-3.service tracker-extract-3.service
       tracker-miner-fs-control-3.service tracker-writeback-3.service)
CHECK=0
case "${1:-}" in
  --check) CHECK=1 ;;
  "") ;;
  -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "未知参数: $1" >&2; exit 2 ;;
esac

if ((!CHECK)); then
  # 测试用开关 HARDEN_ASSUME_ROOT 只影响"是不是 root"这一项判断
  if [ "${HARDEN_ASSUME_ROOT:-}" = 1 ]; then :; elif [ "${HARDEN_ASSUME_ROOT:-}" = 0 ]; then
    echo "请用 sudo 运行" >&2; exit 1
  elif [ "$(id -u)" != 0 ]; then echo "请用 sudo 运行" >&2; exit 1; fi
fi

AINVR_UID="$(id -u ainvr)"
RUNTIME_DIR="${HARDEN_RUNTIME_DIR_BASE:-/run/user}/$AINVR_UID"
user_ctl() {
  if [ "$(id -u)" = 0 ]; then
    runuser -u ainvr -- env "XDG_RUNTIME_DIR=$RUNTIME_DIR" "DBUS_SESSION_BUS_ADDRESS=unix:path=$RUNTIME_DIR/bus" systemctl --user "$@"
  else
    env "XDG_RUNTIME_DIR=$RUNTIME_DIR" "DBUS_SESSION_BUS_ADDRESS=unix:path=$RUNTIME_DIR/bus" systemctl --user "$@"
  fi
}

rc=0
for u in "${UNITS[@]}"; do
  # 查询失败（例如无头机器没有用户总线）不能当成单元不存在。
  if ! load_state="$(user_ctl show "$u" --property=LoadState --value)"; then
    echo "  $u: 无法查询 ainvr 用户服务，请确认用户服务管理器可用后重试" >&2
    rc=1
    continue
  fi
  case "$load_state" in
    not-found) continue ;;
    masked) echo "  $u: 已屏蔽"; continue ;;
    loaded) ;;
    *) echo "  $u: 异常加载状态（$load_state）" >&2; rc=1; continue ;;
  esac
  state="$(user_ctl is-enabled "$u" 2>/dev/null || true)"
  if [ "$state" = masked ]; then
    echo "  $u: 已屏蔽"
  elif ((CHECK)); then
    echo "  $u: 未屏蔽（$state）" ; rc=1
  else
    if user_ctl mask --now "$u" >/dev/null; then
      echo "  $u: 已屏蔽"
    else
      echo "  $u: 屏蔽失败" >&2
      rc=1
    fi
  fi
done
exit $rc
