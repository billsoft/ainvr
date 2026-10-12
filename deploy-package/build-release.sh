#!/usr/bin/env bash
# =============================================================================
# build-release.sh —— 在【构建机】（aarch64 Jetson Orin NX，带源码与工具链）
# 打包生产制品。产物：out/AINVR-release-<日期>.tar.gz（不含模型）与
# out/models-<日期>.tar.gz（4.2GB，模型单独包）。
#
# 目标机只接收这些制品，不放任何 .py 业务源码。
#
# 用法：
#   ./build-release.sh                 # 完整打包（构建镜像+编译二进制+pyc）
#   ./build-release.sh --with-thirdparty   # 同时 save 公共镜像(postgres/mongo/srs)
#   SKIP_BUILD=1 ./build-release.sh    # 跳过镜像构建与编译（仅重新打包现有产物）
#   FORCE_MODELS=1 ./build-release.sh  # 强制重打模型包（默认模型未变就沿用 out/ 里最近的模型包）
# =============================================================================
set -euo pipefail

# ---- 路径：脚本在 <repo>/deploy-package/，仓库根为上一级 ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATE="$(date +%Y%m%d-%H%M%S)"
NAME="AINVR-release-$DATE"
WORK="$REPO_ROOT/out/$NAME"
WITH_THIRDPARTY=0
SKIP_BUILD="${SKIP_BUILD:-0}"

for a in "$@"; do
  case "$a" in
    --with-thirdparty) WITH_THIRDPARTY=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

# Bound host I/O before any build/export. Docker builds require maintenance.
if [[ "${AINVR_BUILD_IO_SCOPE:-0}" != 1 ]]; then
  exec bash "$SCRIPT_DIR/run-controlled-build.sh" "$@"
fi

log() { printf '\033[1;36m[build]\033[0m %s\n' "$*"; }

# ---- 前置检查 ----
command -v docker >/dev/null || { echo "需要 docker" >&2; exit 1; }

if [ "$SKIP_BUILD" != "1" ]; then
  command -v cmake >/dev/null || { echo "完整构建需要 cmake（或用 SKIP_BUILD=1 仅打包）" >&2; exit 1; }
  [ -d /home/sunrise/opencv/opencv-4.11.0/build/lib ] || {
    echo "未找到自编译 OpenCV（/home/sunrise/opencv/opencv-4.11.0/build/lib）" >&2
    echo "请先按 docs/deploy/INSTALL-FROM-SCRATCH.md 的 OpenCV 运行库章节准备" >&2; exit 1; }
fi

TRASH="$REPO_ROOT/out/_trash-$DATE"
mkdir -p "$TRASH"
[ -e "$WORK" ] && mv "$WORK" "$TRASH/" || true
mkdir -p "$WORK"/{images,compose/deploy/srs-conf,compose/deploy/branding,ai-service/bin,ai-service/config,ai-service/deploy,python/recording-service/src,python/shared,provisioner/deploy,license-service/bin,license-service/config,license-service/deploy}
python3 "$SCRIPT_DIR/source_state.py" "$REPO_ROOT" "$WORK/package-source-state.json"

# =============================================================================
# 1. Docker 镜像（前端/后端）
# =============================================================================
if [ "$SKIP_BUILD" != "1" ]; then
  log "构建前端/后端镜像"
  # Build-only placeholder: no service/container is started and this value is not shipped.
  ( cd "$REPO_ROOT/srs-web-console" && POSTGRES_PASSWORD=build-only-not-a-runtime-credential LICENSE_ENV_FILE=/dev/null docker compose --project-name srs-web-console build frontend backend )
fi
log "导出 frontend/backend 镜像 tar"
docker save srs-web-console-frontend:latest -o "$WORK/images/frontend.tar"
docker save srs-web-console-backend:latest  -o "$WORK/images/backend.tar"

# 公共镜像：唯一真值源 thirdparty-images.txt（引用 + 镜像 ID）
IMAGES_MANIFEST="$SCRIPT_DIR/thirdparty-images.txt"
python3 "$SCRIPT_DIR/thirdparty_images.py" compose "$IMAGES_MANIFEST" "$REPO_ROOT/srs-web-console/docker-compose.yml"
cp "$IMAGES_MANIFEST" "$SCRIPT_DIR/thirdparty_images.py" "$WORK/images/"
python3 "$SCRIPT_DIR/thirdparty_images.py" refs "$IMAGES_MANIFEST" > "$WORK/images/thirdparty.txt"
if [ "$WITH_THIRDPARTY" = "1" ]; then
  log "校验并导出公共镜像（缺失时拉取，保留已验证的本机版本）"
  mapfile -t THIRDPARTY_REFS < "$WORK/images/thirdparty.txt"
  for image in "${THIRDPARTY_REFS[@]}"; do
    docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
  done
  python3 "$SCRIPT_DIR/thirdparty_images.py" verify "$IMAGES_MANIFEST"
  docker save "${THIRDPARTY_REFS[@]}" -o "$WORK/images/thirdparty.tar"
