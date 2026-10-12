#!/usr/bin/env bash
# =============================================================================
# bootstrap-jetson.sh —— 在【目标机】刷好 JetPack 6.2 后执行，自动完成
# "阶段一：底层运行环境"（不含 OpenCV 编译——那一步耗时长、需确认，单列）。
#
# 前置：已刷 JetPack 6.2（L4T R36.4.3），用户名 ainvr。
# 用法：
#   sudo ./bootstrap-jetson.sh --new-board # 仅新目标板：装系统库和 Python 运行时
#   sudo ./bootstrap-jetson.sh --check     # 只核对版本是否满足，不改动系统
#   已有 ainvr 可设 SKIP_CONDA=1；首次安装需 CONDA_INSTALLER 与 CONDA_INSTALLER_SHA256。
#   --power-mode <id> 才修改功耗模式；不假定所有模块的模式 0 都是 MAXN_SUPER。
# =============================================================================
set -euo pipefail

DO_CHECK=0
NEW_BOARD=0
POWER_MODE=""
SKIP_CONDA="${SKIP_CONDA:-0}"
while (($#)); do
  case "$1" in
    --check) DO_CHECK=1; shift ;;
    --new-board) NEW_BOARD=1; shift ;;
    --power-mode) POWER_MODE="${2:?missing power mode}"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;36m[bootstrap]\033[0m %s\n' "$*"; }

# =============================================================================
# 版本核对
# =============================================================================
check_versions() {
  local fail=0
  echo "—— 版本检查（见 INSTALL-FROM-SCRATCH.md 的运行环境章节）——"
  grep -qE 'R36 \(release\), REVISION: 4\.3,' /etc/nv_tegra_release 2>/dev/null && \
    echo "L4T: R36.4.3" || { echo "✗ 非 L4T R36.4.3"; fail=1; }
  if /usr/local/cuda/bin/nvcc --version 2>/dev/null | grep -q 'release 12.6'; then echo "CUDA: 12.6"; else echo "✗ CUDA 非 12.6"; fail=1; fi
  dpkg -l tensorrt-libs 2>/dev/null | grep -q '10.3' && echo "TensorRT: 10.3" || { echo "✗ TensorRT 非 10.3"; fail=1; }
  dpkg -l libcudnn9-cuda-12 >/dev/null 2>&1 && echo "cuDNN9: 已装" || echo "⚠ 未装 libcudnn9-cuda-12"
  return $fail
}

if [ "$DO_CHECK" = "1" ]; then
  check_versions && echo "✅ 版本满足" || { echo "❌ 版本不满足，请确认刷的是 JetPack 6.2" >&2; exit 1; }
  echo "—— 主机调整（harden-host.sh）——"
  "$(dirname "$(readlink -f "$0")")/harden-host.sh" --check || echo "⚠ 主机调整未做完：sudo deploy-package/harden-host.sh（新板必做）"
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "请用 sudo 运行" >&2; exit 1; }
((NEW_BOARD)) || { echo "Only new boards may be bootstrapped; use --check on the development master" >&2; exit 1; }
id sunrise >/dev/null
if [[ -n "$POWER_MODE" && ! "$POWER_MODE" =~ ^[0-9]+$ ]]; then echo "Invalid power mode" >&2; exit 2; fi
if [[ "$SKIP_CONDA" != 1 && ! -x /home/sunrise/miniconda3/bin/conda ]]; then
  [[ -f "${CONDA_INSTALLER:-}" && "${CONDA_INSTALLER_SHA256:-}" =~ ^[0-9a-fA-F]{64}$ ]] || {
    echo "Supply a reviewed aarch64 Miniconda installer and its published SHA256" >&2; exit 1;
  }
  printf '%s  %s\n' "$CONDA_INSTALLER_SHA256" "$CONDA_INSTALLER" | sha256sum -c - >/dev/null
fi

check_versions || { echo "版本基线不符，终止（可先确认 JetPack 版本）" >&2; exit 1; }

# =============================================================================
# 1. apt 基础工具 + 录像 SMB + 系统运行库
# =============================================================================
log "apt 更新 + 安装基础工具与运行库"
apt update
apt -y install curl wget nano htop tmux ca-certificates network-manager \
    cifs-utils smbclient \
    libyaml-cpp0.7 libcpp-httplib0 libssl3 libmongoc-1.0-0 libbson-1.0-0 \
    libgstreamer1.0-0 ffmpeg gstreamer1.0-tools

