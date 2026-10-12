#!/usr/bin/env bash
# =============================================================================
# install.sh —— 在【目标机（生产板）】执行。装载 build-release.sh 产出的制品。
# 业务以制品交付；安装工具为可审查的 Python/Shell，不把 pyc 当作安全保护。
#
# 用法：
#   sudo ./install.sh                 # 完整安装
#   sudo ./install.sh --only console  # 只更新前端/后端镜像并 up
#   sudo ./install.sh --only ai-service
#   sudo ./install.sh --only python
#   sudo ./install.sh --only license  # 更新授权组件并刷新已有消费者
#   sudo ./install.sh --no-start      # 只布置不启动
#   sudo ./install.sh --development-host # 工程板例外：不声称具备拔盘保护，授权仍强制
#
# 布局（LAYOUT）：
#   home  (默认，与开发母版目录兼容)：落在 /home/sunrise/ainvr/...
#   opt                            ：落在 /opt/ainvr-ai、/opt/ainvr-python
# 通过环境变量 LAYOUT=opt 切换。两种不要混用。
# =============================================================================
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ONLY="all"
DO_START=1
LAYOUT="${LAYOUT:-home}"
export COMPOSE_PROJECT_NAME=srs-web-console
SECURITY_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --no-start) DO_START=0; shift ;;
    --development-host) SECURITY_ARGS+=(--development-host); shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
need_root() { [ "$(id -u)" = 0 ] || { echo "请用 sudo 运行" >&2; exit 1; }; }
need_root
export AINVR_GID="$(id -g sunrise)"
case "$LAYOUT" in home|opt) ;; *) echo "Unknown LAYOUT" >&2; exit 2;; esac
case "$ONLY" in all|license|console|ai-service|python|provisioner) ;; *) echo "Unknown --only" >&2; exit 2;; esac
python3 "$PKG_DIR/audit_release.py" "$PKG_DIR"
if [[ "$ONLY" == all || "$ONLY" == license ]]; then
  [[ -n "${LICENSE_PROVISION_DIR:-}" && -f "$LICENSE_PROVISION_DIR/license-service.yaml" ]] || { echo "Provide LICENSE_PROVISION_DIR before installation" >&2; exit 1; }
  bash "$PKG_DIR/license-service/deploy/install.sh" "${SECURITY_ARGS[@]}" --validate-only --binary "$PKG_DIR/license-service/bin/license_service" --shared "$PKG_DIR/python/shared" --provision "$LICENSE_PROVISION_DIR"
fi
if [[ "$ONLY" == console ]]; then
  [[ -f /etc/ainvr-license/console-backend.env ]] || { echo "Provision license credentials before installing console" >&2; exit 1; }
fi

# Apply system tuning only after all deployment credential preflight checks.
if [[ "$ONLY" == all ]]; then
  install -m 644 "$PKG_DIR/60-ainvr-writeback.conf" /etc/sysctl.d/60-ainvr-writeback.conf
  sysctl -p /etc/sysctl.d/60-ainvr-writeback.conf
fi

# ---- 目标路径 ----
if [ "$LAYOUT" = "home" ]; then
  BASE=/home/sunrise/ainvr
  AI_DIR="$BASE/ai-service"
  REC_DIR="$BASE/recording-service"
  CON_DIR="$BASE/srs-web-console"
  SHARED_DIR="$BASE/shared"
  LIC_DIR="$BASE/license-service"
  LOCAL_CACHE=/home/sunrise/ainvr/data
else
  BASE=/opt
  AI_DIR="$BASE/ainvr-ai/ai-service"
  REC_DIR="$BASE/ainvr-python/recording-service"
  SHARED_DIR="$BASE/ainvr-python/shared"
  CON_DIR="$BASE/ainvr-console"
  LIC_DIR="$BASE/ainvr-ai/license-service"
  LOCAL_CACHE="$BASE/ainvr-python/cache"