fi

# =============================================================================
# 2. Compose 制品：移除 build，并补上固定的镜像名称；安装前不依赖源码。
# =============================================================================
log "组装 compose 部署目录"
cp "$REPO_ROOT/srs-web-console/docker-compose.yml" "$WORK/compose/"
[ -f "$REPO_ROOT/srs-web-console/.env.example" ] && \
  cp "$REPO_ROOT/srs-web-console/.env.example" "$WORK/compose/"
# Missing either file must fail the release: an old entrypoint/config can send
# HLS writes back to the system disk or fail the required tmpfs startup check.
cp "$REPO_ROOT/srs-web-console/deploy/srs-conf/srs.conf" "$WORK/compose/deploy/srs-conf/"
# 构建机自身的 srs.conf 会被控制台按页面设置改写（指定地址）：发布包一律还原为自动，
# 不把构建机的地址带给其他设备。audit_release.py 再校验一次。
sed -i 's|^\([[:space:]]*\)candidate[[:space:]].*;|\1candidate       *;|' "$WORK/compose/deploy/srs-conf/srs.conf"
cp "$REPO_ROOT/srs-web-console/deploy/srs-conf/hls.conf" "$WORK/compose/deploy/srs-conf/"
cp "$REPO_ROOT/srs-web-console/deploy/srs-entrypoint.sh" "$WORK/compose/deploy/"
cp "$REPO_ROOT/srs-web-console/deploy/srs-observer.py" \
   "$REPO_ROOT/srs-web-console/deploy/ainvr-srs-observer.service" "$WORK/compose/deploy/"
# OEM 品牌模板（出厂默认品牌）；安装时目标板已有则不覆盖
cp "$REPO_ROOT/srs-web-console/deploy/branding/branding.yaml" "$WORK/compose/deploy/branding/"
# Target boards receive explicit image references; no source/build context required.
python3 "$SCRIPT_DIR/prepare_release_compose.py" "$WORK/compose/docker-compose.yml" "$WORK/compose/docker-compose.release.yml"
POSTGRES_PASSWORD=build-only-not-a-runtime-credential LICENSE_ENV_FILE=/dev/null \
  docker compose --project-name srs-web-console -f "$WORK/compose/docker-compose.release.yml" config -q

# =============================================================================
# 3. AI C++ 二进制
# =============================================================================
# Independent build: never relink the running board's ai-service/build/ai_service.
AI_BUILD="$REPO_ROOT/out/build/ai-service-release"
if [ "$SKIP_BUILD" != "1" ]; then
  log "编译 ai_service"
  cmake -S "$REPO_ROOT/ai-service" -B "$AI_BUILD" \
    -DCMAKE_CUDA_ARCHITECTURES=87 -DCMAKE_BUILD_TYPE=RelWithDebInfo
  cmake --build "$AI_BUILD" --target ai_service --clean-first -j3
fi
log "收集 ai_service 与配置"
[[ -f "$AI_BUILD/ai_service" ]] || { echo "Missing independent AI build; run without SKIP_BUILD" >&2; exit 1; }
grep -qx 'CMAKE_BUILD_TYPE:STRING=RelWithDebInfo' "$AI_BUILD/CMakeCache.txt" || {
  echo "Unexpected AI build type; rebuild before packaging" >&2; exit 1;
}
cp "$AI_BUILD/ai_service" "$WORK/ai-service/bin/"
{
  git -C "$REPO_ROOT" rev-parse HEAD
  git -C "$REPO_ROOT" status --porcelain --untracked-files=no
  printf 'CMAKE_BUILD_TYPE=RelWithDebInfo\nCMAKE_CUDA_ARCHITECTURES=87\n'
  sha256sum "$AI_BUILD/ai_service"
} > "$WORK/ai-service/build-info.txt"
# Never collect the build board's live database/API credentials.
cp "$REPO_ROOT/ai-service/config/config.example.yaml" "$WORK/ai-service/config/config.yaml"
[ -f "$REPO_ROOT/ai-service/deploy/ai-service.service.example" ] && \
  cp "$REPO_ROOT/ai-service/deploy/ai-service.service.example" \
     "$WORK/ai-service/deploy/ai-service.service"
