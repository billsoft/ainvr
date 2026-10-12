#!/usr/bin/env bash
# ainvr-recorder 安装/更新脚本（需 root/sudo）。
# 作用：建目录 → 安装 systemd unit → 拉起服务。
# 不安装 Python 依赖：复用 ai-service 的 conda 环境 ainvr。
set -euo pipefail

SERVICE_DIR="/home/sunrise/ainvr/recording-service"
UNIT_SRC="${SERVICE_DIR}/deploy/ainvr-recorder.service"
UNIT_DST="/etc/systemd/system/ainvr-recorder.service"
DATA_DIR="${SERVICE_DIR}/data"
LOCAL_RECORD_DIR="/home/sunrise/ainvr/data/recordings"

if [[ $EUID -ne 0 ]]; then
  echo "请使用 sudo 运行：sudo bash $0" >&2
  exit 1
fi

echo "==> 1/5 检查运行时（ainvr 环境 / ffmpeg / mount.cifs）"
PY=/home/sunrise/ainvr/.venv/bin/python3
[[ -x "$PY" ]] || { echo "缺少 $PY（先安装 ai-service 的 ainvr 环境）" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "缺少 ffmpeg（sudo apt install ffmpeg）" >&2; exit 1; }
command -v mount >/dev/null || { echo "缺少 mount" >&2; exit 1; }
grep -qw cifs /proc/filesystems || echo "警告：内核当前无 cifs 文件系统支持（mount.cifs 可能失败）" >&2
"$PY" -c "import fastapi, uvicorn, pydantic" || { echo "ainvr 缺少 fastapi/uvicorn/pydantic" >&2; exit 1; }

echo "==> 2/5 创建目录与 SMB 凭据位"
mkdir -p "$DATA_DIR" "$LOCAL_RECORD_DIR" /etc/ainvr-recorder /mnt/ainvr-recorder
chmod 700 /etc/ainvr-recorder
[[ -f /etc/ainvr-recorder/smb.cred ]] && chmod 600 /etc/ainvr-recorder/smb.cred || true
# 本机录像目录归属日常用户（ainvr），root 服务同样可写
chown -R ainvr:ainvr "$LOCAL_RECORD_DIR" 2>/dev/null || true

echo "==> 3/5 安装 systemd unit"
install -m 644 "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload

echo "==> 4/5 语法自检"
PYTHONPATH="${SERVICE_DIR}/src" "$PY" -c "from recorder.app import create_app; print('import OK')"

echo "==> 5/5 启用并启动"
systemctl enable ainvr-recorder.service
systemctl restart ainvr-recorder.service
sleep 2
systemctl --no-pager --full status ainvr-recorder.service | head -n 12 || true

cat <<'TIP'

安装完成。后续：
  journalctl -u ainvr-recorder -f          # 看日志
  curl -s http://127.0.0.1:8100/v1/recorder/health
  # 若控制台设置了登录口令，把 sha256 哈希写入 data/config.json 的 console.token
TIP