fi
PYBIN="$(command -v python3)"
python3 "$PKG_DIR/license-service/deploy/security_preflight.py" "${SECURITY_ARGS[@]}" \
  --path "$AI_DIR" --path "$REC_DIR" --path "$CON_DIR" --path "$SHARED_DIR" --path "$LIC_DIR" \
  --path /var/lib/ainvr-deploy-backups --docker

# Validate console credentials before loading images or replacing files.
if [[ "$ONLY" == all || "$ONLY" == console || "$ONLY" == license ]]; then
  [[ -f "$CON_DIR/.env" ]] || { echo "Create $CON_DIR/.env with unique credentials before installing" >&2; exit 1; }
  python3 "$PKG_DIR/validate_console_env.py" "$CON_DIR/.env"
fi
if [[ "$ONLY" == all || "$ONLY" == python ]]; then
  python3 "$PKG_DIR/install_python_code.py" --package "$PKG_DIR/python" --recorder "$REC_DIR" --shared "$SHARED_DIR" --validate-only
elif [[ "$ONLY" == license ]]; then
  python3 "$PKG_DIR/install_python_code.py" --package "$PKG_DIR/python" --recorder "$REC_DIR" --shared "$SHARED_DIR" --license-only --validate-only
fi
if [[ "$ONLY" == all || "$ONLY" == ai-service ]]; then
  MODEL_SRC="$(python3 "$PKG_DIR/model_package.py" --manifest "$PKG_DIR/models-manifest.json" --directory "$PKG_DIR/..")"
fi

# =============================================================================
# 镜像
# =============================================================================
install_images() {
  log "装载 Docker 镜像"
  docker load -i "$PKG_DIR/images/frontend.tar"
  docker load -i "$PKG_DIR/images/backend.tar"
  if [ -f "$PKG_DIR/images/thirdparty.tar" ]; then
    docker load -i "$PKG_DIR/images/thirdparty.tar"
  else
    log "无离线公共镜像，尝试联网拉取 postgres/mongo/srs"
    # A fresh board does not have a deployed Compose file yet.
    while IFS= read -r image; do
      [[ -z "$image" ]] || docker pull "$image"
    done < "$PKG_DIR/images/thirdparty.txt"
  fi
  # 离线 load 不保留 digest，只能按镜像 ID 核对；不一致即中止，不带着错的 SRS 上线
  python3 "$PKG_DIR/images/thirdparty_images.py" verify "$PKG_DIR/images/thirdparty-images.txt"
}

# =============================================================================
# FFmpeg 8.1.2（录像 H.265 读端）：属于录像组件，由 install_python 调用——完整安装与
# --only python 行为一致。已就绪且校验通过则不动；否则从清单锁定 ID 的 SRS 镜像提取
# （本机没有就先 load 发布包里的离线镜像，再尝试联网 pull），不另行下载。
# =============================================================================
FFMPEG8_DIR=/opt/ainvr/ffmpeg-8.1.2
ensure_ffmpeg8() {
  python3 "$PKG_DIR/images/thirdparty_images.py" ffmpeg8 "$PKG_DIR/images/thirdparty-images.txt"     "$FFMPEG8_DIR" "$PKG_DIR/images/thirdparty.tar"
  "$FFMPEG8_DIR/bin/ffmpeg" -hide_banner -version | sed -n 1p
}

# =============================================================================
# compose 部署目录（仅 image 引用，无 build/无源码）
# =============================================================================
install_console() {
  log "布置 console 部署目录：$CON_DIR"
  install -d -m 755 "$CON_DIR"
  # 使用剥离了 build 段的 release compose
  cp "$PKG_DIR/compose/docker-compose.release.yml" "$CON_DIR/docker-compose.yml"
  install -d -m 755 "$CON_DIR/deploy/srs-conf"
  cp "$PKG_DIR/compose/deploy/srs-conf/"*.conf "$CON_DIR/deploy/srs-conf/"
  cp "$PKG_DIR/compose/deploy/srs-entrypoint.sh" "$CON_DIR/deploy/"
  install -d -m 755 /opt/ainvr
  install -m 755 "$PKG_DIR/compose/deploy/srs-observer.py" /opt/ainvr/srs-observer.py
  install -m 644 "$PKG_DIR/compose/deploy/ainvr-srs-observer.service" /etc/systemd/system/
  # OEM 品牌信息：只在目标板还没有时放入出厂模板，已有（OEM 改过的）绝不覆盖
  install -d -m 755 "$CON_DIR/deploy/branding"
  if [[ ! -f "$CON_DIR/deploy/branding/branding.yaml" ]]; then
    install -m 644 "$PKG_DIR/compose/deploy/branding/branding.yaml" "$CON_DIR/deploy/branding/branding.yaml"
  fi
  # Initialization/validation happened before deployment; never replace credentials.
  chmod 600 "$CON_DIR/.env"
}