[ -d "$REPO_ROOT/ai-service/trt_engine_cache" ] && \
  cp -r "$REPO_ROOT/ai-service/trt_engine_cache" "$WORK/ai-service/"
chmod +x "$WORK/ai-service/bin/ai_service"
python3 "$SCRIPT_DIR/pack_prompted_runtimes.py" "$REPO_ROOT" "$WORK"
for service in ainvr-grounding ainvr-yoloe; do
  cp "$REPO_ROOT/ai-service/deploy/$service.service.example" "$WORK/ai-service/deploy/$service.service"
done
cp "$SCRIPT_DIR/configure-prompted-runtimes.py" "$WORK/"
[[ "$("$WORK/ai-service/bin/ai_service" --license-policy)" == mandatory-v2-no-runtime-bypass ]] || {
  echo "Stale/unsupported AI binary: rebuild mandatory licensing before packaging" >&2; exit 1;
}

# =============================================================================
# 3.5 Required v3 licensing authority and common installation templates.
#     No credentials from the build host are embedded or copied.
#     ★ tools/license-keygen/（keygen.py + MASTER_KEY.local）绝不收集进制品——
#       厂内注册机随包出厂即授权体系失效（design §1/§7）。
# =============================================================================
# ★ 绝不能编译到 license-service/build/：开发主板上正在运行的授权服务就是这个路径，make 重新链接会把运行中的
#   二进制换成新文件，客户端按 /proc/<pid>/exe 校验对端，会报 "untrusted license service process"，
#   当时旧客户端约 30 秒后失权，授权执行器停掉流媒体服务（2026-10-02 15:00 实际发生，停了约 10 分钟）。
#   所以放到 out/ 下的独立构建目录。
LIC_BUILD="$REPO_ROOT/out/build/license-service"
if [ "$SKIP_BUILD" != "1" ]; then
  cmake -S "$REPO_ROOT/license-service" -B "$LIC_BUILD" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$LIC_BUILD" -j3
  ctest --test-dir "$LIC_BUILD" --output-on-failure
fi
LIC_BIN="$LIC_BUILD/license_service"
[ -f "$LIC_BIN" ] || { echo "Missing required license binary" >&2; exit 1; }
[[ "$("$LIC_BIN" --license-policy)" == mandatory-v3-ed25519 ]] || {
  echo "Stale license authority: rebuild the v3 signed-license service" >&2; exit 1;
}
install -m 755 "$LIC_BIN" "$WORK/license-service/bin/license_service"
install -m 644 "$REPO_ROOT/license-service/deploy/"*.service.example "$WORK/license-service/deploy/"
install -m 755 "$REPO_ROOT/license-service/deploy/install.sh" "$WORK/license-service/deploy/install.sh"
install -m 644 "$REPO_ROOT/license-service/deploy/"*.py "$WORK/license-service/deploy/"
# Per-device credentials are supplied separately, not from the build host.

# =============================================================================
# 4. Python 服务 → 纯 .pyc（制品内零 .py 源码）
#    采用与仓库同构的兄弟目录布局（recording-service/ 与 shared/ 平级），
#    垫片向上查找 shared/python/config_center_client.pyc 才能命中。
# =============================================================================
log "编译 Python 服务为 .pyc（制品内零 .py）"
PYDST="$WORK/python"
mkdir -p "$PYDST/recording-service/src" \
         "$PYDST/shared/python" \
         "$PYDST/shared/os-helper" \
         "$PYDST/shared/host-restart-helper"
cp -r "$REPO_ROOT/recording-service/src/recorder" "$PYDST/recording-service/src/"
cp "$REPO_ROOT/shared/python/config_center_client.py" "$REPO_ROOT/shared/python/license_client.py" "$PYDST/shared/python/"
cp "$REPO_ROOT/shared/python/internal_network.py" "$PYDST/shared/python/"
mkdir -p "$PYDST/ingest-service"
cp "$REPO_ROOT/ingest-service/main.py" "$PYDST/ingest-service/"
cp "$REPO_ROOT/ingest-service/deploy/ainvr-ingest.service.example" "$PYDST/ainvr-ingest.service"
mkdir -p "$PYDST/shared/license-enforcer"
cp "$REPO_ROOT/shared/license-enforcer/main.py" "$PYDST/shared/license-enforcer/"
cp "$REPO_ROOT/shared/ainvr_logging.py" "$PYDST/shared/"
cp "$REPO_ROOT/shared/os-helper/main.py" "$REPO_ROOT/shared/os-helper/nm.py" \
   "$REPO_ROOT/shared/os-helper/remote_assist.py" "$REPO_ROOT/shared/os-helper/systime.py" \
   "$PYDST/shared/os-helper/"