# =============================================================================
# 2. Docker + compose + nvidia runtime
# =============================================================================
if ! command -v docker >/dev/null; then
  log "安装 Docker（Ubuntu 仓库版 26.x）"
  apt -y install docker.io
fi
docker compose version >/dev/null 2>&1 || apt -y install docker-compose-v2
log "保留 Docker 现有配置，补充运行时和有界日志"
mkdir -p /etc/docker
python3 - <<'PY'
from pathlib import Path
import json,os,shutil,tempfile,time
p=Path('/etc/docker/daemon.json'); config=json.loads(p.read_text()) if p.exists() else {}
if p.exists():shutil.copy2(p,p.with_name('daemon.json.before-ainvr-'+str(time.time_ns())))
if shutil.which('nvidia-container-runtime'):
 config.setdefault('runtimes',{}).setdefault('nvidia',{'path':'nvidia-container-runtime','args':[]})
 config.setdefault('default-runtime','nvidia')
if 'log-driver' not in config:
 config['log-driver']='json-file';config.setdefault('log-opts',{'max-size':'20m','max-file':'5'})
fd,name=tempfile.mkstemp(dir=p.parent,prefix='.daemon-')
with os.fdopen(fd,'w') as f:json.dump(config,f,indent=2);f.flush();os.fsync(f.fileno())
os.replace(name,p)
PY
dockerd --validate --config-file /etc/docker/daemon.json
systemctl restart docker
# ainvr 加入 docker 组
if id sunrise >/dev/null 2>&1; then usermod -aG docker ainvr; fi

# =============================================================================
# 3. 功耗模式 MAXN_SUPER + jetson_clocks
# =============================================================================
if [[ -n "$POWER_MODE" ]]; then
  log "按已验证的模块配置应用功耗模式 $POWER_MODE"
  nvpmodel -m "$POWER_MODE"
fi

# =============================================================================
# 4. 部署目录与本地缓存
# =============================================================================
log "创建标准目录"
mkdir -p /opt/ainvr-ai /etc/ainvr-ai /etc/ainvr-recorder /mnt/ainvr-recorder
[ -d /home/ainvr ] && chown -R ainvr:ainvr /opt/ainvr-ai || true
mkdir -p /home/sunrise/ainvr/data/recordings 2>/dev/null && \
  chown -R ainvr:ainvr /home/sunrise/ainvr/data || true

# =============================================================================
# 5. miniconda + 精简 ainvr（不含 torch）
# =============================================================================
if [ "$SKIP_CONDA" != "1" ] && [ -d /home/ainvr ]; then
  if [ ! -x /home/sunrise/miniconda3/bin/conda ]; then
    log "安装 miniconda（aarch64）"
    bash "$CONDA_INSTALLER" -b -p /home/sunrise/miniconda3
    chown -R ainvr:ainvr /home/sunrise/miniconda3
  fi
  log "创建精简 ainvr 环境（fastapi/uvicorn/pydantic，不含 torch）"
  if [[ ! -x /home/sunrise/ainvr/.venv/bin/python3 ]]; then
    sudo -u ainvr /home/sunrise/miniconda3/bin/conda create -y -n ainvr python=3.10
  fi
  sudo -u ainvr /home/sunrise/miniconda3/envs/ainvr/bin/pip install \
      "fastapi==0.115.12" "uvicorn[standard]==0.34.1" "pydantic==2.11.3"
fi

# =============================================================================
# 6. 主机调整：关闭桌面文件索引器（会在系统盘卡顿时拖死授权服务）
# =============================================================================
log "主机调整（harden-host.sh）"
"$(dirname "$(readlink -f "$0")")/harden-host.sh"

# =============================================================================
# 完成
# =============================================================================
log "底层环境就绪。"
cat <<'MSG'

下一步：
  按 INSTALL-FROM-SCRATCH.md 完成 OpenCV 运行库、单板凭据、授权供应及安装。
  本脚本没有配置磁盘加密、可信启动或熔丝，也没有把新板标为验收通过。
MSG