# =============================================================================
# AI C++ 二进制 + 模型
# =============================================================================
install_ai() {
  log "布置 ai-service：$AI_DIR"
  install -d -m 755 "$AI_DIR"/{bin,config,deploy,logs,trt_engine_cache,models}
  install -m 755 "$PKG_DIR/ai-service/bin/ai_service" "$AI_DIR/bin/ai_service"
  if [[ ! -f "$AI_DIR/config/config.yaml" ]]; then
    install -m 0640 -o root -g sunrise "$PKG_DIR/ai-service/config/config.yaml" "$AI_DIR/config/config.yaml"
  fi
  cp -r "$PKG_DIR/ai-service/trt_engine_cache/." "$AI_DIR/trt_engine_cache/" 2>/dev/null || true
  # Source template uses build/; release binaries live in bin/, in either layout.
  python3 - "$PKG_DIR/ai-service/deploy/ai-service.service" "$AI_DIR" <<'PY'
from pathlib import Path
import sys
template, root = sys.argv[1:]
unit = Path(template).read_text().replace('/home/sunrise/ainvr/ai-service', root)
unit = unit.replace(root + '/build/ai_service', root + '/bin/ai_service')
Path('/etc/systemd/system/ai-service.service').write_text(unit)
PY
  install -d -o sunrise -g sunrise -m 0750 "$AI_DIR/data" "$AI_DIR/logs" "$AI_DIR/trt_engine_cache"
  # The exact archive, checksum and members were verified before any mutation.
  log "解包已校验的配套模型到 $AI_DIR/models"
  tar xzf "$MODEL_SRC" -C "$AI_DIR" --no-same-owner
  python3 "$PKG_DIR/configure-prompted-runtimes.py" "$PKG_DIR" "$AI_DIR" \
    --python "${PROMPTED_BASE_PYTHON:-/home/sunrise/miniconda3/envs/ainvr/bin/python}"
}