# 远程协助隧道客户端（arm64）：人工放入 vendor/remote-assist/client 并附 client.sha256，
# 校验通过才随包；缺失时照常出包，设备页面显示"组件未安装"。
if [ -f "$SCRIPT_DIR/vendor/remote-assist/client" ]; then
  (cd "$SCRIPT_DIR/vendor/remote-assist" && sha256sum -c client.sha256) \
    || { echo "远程协助客户端校验失败" >&2; exit 1; }
  install -D -m 0755 "$SCRIPT_DIR/vendor/remote-assist/client" "$WORK/remote-assist/client"
fi
# 统一接入凭据（中转服务器上 relayctl fleet 导出，所有设备相同，不进代码仓库）：随包下发即免开通。
# 缺失时照常出包，设备页面显示"未写入凭据"。
for f in credentials.json server.json; do
  if [ -f "$SCRIPT_DIR/vendor/remote-assist/$f" ]; then
    install -D -m 0600 "$SCRIPT_DIR/vendor/remote-assist/$f" "$WORK/remote-assist/$f"
  fi
done
cp "$REPO_ROOT/shared/host-restart-helper/restart_helper.py" \
   "$REPO_ROOT/shared/host-restart-helper/observability.py" \
   "$PYDST/shared/host-restart-helper/"
# 编译为 legacy 布局（.py 同目录 .pyc，不依赖解释器版本 tag）
python3 -m compileall -b -q "$PYDST"
# 清掉源码树自带的 __pycache__/tag pyc，再删全部 .py
find "$PYDST" -type f -name '*.cpython-*.pyc' -exec mv {} "$TRASH/" \;
# -prune：移走目录后 find 不再进入它（否则报"没有那个文件或目录"，在 set -e 下直接中止打包）；
# 目标名加路径哈希，多个 __pycache__ 不会因同名互相冲突。
find "$PYDST" -type d -name __pycache__ -prune -exec sh -c 'mv "$1" "$2/$(printf %s "$1" | md5sum | cut -c1-12)-__pycache__"' _ {} "$TRASH" \;
find "$PYDST" -type f -name '*.py' -exec mv {} "$TRASH/" \;
# 收集 systemd / env 模板（install.sh 据此生成运行单元）
cp "$REPO_ROOT/recording-service/deploy/ainvr-recorder.service.example" \
   "$WORK/python/ainvr-recorder.service.example" 2>/dev/null || true
cp "$REPO_ROOT/shared/os-helper/deploy/os-helper.service.example" \
   "$WORK/python/os-helper.service.example" 2>/dev/null || true

# =============================================================================
# 5. fallback-provisioner → 纯 .pyc
# =============================================================================
log "编译 fallback-provisioner 为 .pyc"
cp "$REPO_ROOT/shared/fallback-provisioner/ensure_fallback.py" "$WORK/provisioner/ensure_fallback.py"
python3 -m compileall -b -q "$WORK/provisioner/ensure_fallback.py"
mv "$WORK/provisioner/ensure_fallback.py" "$TRASH/"
# deploy/ 模板仅作参考留存（install.sh 自行生成 service 单元，timer 直接拷贝）
cp "$REPO_ROOT/shared/fallback-provisioner/deploy/"* "$WORK/provisioner/deploy/" 2>/dev/null || true

# =============================================================================
# 6. install.sh + VERSION
# =============================================================================
cp "$SCRIPT_DIR/install.sh" "$WORK/"
cp "$SCRIPT_DIR/configure-internal-network.py" "$WORK/"
cp "$SCRIPT_DIR/reset-admin-password.py" "$WORK/"
cp "$SCRIPT_DIR/60-ainvr-writeback.conf" "$SCRIPT_DIR/rotate-consumer-keys.py" "$WORK/"
cp "$SCRIPT_DIR/install_python_code.py" "$SCRIPT_DIR/validate_console_env.py" "$SCRIPT_DIR/audit_release.py" \
   "$SCRIPT_DIR/model_package.py" "$SCRIPT_DIR/init_board_config.py" "$SCRIPT_DIR/bootstrap-jetson.sh" "$SCRIPT_DIR/check-business-ready.py" "$WORK/"