# =============================================================================
# Python 纯 .pyc
# =============================================================================
install_python() {
  log "布置纯 pyc Python 服务（制品内零 .py 源码）"
  install -d -m 755 "$REC_DIR/src" "$SHARED_DIR/python" \
      "$SHARED_DIR/os-helper" "$SHARED_DIR/host-restart-helper" \
      "$SHARED_DIR/host-restart-helper/data" \
      "$LOCAL_CACHE/recordings"
  python3 "$PKG_DIR/install_python_code.py" --package "$PKG_DIR/python" --recorder "$REC_DIR" --shared "$SHARED_DIR"
  ensure_ffmpeg8
  python3 "$PKG_DIR/configure-ingest.py" --console "$CON_DIR" \
    --code "$SHARED_DIR/../ingest-service" --template "$PKG_DIR/python/ainvr-ingest.service"

  # 制品与仓库同构：recording-service/ 与 shared/ 平级，垫片向上查找
  # shared/python/config_center_client.pyc 才能命中（需垫片已支持 .pyc）。

  # ---- recorder（-m 方式从 .pyc 加载包内模块；PYTHONPATH 需含包父目录与 shared）----
  # recorder 必须用 conda ainvr 解释器（fastapi/uvicorn/pydantic 只装在那；
  # root 下 command -v python3 是系统 3.10，缺依赖会 ModuleNotFoundError）
  RECPY=/home/sunrise/ainvr/.venv/bin/python3
  [ -x "$RECPY" ] || { echo "未找到 ainvr 解释器 $RECPY（先跑 bootstrap-jetson.sh）" >&2; exit 1; }
  cat > /etc/systemd/system/ainvr-recorder.service <<EOF
[Unit]
Description=AINVR Recorder Microservice (compiled bytecode)
After=network-online.target docker.service
Wants=network-online.target
StartLimitIntervalSec=0
[Service]
Type=simple
User=root
WorkingDirectory=$REC_DIR
Environment=PYTHONPATH=$REC_DIR/src:$SHARED_DIR:$SHARED_DIR/python
Environment=RECORDER_DATA=$REC_DIR/data
Environment=CONFIG_CENTER_URL=http://127.0.0.1:3001
Environment=CONFIG_CENTER_POLL=10
EnvironmentFile=/etc/ainvr-recorder/service.env
ExecStart=$RECPY -m recorder.main --data-dir $REC_DIR/data
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/etc/ainvr-recorder /mnt/ainvr-recorder $REC_DIR/data $LOCAL_CACHE
PrivateTmp=true
KillSignal=SIGTERM
KillMode=mixed
# 重连交接时同通道最多两代管线，给有界排空和进程/管道回收留足总时间（与单元示例一致）
TimeoutStopSec=30
[Install]
WantedBy=multi-user.target
EOF

  # ---- os-helper（纯标准库；main.pyc 同目录命中 nm.pyc）----
  cat > /etc/systemd/system/ainvr-os-helper.service <<EOF
[Unit]
Description=AINVR AI OS Helper (network management only)
After=network.target NetworkManager.service
Wants=NetworkManager.service
[Service]
User=root
WorkingDirectory=$SHARED_DIR/os-helper
EnvironmentFile=/etc/ainvr-ai/os-helper.env
ExecStart=$PYBIN $SHARED_DIR/os-helper/main.pyc
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=true
[Install]
WantedBy=multi-user.target
EOF

  # ---- 远程协助隧道（默认关闭；开关由 os-helper 经 systemctl enable/disable 控制）----
  # 专用无登录账号运行，只能读自己的配置；只转发本机远程登录端口。
  getent group ainvr-assist >/dev/null || groupadd --system ainvr-assist
  id -u ainvr-assist >/dev/null 2>&1 || useradd --system --gid sunrise-assist --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin ainvr-assist
  install -d -o root -g sunrise-assist -m 0750 /var/lib/ainvr-remote-assist
  if [ -f "$PKG_DIR/remote-assist/client" ]; then
    # 原子替换：隧道开启时客户端正在运行，中途失败也不能留下残缺程序
    install -d -o root -g root -m 0755 /opt/ainvr/remote-assist
    install -o root -g root -m 0755 "$PKG_DIR/remote-assist/client" /opt/ainvr/remote-assist/.client.new
    mv -f /opt/ainvr/remote-assist/.client.new /opt/ainvr/remote-assist/client
  fi
  # 统一接入凭据：随包覆盖（所有设备相同）。覆盖前把旧版按设备签发的设备令牌沿用为本机令牌，
  # 否则中转服务器上已记住的身份会与本机对不上（显示"身份冲突"）。中转服务器地址只在缺失时写入，
  # 不覆盖管理员在页面上的修改。
  RA=/var/lib/ainvr-remote-assist
  if [ -f "$PKG_DIR/remote-assist/credentials.json" ]; then
    if [ -f "$RA/credentials.json" ] && [ ! -s "$RA/device.key" ]; then
      python3 - "$RA" <<'PY' || true
import json, os, sys
d = sys.argv[1]
tok = json.load(open(os.path.join(d, "credentials.json"))).get("device_token")
if isinstance(tok, str) and 16 <= len(tok) <= 256:
    fd = os.open(os.path.join(d, "device.key"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(fd, (tok + "\n").encode()); os.close(fd)
PY
    fi
    install -o root -g root -m 0600 "$PKG_DIR/remote-assist/credentials.json" "$RA/.credentials.json.new"
    mv -f "$RA/.credentials.json.new" "$RA/credentials.json"
  fi
  if [ -f "$PKG_DIR/remote-assist/server.json" ] && [ ! -s "$RA/server.json" ]; then
    install -o root -g root -m 0600 "$PKG_DIR/remote-assist/server.json" "$RA/server.json"
  fi
  cat > /etc/systemd/system/ainvr-remote-assist.service <<EOF
[Unit]
Description=AINVR Remote Assistance Tunnel
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0
[Service]
Type=simple
User=ainvr-assist
Group=ainvr-assist
ExecStart=/opt/ainvr/remote-assist/client -c /var/lib/ainvr-remote-assist/client.toml
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
CapabilityBoundingSet=
[Install]
WantedBy=multi-user.target
EOF

  # ---- restart-helper（observability.pyc 同目录命中）----
  cat > /etc/systemd/system/ainvr-restart-helper.service <<EOF
[Unit]
Description=AINVR Restart Helper
After=network.target
[Service]
Type=simple
User=sunrise
Group=sunrise
WorkingDirectory=$SHARED_DIR/host-restart-helper
ExecStart=$PYBIN $SHARED_DIR/host-restart-helper/restart_helper.pyc
EnvironmentFile=/etc/ainvr-ai/restart-helper.env
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
}

# =============================================================================
# fallback-provisioner
# =============================================================================
install_provisioner() {
  log "布置 fallback-provisioner（纯 .pyc）"
  install -d -m 755 /opt/ainvr-ai/fallback-provisioner
  install -m 644 "$PKG_DIR/provisioner/ensure_fallback.pyc" \
     /opt/ainvr-ai/fallback-provisioner/ensure_fallback.pyc
  # oneshot 单元由本脚本生成（制品内零 .py，入口用 .pyc）；timer 无 .py 引用，直接拷
  cat > /etc/systemd/system/fallback-provision.service <<EOF
[Unit]
Description=Ensure factory fallback network address (provisioning + self-heal)
After=NetworkManager.service
Wants=NetworkManager.service
[Service]
Type=oneshot
ExecStart=$PYBIN /opt/ainvr-ai/fallback-provisioner/ensure_fallback.pyc
User=root
[Install]
WantedBy=multi-user.target
EOF
  install -m 644 "$PKG_DIR/provisioner/deploy/fallback-provision.timer" \
     /etc/systemd/system/fallback-provision.timer
}

# =============================================================================
# license-service（授权验证 + Enforcer）
# v3 grants retain device-specific state/signal provisioning; never silently skip licensing.
# The factory issuer and master key must never be installed on a board.
# =============================================================================
install_license() {
  [ -n "${LICENSE_PROVISION_DIR:-}" ] || { echo "LICENSE_PROVISION_DIR required" >&2; exit 1; }
  install -d -m 755 "$SHARED_DIR/python" "$SHARED_DIR/license-enforcer"
  if [[ "$ONLY" != all ]]; then
    python3 "$PKG_DIR/install_python_code.py" --package "$PKG_DIR/python" --recorder "$REC_DIR" --shared "$SHARED_DIR" --license-only
  fi
  install -d -m 755 "$LIC_DIR/bin"
  install -m 755 "$PKG_DIR/license-service/bin/license_service" "$LIC_DIR/bin/license_service"
  bash "$PKG_DIR/license-service/deploy/install.sh" "${SECURITY_ARGS[@]}" --no-start --console "$CON_DIR" \
    --binary "$LIC_DIR/bin/license_service" --shared "$SHARED_DIR" \
    --provision "$LICENSE_PROVISION_DIR"
}

# =============================================================================
# 按 --only 分发
# =============================================================================
case "$ONLY" in
  all)
    install_images
    install_console
    install_ai
    install_python
    install_provisioner
    install_license
    ;;
  console) install_images; install_console ;;
  ai-service) install_ai ;;
  python) install_python ;;
  provisioner) install_provisioner ;;
  license) install_license ;;
  *) echo "未知 --only: $ONLY" >&2; exit 2 ;;
esac

systemctl daemon-reload

# =============================================================================
# 启动
# =============================================================================
if [ "$DO_START" = "1" ]; then
  if [[ "$ONLY" == all || "$ONLY" == license ]]; then
    systemctl enable ainvr-license ainvr-license-enforcer
    systemctl restart ainvr-license ainvr-license-enforcer
  fi
  if [[ "$ONLY" == all || "$ONLY" == console ]]; then
    systemctl enable ainvr-srs-observer
    systemctl restart ainvr-srs-observer
    # Preserve database containers/volumes; recreate BFF to load new env_file.
    SRS_CONTAINERS="$(docker container ls -a --format '{{.Names}}')"
    (cd "$CON_DIR" && docker compose up -d --wait --wait-timeout 90 postgres mongo && \
      docker compose create srs)
    if ! grep -Fxq ainvr-srs <<< "$SRS_CONTAINERS"; then
      # Only a genuinely new installation requests first business startup.
      # Do not undo an administrator's stop during an ordinary upgrade.
      install -d -o sunrise -g sunrise -m 0750 /var/lib/ainvr-license-enforcer
      printf 'awaiting-first-activation\n' > /var/lib/ainvr-license-enforcer/start-pending.tmp
      chown sunrise:sunrise /var/lib/ainvr-license-enforcer/start-pending.tmp
      mv /var/lib/ainvr-license-enforcer/start-pending.tmp /var/lib/ainvr-license-enforcer/start-pending
    fi
    (cd "$CON_DIR" && docker compose up -d --no-deps --force-recreate backend frontend)
  elif [[ "$ONLY" == license ]]; then
    (cd "$CON_DIR" && docker compose up -d --no-deps --force-recreate backend)
  fi
  if [[ "$ONLY" != provisioner ]]; then
    NETWORK_POLICY_BEFORE="$(sha256sum /etc/ainvr-ai-internal-networks.json 2>/dev/null || true)"
    python3 "$PKG_DIR/configure-internal-network.py" --install-monitor
    NETWORK_POLICY_AFTER="$(sha256sum /etc/ainvr-ai-internal-networks.json)"
  fi
  if [[ "$ONLY" == all ]]; then
    systemctl enable ainvr-ingest ainvr-os-helper ainvr-restart-helper ainvr-recorder ai-service fallback-provision.timer
    systemctl restart ainvr-yoloe ainvr-grounding
    systemctl restart ainvr-ingest ainvr-os-helper ainvr-restart-helper ainvr-recorder ai-service
    systemctl start fallback-provision.timer
  elif [[ "$ONLY" == python ]]; then
    systemctl enable ainvr-ingest
    systemctl restart ainvr-ingest ainvr-recorder ainvr-os-helper ainvr-restart-helper ainvr-license-enforcer
  elif [[ "$ONLY" == ai-service ]]; then
    systemctl restart ainvr-yoloe ainvr-grounding
    systemctl restart ai-service
  elif [[ "$ONLY" == console && "$NETWORK_POLICY_BEFORE" != "$NETWORK_POLICY_AFTER" ]]; then
    # Upgrade compatibility: older host binaries do not yet hot-reload policy.
    systemctl try-restart ai-service ainvr-recorder ainvr-os-helper ainvr-restart-helper
  elif [[ "$ONLY" == license ]]; then
    systemctl try-restart ai-service ainvr-recorder ainvr-os-helper ainvr-restart-helper
  elif [[ "$ONLY" == provisioner ]]; then
    systemctl enable --now fallback-provision.timer
    systemctl start fallback-provision.service
  fi
fi

log "完成。当前状态："
docker ps --format '  {{.Names}}\t{{.Status}}' 2>/dev/null || true
systemctl is-active ainvr-recorder ai-service ainvr-os-helper ainvr-restart-helper 2>/dev/null || true
systemctl is-active ainvr-license ainvr-license-enforcer 2>/dev/null || true
echo
echo "接下来按 INSTALL-FROM-SCRATCH.md 完成数据库初始化、授权及新板验收。"