cp "$REPO_ROOT/license-service-design.md" "$WORK/"
mkdir -p "$WORK/docs/deploy"
cp "$SCRIPT_DIR/configure-ingest.py" "$WORK/"
cp "$REPO_ROOT/docs/multi-protocol-ingest-design.md" "$WORK/docs/"
cp "$REPO_ROOT/docs/multi-protocol-ingest-acceptance-20261009.md" "$WORK/docs/"
cp "$REPO_ROOT/docs/license-v3-design.md" "$WORK/docs/"
cp "$REPO_ROOT/docs/release-readiness-auth.md" "$WORK/docs/"
cp "$REPO_ROOT/docs/archive-reliable-design.md" "$WORK/docs/"
cp "$REPO_ROOT/docs/maintainability-refactor.md" "$WORK/docs/"
cp "$REPO_ROOT/docs/remote-assist-client.md" "$WORK/docs/"
cp "$REPO_ROOT/docs/open-vocabulary-runtime-deployment.md" "$WORK/docs/"
cp "$REPO_ROOT/ai-service/docs/recovery-policy.md" "$WORK/docs/"
cp "$REPO_ROOT/ai-service/docs/exposure-tone-design.md" "$WORK/docs/"
cp "$REPO_ROOT/docs/deploy/INSTALL-FROM-SCRATCH.md" "$WORK/docs/deploy/"
cat > "$WORK/INSTALL-FROM-SCRATCH.md" <<'DOC'
# 部署手册入口

完整操作手册：[新生产板从零部署与升级](docs/deploy/INSTALL-FROM-SCRATCH.md)。
授权设计：[离线授权 v3](docs/license-v3-design.md)。

手册保留源码目录结构，确保离线包中的相对链接可用。
DOC
# Keep the H.265 acceptance reference available on offline target boards.
cp "$REPO_ROOT/docs/h265-codec12-support-design-2026-09-29.md" "$WORK/docs/"
python3 - "$WORK" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
for name, old, new in (
 ('license-service-design.md','docs/deploy/INSTALL-FROM-SCRATCH.md','INSTALL-FROM-SCRATCH.md'),
 ('INSTALL-FROM-SCRATCH.md','../../license-service-design.md','license-service-design.md'),
):
 p=root/name;p.write_text(p.read_text().replace(old,new))
PY
chmod +x "$WORK/install.sh"
GIT_HASH="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
cat > "$WORK/VERSION" <<EOF
package: AINVR-release
git: $GIT_HASH
built: $(date '+%Y-%m-%d %H:%M:%S %z')
jetpack: 6.2 / L4T R36.4.3
cuda: 12.6 / tensorrt: 10.3 / opencv: 4.11.0(cuda)
thirdparty_offline: $([ "$WITH_THIRDPARTY" = 1 ] && echo yes || echo no)
license: $([ -f "$WORK/license-service/bin/license_service" ] && echo included || echo absent)
EOF

# =============================================================================
# 7. 打包（业务包，不含模型）
# =============================================================================
# Bind this exact model package before calculating the business manifest.
# 模型很少变：内容与最近的模型包一致就沿用（不重压 4.2GB、不加重磁盘负载，现场已有该包的
# 设备也不用再传）；FORCE_MODELS=1 强制重新打包。
if [ "${FORCE_MODELS:-0}" != 1 ] && MODELS_PKG="$(python3 "$SCRIPT_DIR/model_package.py" \
      --reuse-from "$REPO_ROOT/out" --source "$REPO_ROOT/ai-service/models")"; then
  log "模型未变化，沿用 $(basename "$MODELS_PKG")"
else
  MODELS_PKG="$REPO_ROOT/out/models-$DATE.tar.gz"
  log "打包模型目录（约 4.2GB，请等待）"
  tar --dereference --hard-dereference -czf "$MODELS_PKG" -C "$REPO_ROOT/ai-service" models
  python3 "$SCRIPT_DIR/model_package.py" --record-fingerprint "$MODELS_PKG" --source "$REPO_ROOT/ai-service/models"
fi
python3 "$SCRIPT_DIR/model_package.py" --manifest "$WORK/models-manifest.json" --create "$MODELS_PKG"
log "生成业务发布包"
python3 "$SCRIPT_DIR/source_state.py" "$REPO_ROOT" "$WORK/package-source-state.json" --verify
python3 "$SCRIPT_DIR/audit_release.py" "$WORK" --write-manifest
( cd "$REPO_ROOT/out" && tar czf "$NAME.tar.gz" "$NAME" )

log "完成："
echo "  $REPO_ROOT/out/$NAME.tar.gz"
echo "  $MODELS_PKG"
echo
echo "新板先按包内 INSTALL-FROM-SCRATCH.md 准备运行库、业务凭据和单板授权供应，再安装。"
