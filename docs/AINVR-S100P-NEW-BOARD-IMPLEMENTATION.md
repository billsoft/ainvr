# AINVR 新 S100 / S100P 开发板实施手册

更新：2026-11-05。核对基线：仓库 `13a1d21`、开发板当前 systemd/容器挂载、编译脚本和数据库迁移源码。本文面向**新开发板、全新数据**。2026-11-05 在 `.190`（S100、12 GB）实际实施；源码在 SSD `/mnt/ainvr-ssd/ainvr`，兼容入口 `/home/sunrise/ainvr` 为递归 bind 挂载（不能使用软链接，见 §15.6）。不是 Jetson 安装指南，也不是整机克隆指南。

> 结论：拉取代码、复制模型还不够。还需要匹配的 BSP/驱动、SSD 与内存划分、工具链和非 Git 依赖、PG/Mongo/SRS、单板凭据、配置中心初始化、各服务编译安装、授权和业务配置，最后做重启与端到端验收。目前仓库没有覆盖全部组件的、经过空白 S100P 实机验证的一键安装器。本文把可执行步骤与需要工程人员完成的初始化明确分开，不把升级脚本冒充首次安装脚本。

本文已纳入 `.190` 新板实装经验；此前 `.189` 仅作为生产环境和锁定依赖参考；后续按用户授权执行 Node 26 升级，独立结果见第 16 节。构建成功、进程 active、健康接口成功、真实业务验收是不同关卡；未完成项目在末尾实测记录中单列。

## 1. 实施前准备与交付边界

### 1.1 新板信息表

开工前填写并随验收记录保存，不把凭据写在表中：

| 项目 | 新板填写内容 |
|---|---|
| 硬件 | 明确 S100 或 S100P；物理内存容量、载板、系统盘容量 |
| 系统 | BSP 镜像版本、内核、hobot-dnn/hobot-multimedia 包版本 |
| 存储 | SSD 序列号、分区 UUID、文件系统、挂载点、可用容量 |
| 网络 | 管理 IP、相机网段、网关、DNS、NTP、WebRTC 可达地址 |
| 软件 | Git commit、模型包 ID/SHA256、依赖锁清单、构建清单 |
| 业务 | 协议、通道数量/码率、录像保留、归档与搜索额度、告警规则 |
| 授权 | 本板设备标识、激活状态；签发私钥不进入设备 |

目录名是 `ai-service/models/`，不是根目录下的 `modles/`。模型不是只有 `.hbm`：必须连同 sidecar、分词器、归一化表、embedding、任务模板、模型清单等整个部署包复制，并按清单校验。

### 1.2 需要准备的材料

- 最新的已审查代码与锁文件；`git submodule status` 检查只读参考依赖，按锁定提交取用，不更新参考项目或子模块指针。
- S100P/nash-m 兼容 HBM 包。PT/ONNX/safetensors 是编译输入，不能作为板端生产推理替代品。
- ARM64 镜像包：PG 16、Mongo 7、SRS 7.0.162；核验 `deploy/infra/images.lock.json`，不能只看浮动 tag。
- Node 26 LTS（本次 26.13.0）、Python venv 依赖、C/C++ 构建依赖、Go、Rust/Cargo，以及锁定分词器源码与 Cargo 缓存。离线现场要提前打包。
- FFmpeg 8.1.2 **可执行程序、开发头文件、静态/动态链接库和 pkg-config 文件**，不能只拷一个 ffmpeg 命令。
- 单板独立生成的数据库/服务凭据、设备身份与参数库主密钥。新板不复制旧板 credentials、数据库目录、登录态、激活状态或 `/etc/machine-id`。

本次按用户要求：源码、构建、数据库、业务历史与增长型缓存全部放 SSD；部署模型放 `/home/sunrise/models`（eMMC），`ai-service/models` 以 bind 挂载映射到它。固定 runtime/凭据放 `/etc/ainvr/runtime`，仓库 runtime 只保留软链接。允许这种明确管理的单板路径映射，但不能保留指向旧板实验目录的悬空链接。所有依赖 SSD 的服务必须校验挂载后才能启动。

## 2. 当前系统拓扑与服务清单

当前是 **systemd 原生业务服务 + Docker 基础设施**。不要同时启动 `srs-web-console` 的另一套 Compose 控制台。页面“13 项健康”不等于实际只有 13 个系统服务。

| 服务/单元 | 代码/产物 | 职责与关键依赖 |
|---|---|---|
| `ainvr-postgres` 容器 | postgres:16-alpine | 配置、加密凭据、版本/审计、通道/布防/计数器、平面图元数据、搜索任务 |
| `ainvr-mongo` 容器 | mongo:7.0 | 识别图片/元数据、告警与审核证据、统计事实、搜索 JPEG/向量等历史 |
| `ainvr-srs` 容器 | ossrs/srs:7.0.162 | 接流、转发、WebRTC、HTTP-FLV；独立 HLS 子进程 |
| `ainvr-license` | license-service C++ | 单板身份、激活状态、签名授权租约，UDS `/run/ainvr-license/license.sock` |
| `ainvr-license-enforcer` | shared/license-enforcer | 授权与 SRS 生命周期联动 |
| `ainvr-backend` | backend/dist/server.js | 配置中心、鉴权、PG 迁移、各服务代理与任务协调，loopback:3001 |
| `ainvr-web` | nginx + frontend/dist | 80 默认入口 / 8088 兼容入口、静态页、接口/媒体代理 |
| `ainvr-ai` | ainvr_s100p_control_service → bin/ainvr_ai_service | 硬解、BPU 检测/跟踪、输出视频、逐目标归档、观测/搜索采样；8000/TCP |
| `ainvr-recorder` | recording-service Python | 分段录像、回放、原帧取证；8100，另有 SQLite 本地录像索引 |
| `ainvr-ingest` | ingest-service Python | RTSP 等输入接入、FFmpeg 转封装；8120 |
| `ainvr-os-helper` | shared/os-helper | 存储、系统时间等受控本机操作；8299 |
| `ainvr-restart-helper` | shared/host-restart-helper | 受控服务操作和观测；8199 |
| `ainvr-alarm` | alarm-service/src/main.mjs | 消费观测、规则/多标签/数量触发、计数/停留/热度、证据与审核队列；8200 |
| `ainvr-review-reference` | alarm-service/src/reference-main.mjs + image_probe | 后台参考分析及当前组合告警逐目标复核，依赖告警配置/库、取证和 LLM |
| `ainvr-llm` | ainvr_llm_service | 图像复审 BPU 模型；8300，当前默认 qwen3vl-2b-review-v1 |
| `ainvr-search` | ainvr_search_service | 检索、历史/索引协调；8400，独立 bootstrap |
| `ainvr-onvif` | onvif-service Go | 摄像机发现、能力、PTZ；专用用户 ainvr-onvif |
| `ainvr-gb28181` / `ainvr-gb-media` | Go gateway / 固定版 ZLMediaKit | 国标信令与独立媒体接收；专用用户 ainvr-gb |
| `ainvr-srs-observer` | srs-observer.py | 只读流媒体故障观测 |
| 定时器/日志策略 | internal-network、logrotate、journald 等 | 来源白名单更新、有界日志、运行维护 |

端口以上表源码/当前部署为参考；ONVIF/GB 的具体监听、SIP/RTP 范围来自本板配置，不照搬旧板地址。

## 3. 系统、驱动、内存和存储

### 3.1 核对板端环境

在新板执行并保存输出：

```bash
uname -m
uname -r
cat /etc/version
cat /etc/os-release
dpkg-query -W hobot-dnn hobot-multimedia
id sunrise
node --version
python3 --version
cmake --version
findmnt /mnt/ainvr-ssd
free -h
```

本次开发板实测：aarch64；内核 `6.1.158-rt58-DR-4.0.5-2603191535-gf29a43-g94bc27`；`/etc/version` 为 `4.0.4-Beta`，但 hobot-dnn/multimedia 已为 4.0.5；实施初始旧板 Node v24.20.0，新板改用 v26.13.0；Python 3.10.12、CMake 3.22.1。因此不能仅看 `/etc/version` 判断 HBM/SDK 兼容。

检查 `/usr/hobot/lib` 的 dnn、hbucp、hbmem、vpf、multimedia、EGL、GLESv2、gbm 及对应头文件、设备节点。以 `sunrise` 实际运行硬件探针验证权限；root 能运行不代表服务用户能运行。不启用 CPU 推理或 CPU 图像处理作为生产兜底。

### 3.2 分开核算 S100 / S100P 的 CPU 与 ION 内存

本次 .190（boardid `0x6A87`）实际启动设备树为 `/boot/hobot/rdk-s100-v1p1.dtb`。仅修改 `/reserved-memory/ion_reserved@C80000000` 的 `reg` 长度 `0xf0000000` → `0xb0000000`（3.75 → 2.75 GiB）；carveout 保持 2.75 GiB，ion_cma 保持 0.5 GiB，三个主池合计 6 GiB（另有驱动独立 4 MiB chunk 池）。启动固件会重定位 CMA 地址，须对照运行设备树和 debugfs 实测总量，不能仅看节点名地址。旧设备树保存在 SSD `/mnt/ainvr-ssd/ion-6gb-20261106/rdk-s100-v1p1.dtb.before`；回退时恢复此文件到原路径、sync 后重启。此次 Qwen3-VL 2B 加载成功、检测通道恢复、录像读取验证通过；这不等于已认证更多通道或所有模型同时加载的峰值。BSP 更新可能覆盖设备树，更新后须复验该划分。

`.189` S100P 为 24 GB，Linux 约 11 GiB；`.190` 是 S100、12 GB，初始 ION 7 GiB、Linux MemTotal 约 4412 MiB；2026-11-06 已调整为 ION 6 GiB，重启后 Linux MemTotal 约 5436 MiB，增加 1024 MiB。两板不能复用同一容器额度。ION 的配置值与驱动实测值仍须分别记录，不把 `free` 的 CPU 内存当整机内存。

- 本板存在 `/boot/extlinux/extlinux.conf`；不是通用的 `/boot/config.txt`。本文未确认内存调整的具体 overlay/固件参数，不提供猜测的烧写命令。
- 按该板 BSP 的实际配置流程调整后重启验证；不能只修改网页总量或模型 `ion_reserve_mb`。
- 验收 CPU 内存、ION 共享池总量/空闲、BPU 标记分配三者；视频硬件也使用共享池。
- 同时加载检测、GPEN、LLM、搜索并录像，测实际峰值；模型包的 `ion_bytes_measured` 是准入依据之一，不是整机峰值承诺。
- 旧板使用 12 GiB 共享池的目标值不能自动套用到不同内存 SKU。

### 3.3 SSD 与目录

由实施人员确认目标盘与 UUID 后配置 `/etc/fstab`，挂载至 `/mnt/ainvr-ssd`。本文不提供自动格式化命令，避免误清盘。当前板是 ext4；新板不用照抄 `/dev/nvme0n1`。

| 路径 | 作用/落盘位置 |
|---|---|
| `/mnt/ainvr-ssd/databases/postgres` | .190 的 PG 参数库也放 SSD；不要沿用 .189 的系统盘绑定 |
| `/mnt/ainvr-ssd/databases/mongo`、`mongo-config` | Mongo 数据和配置数据；当前 Compose 的实际绑定目录 |
| `data/console/keys/config-master.key` | PG 加密凭据主密钥，独立保管，不进入 Git |
| `data/license`、`data/license-identity` | 本板授权与身份，不克隆 |
| `data/ai`、SSD `/observations`、`/analytics` | AI 配置随仓库落 SSD，观测和统计环境变量明确指向 SSD |
| `/mnt/ainvr-ssd/ainvr/data/recorder` | .190 的录像索引/状态；`RECORDER_DATA` 与真实目录一致 |
| 录像目标目录 | 在本板录像设置中选择 SSD/NAS；不要保留初始系统盘默认录像目录 |
| `/mnt/ainvr-ssd/ainvr-alarm-evidence`、`ainvr-review-frames` | 告警证据、复核原帧缓存 |
| 搜索索引/平面图底图目录 | 在存储配置中选择 SSD；元数据与文件需配套保留 |
| `/mnt/ainvr-ssd/ainvr-rollback/<服务>/<时间戳>` | 每服务最多 3 份短期回滚备份 |

先确认挂载，再创建目录：

```bash
mountpoint -q /mnt/ainvr-ssd || exit 1
install -d -m 0755 /mnt/ainvr-ssd/databases
install -d -m 0700 /mnt/ainvr-ssd/databases/mongo /mnt/ainvr-ssd/databases/mongo-config
install -d -o sunrise -g sunrise -m 0700 \
  /mnt/ainvr-ssd/ainvr-alarm-evidence /mnt/ainvr-ssd/ainvr-review-frames
```

Mongo 镜像入口负责其数据库目录初始化权限；不要整盘 `chown -R sunrise`。用 systemd 的挂载依赖/启动前挂载检查防止 SSD 未挂载时写入同名系统盘目录。Docker 开机自启不自动证明这个依赖已经建立，必须做重启检查。

## 4. 工具链和编译输入

### 4.1 基础依赖

新板确认 apt 源后执行：

```bash
cd /home/sunrise/ainvr
sudo apt-get update
sudo bash deploy-package/bootstrap-s100p.sh --install
```

脚本安装基础 C++/Python/媒体/nginx 依赖和 `.venv`，**不供应 Node 26、Docker、完整模型、Rust/Go 或锁定分词器源码**。还需核对 curl/git/gpg、Rust/Cargo、`libicu-dev`（当前契约 ICU70）、rsyslog/logrotate 及对应构建所需工具。发行版变化后不能未经验证改用任意 ICU 主版本。

本次 Node 26.13.0 ARM64 安装在 `/opt/node-v26.13.0-linux-arm64`。后端、alarm、reference 的 systemd `ExecStart` 必须显式使用该版本；构建/测试设置相同 PATH。原先复制的 Node 24 留作回退，不将全局软链接改变当作服务升级。本次已将 ONVIF 构建、PTZ 部署/回滚、告警安装/发布、reference 单元模板共 6 处默认路径更新到同一 Node 26 路径。其他历史发布目录的单元仍须检查实际 ExecStart，不能只看交互 shell 的 node --version。

Node 26 兼容注意：前端 Vitest 的 jsdom 环境会被 Node 原生 Web Storage 全局遮蔽；在 `vite.config.ts` 的 `test.execArgv` 设置 `['--no-experimental-webstorage']`，仅让测试工作进程使用 jsdom 的浏览器存储，不给生产 Node 添加此开关，也不改浏览器业务代码。后端平面图测试另依赖 Git 外 `test/runtime/ai-codecs/jpeg.jpg`（640×320 JPEG）；全新板需准备该测试素材，否则 ENOENT 不是 Node 不兼容。该素材可以用软件生成，仅用于 JPEG 解析测试，不是生产 CPU 图像兜底。

```bash
bash deploy-package/build-ffmpeg-s100p.sh
/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg -version
AINVR_BUILD_JOBS=1 bash deploy-package/build-s100p.sh
(cd alarm-service && npm ci --no-audit --no-fund)
```

`build-s100p.sh` 构建前后端和 license，不包含 AI、LLM、search、ONVIF、GB。前端需包含类型检查，不把单独 vite 成功等同完整构建。

FFmpeg CMake 还验证 libavformat 62.12.102、libavcodec 62.28.102、libavutil 60.26.102。系统 apt 的另一版 FFmpeg 可以并存，但不能被错误链接进生产二进制。S100 的 CPU 内存只有约 4.3 GiB，C++/Rust 重编译本次先用 `-j1`；Node 测试 `--maxWorkers=1`，heap 上限约 1400 MiB。不可照搬 S100P 的并发值。npm/pip/Cargo/Go 缓存与 TMPDIR 放 SSD；监控 MemAvailable 和 OOM。实测大型 `reused_channel_worker.cpp` 在业务服务与前端测试并行时，即使 `-j1` 也触发 OOM。因此构建期额外启用 SSD 上 4 GiB 临时 swap（0600，不写 fstab）；构建后关闭，再按无 swap 条件验收服务内存。不能把构建交换空间当 ION 扩容。

### 4.2 不在 Git 中的分词器依赖

`llm-service/CMakeLists.txt` 默认要求 `/mnt/ainvr-ssd/llm-build/third_party/tokenizers-cpp`，模型复制不会带来这个构建依赖。

- tokenizers-cpp：`c586c52f93f7b060753bd2388eb96a105cb7374d`。
- SentencePiece：`e0f0f966959108415183d6cbe7a9051ca8bc2da1`。
- Abseil 与哈希、ICU 约束以 `test/search/tokenizer-dependencies.lock.json` 为准。
- 提供该源码树的锁定子模块和 Rust `Cargo.lock` 对应依赖；现有发布器可强制 `CARGO_NET_OFFLINE=true`；直接 LLM CMake 构建使用 `--locked`，并不会自动设置 offline。联网预取必须遵守 Cargo.lock，之后才能离线复现；不要解除锁定追最新依赖。必须复制完整 Git 元数据与锁定子模块，只有文件没有 `.git` 时，父目录 `git rev-parse` 可能误报另一个仓库的提交。

准备完成后：

```bash
python3 test/search/tokenizer-build-software.py --jobs 1
```

此步骤构建分词器软件，不加载 BPU。输出默认在 `out/search-tokenizer-software`。生产产物必须自包含所需静态依赖，`ldd` 不得依赖临时构建目录，不能出现 `not found`。正式 SSD 产物路径可用，但要有挂载依赖，不能依赖会清理的编译临时目录。

### 4.3 模型目录检查

按实际启用功能核对：

- `ai-service/models/derived/s100p/yolo26x.hbm` 与 `.ainvr.json`。
- face、GPEN256 及对应清单；可选 YOLOE32 还要其动态文本相关依赖，不只一个 HBM。
- `ai-service/models/llm/qwen3vl-2b-review-v1/llm-package.ainvr.json` 及其中列出的全部文件。
- `ai-service/models/search/{hbm,data,tokenizers}` 和 `SHA256SUMS.txt`，按选中的包核对完整文件集合。

可用 `python3 deploy-package/verify-local-runtime.py` 校验其覆盖的本地部署模型，但该工具固定检查部分模型，**不代表全部搜索包与业务推理通过**。其失败先区分未交付的可选包和必需包缺失，不能伪造空文件通过。

LLM 2B 图片复审与 Qwen3-VL-Embedding-2B 是两个不同用途的包。当前搜索产品默认仍为 SigLIP2；迁移 027 是保留编号的 no-op，不会自动切成 Qwen。SigLIP2 当前每场景 4×768=3072 浮点；不能拿单视图 768 维旧记录混用。新库可直接选定模型初始化；不要在新板照抄用于旧数据清空的 cutover 命令。

## 5. PG、Mongo、SRS 首次部署

### 5.1 创建单板凭据与容器

```bash
cd /home/sunrise/ainvr/deploy/infra
sudo bash install-docker.sh
sudo python3 prepare.py
```

`prepare.py` 生成四个随机密码，仅首次创建；不输出密码。其目录逻辑仍创建旧的 `data/mongo`，**不会创建 Compose 当前的 SSD Mongo 目录**，因此第 3 节必须先完成。

在 `deploy/infra/.env` 设置本板的 `SRS_CANDIDATE=<浏览器可达的新板地址>`；不能使用默认的旧开发板 192.168.100.189。域名/NAT 场景按实际可达地址验证 WebRTC，不以本地播放成功替代远端验收。

确认离线镜像已导入/在线镜像与锁文件一致后：

```bash
sudo docker compose -f /etc/ainvr/infra/compose.yaml up -d --wait
sudo docker compose -f /etc/ainvr/infra/compose.yaml ps
# verify.py 使用的 compose/绑定目录须先适配本板；使用独立验证报告记录实际重启与认证结果
```

`verify.py` 有临时数据和测试流操作；在新板空库阶段执行。`--restart` 会重启数据库，只用于新板维护验收。host 网络用于当前 S100P 内核桥接 raw 表限制，不另建一套数据库容器解决网络问题。

### 5.2 数据库分工与初始化边界

| 库/身份 | 初始化者 | 必须核对 |
|---|---|---|
| PG `ainvr_config` / 应用角色 `ainvr_config` | 容器首次启动 `init/postgres.sh` | 应用角色是库所有者，非集群管理员；host SCRAM |
| PG 业务表 | 后端 `PgConfigStore.init()` → migrator | 按版本逐个事务执行；`schema_migrations` 与当前 SQL 完整匹配 |
| Mongo `ainvr_snapshots` / `ainvr_ai` | 容器首次启动 `init/mongo.js` | 只授对应库 readWrite；AI/搜索按其配置使用历史命名空间 |
| Mongo `ainvr_alarm` / `ainvr_alarm_service` | 告警配置 provisioning | 基础 Mongo 初始化**不会**创建此库用户；须另外供应 |
| Mongo 集合/索引 | 对应服务初始化 | 启动日志无建索引/权限错误，真实写入和重启后读取通过 |
| SQLite 录像索引 | recorder | 与录像文件配套；不是 PG/Mongo 的替代品 |

PG 当前源码有 001–027，其中平面图是 025/026；以安装提交实际 SQL 为准。必须把 `backend/src/store/migrations` 复制到 `backend/dist/store/migrations`。迁移器在目录缺失时会读到空列表，不能仅凭后端进程存活判定数据库建好。

数据库 init 脚本只对空数据库目录运行；修改 secret 文件不会替已有数据库改密码。重复实施时先核对现状，不删除库目录“重新初始化”。

### 5.3 参数库主密钥与最小权限

`CONFIG_MASTER_KEY_PATH` 指向 `data/console/keys/config-master.key`。后端 CryptoStore 使用 AES-256-GCM；新空库可生成新密钥，已存在加密数据时必须恢复原密钥。启动前检查该文件的存在性、长度、属主和服务用户可读性，避免缺失时生成另一把密钥导致旧数据不可解。

不要把含 token/密码的 env、bootstrap、PG 明文解密快照、`/proc/<pid>/environ` 或 `docker inspect` 全量输出放入工单/Git。数据库管理密码、应用密码、配置服务 token、推理 caller key、设备授权密钥用途各异，不共用。

## 6. 基础管理服务与单板身份

已完成基础编译、SSD 和数据库后，`prepare-s100p.py` 可生成本板基础运行配置：

```bash
cd /home/sunrise/ainvr
sudo python3 deploy-package/prepare-s100p.py
```

它读取本板 `pg_app_password`，创建 credentials、license 配置、backend/AI/recorder/ingest/helper env、初始 nginx 配置。文件已存在时多处采用保留策略，因此旧文件不会因重跑自动升级成最新配置。

`install-s100p.sh --prepare` / `--start` 生成基础 systemd 单元，但会调用旧 `harden-storage-s100p.py`，该脚本仍用 `SSD/migration-backups` 且有旧状态目录改名行为，不符合当前统一每服务 3 份备份要求。**不能在未核对/调整该存储步骤前当作无人值守新板安装命令。** 新板先落实第 3 节目录和挂载，再由实施人员按脚本单元模板完成安装并核验权限；不运行旧数据迁移来创建空板状态。

基础配置生成后确认：

- 后端以 sunrise 运行，能读 PG 应用密码及自己的主密钥；root-only 的父目录不应阻断正常服务访问。
- recorder 的 `PYTHONPATH`、FFmpeg 路径、数据目录正确；录像数据目标切到 SSD/NAS。
- sunrise 存在，nginx 静态文件可读，80/8088 未被发行版默认 nginx 占用；只启用选定的 AINVR nginx 实例。
- `/etc/ainvr-ai-internal-networks.json` 由 `configure-internal-network.py --static-only --install-monitor` 生成维护。host 网络以回环通信，额外远端只配明确来源。
- 日志受限；安装 writeback/media-buffers 配置前核对本板适用性。
- 授权服务构建必须通过 CMake 的 `AINVR_ISSUER_KEY_ID`、`AINVR_ISSUER_PUBLIC_KEY_HEX` 注入发行方公钥；默认源码不信任任何发行方，单纯编译成功不能激活。只读取发行方 `public.json`，不把私钥打进二进制或板端。
- 校准时间，再生成申请/激活本板设备。签发必须使用 `/api/v1/license/machine-code` 返回的完整 `AINVR-REQ3-...`（绑定 installation_id），短机器码不够；一年按 365×24×60=525600 分钟签发。签发私钥及台账留在发行方电脑。签发流程参考 `license-service-design.md`、`docs/license-v3-design.md`；不复制旧板激活文件。
- 初次打开 Web 设置新的管理员密码。登录配置就绪不代表授权已允许 AI、录像、SRS 业务。

## 7. AI 与告警：首次初始化必须补齐的内容

### 7.1 AI

```bash
AINVR_BUILD_JOBS=1 bash deploy-package/build-ai-s100p.sh
```

运行前检查 CMake 功能开关；生产选择 BPU 服务，不运行实验 LocateAnything 守护进程。最终控制服务产物为 `ainvr_s100p_control_service`，安装路径按当前规范为 `deploy/s100p/bin/ainvr_ai_service`。

`install-ai-s100p.py` 是**已供应板升级器**，明确要求现有 `ai-service.json`、`ai-service.env`、`data/ai/config_overlay.json` 和受管 unit 软链接。`prepare-s100p.py` 仅生成 AI env，**没有生成完整 AI JSON 和 overlay**。首次安装需由工程人员按当前 AI 配置加载/schema 路径创建：

1. 私有 bootstrap JSON：独立 API key、loopback 管理监听、本板 Mongo snapshot_store 与凭据；初始 channels 为空，不携带旧板相机。**PG 的 ai-service/system/settings 不是同一个 JSON**：只能放允许下发的 server.api_key/log_level、snapshot_store；不能带 channels、server.host、server.port，否则 AI 拒绝 ACK。通道只走 AI 通道 API。
2. 持久 overlay、目录属主 sunrise、0700/0600 权限，实际路径与 unit 参数一致。
3. 配置中心 AI token 与后端登记一致，desired/applied 版本能够对齐。
4. 从已审查源码构建并安装二进制；将 `deploy/s100p/ainvr-ai.service` 的受审查定义复制为 `/etc/systemd/system/ainvr-ai.service` 普通文件，禁止 unit 定义或 wants 链接直接依赖尚未挂载的 SSD。原始 unit 和所有 drop-in 要一起检查，具体见 §15.9。
5. 明确观测/统计目录及原帧缓存环境变量，见下节。不要运行 `local-runtime-s100p.py --apply` 代替新板供应；它是旧布局迁移器，要求已有配置，还使用旧备份路径。

这一步当前没有通用全新 JSON 供应命令；未完成前不要启动自动重试循环，也不要从旧板连秘密一起复制整个 runtime。

### 7.2 告警、统计与审核

告警安装至少包含下面四层，缺一层可能表现为“有检测但不告警”或“有告警但一直证据不足”：

| 层 | 新板要做的事 |
|---|---|
| 配置身份 | alarm-service bootstrap 的 service_token 与 backend `CONFIG_SERVICE_TOKEN_ALARM_SERVICE` 配对；独立 API token/producer token；PG 参数经加密配置存储 |
| 存储 | 新建 ainvr_alarm 专用 Mongo 用户；证据目录、权限、保留额度；服务建集合/索引 |
| 观测与原帧 | AI 和 alarm 使用同一个观测 spool；AI 开启对应原帧缓存；服务可读取/回收所需证据 |
| 审核 | LLM 独立 alarm-review caller、录像补帧 helper、reference worker、模型绑定授权和完整审计 |

`.190` 实施采用的观测配置（与 `.189` 的路径不同）：

```text
AI:    AINVR_OBSERVATION_SPOOL_ROOT=/mnt/ainvr-ssd/observations
AI:    AINVR_ANALYTICS_STATE_ROOT=/mnt/ainvr-ssd/analytics
AI:    AINVR_REVIEW_FRAME_ROOT=/mnt/ainvr-ssd/ainvr-review-frames
alarm: AINVR_OBSERVATION_SPOOL_ROOT=/mnt/ainvr-ssd/observations
alarm: AINVR_ALARM_EVIDENCE_ROOT=/mnt/ainvr-ssd/ainvr-alarm-evidence
```

`provision-alarm-config-s100p.mjs` 包含所需数据库用户/配置事务逻辑，但硬性依赖 20261019 的候选与备份报告，不适合新板直接执行；禁止伪造报告绕过。`install-alarm-console-s100p.py` 也依赖特定候选，并要求已有 AI/录像运行。这两项属于第 12 节首次安装器缺口。

工程供应时沿用现有 PgConfigStore、alarmSettingsSchema、Mongo 用户角色和当前 systemd 权限设计，不能另造配置格式。Node release 复制当前 alarm-service/src、package/lock 与匹配 node_modules；alarm 与 reference 必须来自同一个源码版本。

录像补帧工具可单独构建安装：

```bash
sudo bash deploy-package/install-recording-evidence.sh
```

此命令安装 `ainvr_recording_frame` 和 recorder 环境配置，不自动重启 recorder；新板在启动阶段统一加载。补帧需要真实录像与原帧身份关联，不是只安装 helper 就一定有图。

reference 的入口形态：

```text
node <本次alarm发布目录>/src/reference-main.mjs \
  <runtime>/alarm-service-bootstrap.json \
  <本次工具目录>/ainvr_llm_image_probe
```

用新的稳定发布路径，不照抄旧的 `release-latest-20261025`。旧 reference README 描述“不写 handling”已不涵盖当前组合告警审核，必须以当前源码与 `docs/ALARM-GROUP-TRIGGERS.md` 为准。

## 8. LLM、搜索、ONVIF 和国标

### 8.1 LLM

依赖齐备后，可隔离构建（不会安装或加载模型）：

```bash
cmake -S llm-service -B out/build/new-board-llm \
  -DCMAKE_BUILD_TYPE=Release -DAINVR_FFMPEG_ROOT=/opt/ainvr/ffmpeg-8.1.2
cmake --build out/build/new-board-llm \
  --target ainvr_llm_service ainvr_llm_image_probe -j1
```

首次供应清单：

- `llm-service-bootstrap.json`：control_url、service_token；与 backend 的 `CONFIG_SERVICE_TOKEN_LLM_SERVICE` 对应。
- PG llm-service/system/settings：初始 disabled，模型 ID 与本板完整包一致。
- 独立 admin、console-try、alarm-review caller 密钥；需要搜索复核时独立 search-verify caller，不能借用告警 key。
- `provision-llm.mjs` 是仅首次 PG 设置供应入口，要求已有主密钥及正确 PG 环境，且**不会生成完整 unit/bootstrap**；不要在终端展开密码运行它。已有设置则经配置中心管理，不覆盖。
- `install-llm-console-s100p.py` 要求特定 SSD 候选和外部 build 路径；作为旧实施参考，不是通用新板安装器。
- 安装 `/run/ainvr` tmpfiles 规则（`deploy-package/ainvr-large-models.tmpfiles.conf`）并核对 sunrise 权限，保留共享大模型资源互斥/内存准入。

先验证模型加载、图像预处理、确认/误报/不确定案例、多人和多标签证据，再决定自动审核范围。`/etc/ainvr/review-authorization.json` 必须绑定本板实际模型包 SHA256、模式、标签与阈值；root 管理、服务可读、不能复制旧 4B 哈希。模型输出分数不是准确率，换 2B 后不能只验速度。授权文件、实际 model hash 与审核日志三方匹配才算自动审核启用。

### 8.2 搜索

在基础服务（包括 AI/LLM）已正确供应后，使用现有 search 发布链：

```bash
python3 deploy-package/build-onvif-release.py --profile search --output out/search-release-new-board
python3 deploy-package/prepare-ptz-components.py --profile search --candidate out/search-release-new-board
python3 deploy-package/deploy_ptz_release.py --profile search --check out/search-release-new-board
# 核对候选、前置单元与备份条件后，才在新板执行：
sudo python3 deploy-package/deploy_ptz_release.py --profile search --apply out/search-release-new-board
```

目录须新建、源码期间不变化。流程构建 AI/LLM/search/console/helper，强制原生搜索 tokenizer 和 BPU text，首次创建 search bootstrap/token/unit；**不负责首次供应整套基础服务，也不自动启用搜索或替用户选存储**。

然后在系统配置中：选择本板 SSD 历史/索引、包、通道、采样与保留额度，保存应用并等待 desired/applied 一致。当前 SigLIP2 四视图容量约 4 万条，结合 JPEG 字节额度和保留时间配置；Qwen embedding 用独立模型 pin 与阈值，不能混用旧向量空间。

需要搜索 AI 复核时，通过 LLM 设置“保存并应用”的现有事务供应 search-verify caller；检查任务 profile、模型 SHA 和可用状态。仅检索有结果，不等于参考复核已接通。

### 8.3 ONVIF / GB28181

- GB 构建入口 `bash deploy-package/gb28181/build.sh`：锁定 Go、ZLMediaKit、FFmpeg 并保留许可证；下载/离线缓存需提前准备。
- GB 安装前 `bash deploy-package/gb28181/install.sh --check`；通过后才执行不带 `--check` 的安装。供应本板配置和专用用户，不复用旧板 SIP ID、密码、地址。
- ONVIF 独立编译入口 `bash deploy-package/build-onvif.sh`（AINVR_GO 可指定已验证工具链）；正式联动发布使用 `build-onvif-release.py` 的非 search profile 与 `deploy_onvif_release.py`，不要只替换一个二进制漏掉 ingest/backend。
- 候选部署器检查已有运行状态和配置，首次不存在的组件须按其 provisioning 契约先处理；不把“检查失败”当作可跳过前置条件。
- PTZ 验收包括能力获取、方向/停止、预置位、控制中分析抑制/视图代次，不只测试发现摄像头。
- 国标配置本板 SIP 地址/端口、域/设备 ID、媒体公布地址、RTP 范围；验证注册→INVITE→真实视频→录像，不能只看注册在线。

## 9. 启动顺序和首次业务配置

按阶段启动并逐关验收，不一次性启动全部服务掩盖依赖错误：

1. 时间/SSD/设备权限 → Docker → PG、Mongo；SRS 由既定授权策略管理。
2. license → backend（迁移、主密钥、基础配置）→ helpers → nginx；完成管理员密码和本板激活。
3. 接入/SRS → recorder → AI；先一条测试通道验证实际帧进度。
4. alarm 与观测/证据 → LLM → reference；先人工审核，再明确授权的自动审核。
5. search 及采样 → ONVIF/GB/可选能力；逐项验证并发资源。
6. 检查 required units 的 enable 状态，重启整板验证自动恢复。

接入管理统一创建输入/输出 SRS 通道，AI 页面仅选择已有输入/输出，不另造第二套通道。新板 camera/NAS 凭据在配置中心重新输入。布防区、计数器、触发器、平面图按本板机位重新配置；平面图只规划位置，不改变检测范围。

## 10. 网络、日志和故障排查

外部按场景开放：80 TCP（默认管理入口）、8088 TCP（兼容旧地址，可按现场策略限制）、1935 TCP（RTMP）、8000 UDP（WebRTC）、10080 UDP（SRT）、明确配置的 GB SIP/RTP 和 ONVIF 发现流量。8000/TCP 是 AI 管理接口，与 8000/UDP 的 WebRTC 不同。

PG 5432、Mongo 27017、SRS 1985/8080、backend 3001、LLM/告警/搜索等管理接口保持本机或明确受控来源访问，不能为解决连接问题开放所有网段。S100 .190 当前 HLS tmpfs 为 384 MiB，SRS 容器 768 MiB；PG 容器 384 MiB（shared_buffers 64 MiB），Mongo 1 GiB（WiredTiger cache 0.25 GB）；容量调整依据见第 18 节。上限不是预留，需测试实际并发余量；禁止沿用 S100P 的 2 GiB HLS tmpfs，也禁止落回 eMMC。

常用只读检查：

```bash
systemctl --failed
systemctl list-units --type=service --all | grep ainvr
systemctl show ainvr-ai -p ExecStart -p DropInPaths -p NRestarts
systemctl show ainvr-alarm -p ExecStart -p DropInPaths -p NRestarts
docker compose -f /etc/ainvr/infra/compose.yaml ps
curl -fsS http://127.0.0.1:3001/api/health
curl -fsS http://127.0.0.1:8200/livez
curl -fsS http://127.0.0.1:8200/readyz
curl -fsS http://127.0.0.1:8300/health
curl -fsS http://127.0.0.1:8400/health
journalctl -u ainvr-backend -u ainvr-ai -u ainvr-alarm -n 100 --no-pager
```

按服务实际鉴权访问其业务接口，不因 401 取消鉴权。alarm 的探活是 `/livez`、`/readyz`，不要误用 `/health`。LLM/search 进程存活但应用 disabled 可能正常；最终需验证模型/索引 ready 与配置版本。

| 现象 | 优先检查 |
|---|---|
| Compose Mongo 启动失败 | SSD 挂载和两个 bind 源目录；prepare.py 没有创建新 SSD 目录 |
| 控制台登录正常、业务不可用 | 本板时间/授权、配置 desired/applied、服务凭据 |
| AI 可加载、没有识别历史 | snapshot_store 用户/库、SSD、归档开关/积压、图像硬件权限 |
| 检测存在、没有告警/计数 | 规则 enabled、alarm_enabled、通道绑定、同一 spool、跟踪和源时间连续性 |
| 告警有文字但复核不确定 | 原帧缓存、截图身份/范围、录像补帧、模型 caller 与哈希；不能强制清零 |
| 搜索空或报模型空间错误 | 模型/分词器全文件、active_model_pin、采样 ACK、存储额度、向量维度与索引 |
| 本地能看、别处 WebRTC 黑屏 | 新板 candidate、UDP 8000 可达性、实际网络/NAT |
| 重启后丢配置或库无法解密 | 持久目录、fstab、权限、PG 与原主密钥是否配套 |
| 更新后仍跑旧代码 | systemd 的 ExecStart、drop-in 覆盖次序、实际 /proc/PID/exe 与哈希 |

## 11. 新板交付验收清单

每项记录实测结果、提交/模型版本和日志位置，SKIP 单列，不计通过。

- [ ] PG 所有当前 migration 已执行，重启后配置仍在；配置加密读写成功。
- [ ] Mongo snapshots/alarm 的应用用户均可用，服务索引初始化成功；历史重启可读。
- [ ] SSD 真挂载，录像、Mongo、底图/索引/证据不会意外写系统盘；余量与保留策略正确。
- [ ] 所有 ELF `ldd` 无缺库，FFmpeg ABI 正确，无 CPU/Jetson 推理依赖；模型全包校验通过。
- [ ] 已安装单元/二进制/源码清单匹配，所有必需 drop-in 生效，没有旧绝对路径和旧 IP。
- [ ] 新板管理员、设备身份、服务身份独立，时间与授权正常，敏感文件不在 Git。
- [ ] 实际相机接入、实时播放、录像生成和回放首帧正确；断流恢复不需人工重启。
- [ ] AI 检测/跟踪、归档、帧身份、源/输出/录像通道映射和证据图片一致。
- [ ] 四类单目标触发分别测出现、接近、侵入、穿越，核对区域/边界和去重。
- [ ] 组合触发测“同帧 ≥3 人持续 1 秒”“人 AND 包同区”“猫 OR 狗”“3 秒内 2 人完成穿越”；先后出现但不同时在场不得误算人数同时满足。
- [ ] 告警事实、截图/区域/目标框、规则版本、时间窗口均冻结；人工确认/误报和 AI 确认/误报/不确定各覆盖，人工抢先处理不被 AI 覆盖。
- [ ] 热区/统计计数与事件下钻一致，覆盖不足明示；平面图保存、刷新和重启后恢复。
- [ ] 搜索真实采样、查询、原图/录像跳转及可选 AI 复核均可用，历史空间和阈值匹配模型。
- [ ] 浏览器检查 1366×768、1180×820、1920×1080，及现场触屏设备关键操作。
- [ ] 检测+录像+LLM+搜索并发实测 ION/CPU/内存、积压与延迟；记录测试时长和相机负载，不以空载速度替代。
- [ ] 安全关机再开机：挂载、容器、单元、授权、通道、统计/证据均恢复；不进行破坏性拔盘测试替代计划内验收。
- [ ] 回滚恢复程序与配套配置，但不回退客户业务数据；每服务备份最多 3 份。

建议在 `test/results/new-board-<日期>-<设备代号>/` 保存脱敏的 inventory、构建/模型哈希、迁移版本、用例结果、截图和问题单。完整 PG 备份、密钥及客户视频不混入可提交测试目录。

## 12. 现有自动化缺口与实施完成条件

以下是本次源码核对发现的真实缺口，实施计划需安排处理，不能通过伪造文件/跳过检查解决：

| 缺口 | 影响 | 完成条件 |
|---|---|---|
| infra prepare 与 Mongo SSD compose 不一致 | 空板容器因缺 bind 源目录启动失败 | 挂载检查和两个 SSD 目录纳入首次供应 |
| 基础 prepare 缺 AI JSON/overlay | AI 升级器拒绝安装 | 复用当前配置 schema 的空通道、独立凭据供应 |
| AI 安装器要求既有 unit | 无法直接从零安装 AI | 首次单元/目录/二进制安装与后续升级区分 |
| alarm 首装依赖旧候选/日期报告 | 不能通用创建告警库和身份 | 用当前 PgConfigStore/schema 做可重入供应，真正验证备份，不造报告 |
| LLM/reference 安装路径固定或在 Git 外 | 新板缺工具、源码 release 或 caller | 同一提交产物清单、bootstrap、caller、unit 成套安装 |
| search profile 是增量发布器 | 不能代替全栈首次供应 | 基础 AI/LLM/配置服务先完整建立，再纳入 search |
| tokenizer/Go/Rust/FFmpeg 构建输入未随 Git 获得 | 离线/空缓存构建失败 | 交付锁定依赖包，验证真实空缓存路径 |
| 多个旧脚本备份位置/保留数过时 | 不符合现行运维约定 | 全部归入 SSD/ainvr-rollback/服务，最多 3 份 |
| 旧模板 nginx/服务 drop-in 不含后续变更 | 新功能路由或取证权限缺失 | 从当前接口和单元契约生成，禁止整套照抄旧日期产物 |
| 当前运行 release 可能不同于仓库 HEAD | Git 拉取不等于实际部署 | 安装按 commit/产物哈希核验，不从旧运行目录取“最新源码” |

`.190` 本次使用明确的首次供应步骤补齐身份、AI JSON、告警库、LLM/search bootstrap 与 systemd；没有伪造旧候选报告。暂不能将本次实施记录称为通用可重入一键安装器：旧升级脚本的前置条件、固定路径与备份策略仍须逐项核对。

## 13. 备份与迁移边界

新板全新部署不需要旧板历史库。若后续要求迁移业务，作为独立任务安排停写窗口与恢复演练：

- PG 备份必须与原配置主密钥配套，数据库凭据、配置引用和消费身份一起核对。
- Mongo 用一致性备份/恢复工具，不能复制正在写入的 WiredTiger 目录；单机不是副本集，不假设有 oplog 兜底。
- 录像文件与 SQLite 索引、告警图片与关联 ID、平面图元数据与底图必须一致。
- 搜索索引可重建，但其原始 JPEG/向量、model pin、任务和覆盖账本需协调，不单独恢复旧分片。
- 单板 license 身份/已用时间/注销状态不作为普通业务数据跨设备复制；另走签发/迁移规则。
- 程序回滚不等于数据库逆迁移；清空搜索历史的 cutover 不是无损回退。

## 14. 核对依据

本文优先依据以下源码与本次实际运行单元，旧文档冲突时不照搬旧步骤：

- `deploy/infra/{compose.yaml,prepare.py,init/postgres.sh,init/mongo.js,images.lock.json}`。
- `deploy-package/{bootstrap-s100p.sh,build-s100p.sh,prepare-s100p.py,install-s100p.sh}`。
- `deploy-package/{build-ai-s100p.sh,install-ai-s100p.py,build-ffmpeg-s100p.sh}`。
- `deploy-package/{provision-alarm-config-s100p.mjs,install-alarm-console-s100p.py,provision-llm.mjs,install-llm-console-s100p.py,provision-alarm-review.mjs}`。
- `deploy-package/{SEARCH-RELEASE.md,search_release_profile.py,build-onvif-release.py,prepare-ptz-components.py}`。
- `deploy-package/{gb28181,review-reference}`、`install-recording-evidence.sh`。
- `llm-service/CMakeLists.txt`、`search-service/cmake/tokenizer.cmake`、`test/search/tokenizer-dependencies.lock.json`。
- `srs-web-console/backend/src/store/{pgStore.ts,migrator.ts,crypto.ts,migrations}`。
- 当前 systemd `ExecStart/EnvironmentFiles/DropInPaths`、Docker 实际 mounts、板端 SDK/运行库版本。

旧 `docs/deploy/INSTALL-FROM-SCRATCH.md` 包含 Jetson/TensorRT、Docker 控制台与旧备份目录，不作为本 S100P 新板实施入口；可引用其中仍适用的授权协议说明，但须核对当前代码。
## 15. .190 新板实装记录与复用注意（2026-11-05）

### 15.1 本板固定布局

- 设备：D-Robotics RDK S100 V1P1，12 GB；不是 S100P。Linux MemTotal 4412 MiB；控制台实测 ION 总池 7.00 GB。
- SSD ext4 UUID：`e2b56c36-2467-46ee-8bdd-56ae73a71957`，挂载 `/mnt/ainvr-ssd`。这是 .190 的值，其他板不得照抄。
- 源码：`/mnt/ainvr-ssd/ainvr`；兼容路径 `/home/sunrise/ainvr` 指向它。
- 模型：`/home/sunrise/models`；项目 `ai-service/models` 为 bind 挂载。旧 4B 已归档到 SSD，2B 全包与 .189 100 个文件核对一致。
- 固定私有配置：`/etc/ainvr/runtime`；项目 `deploy/s100p/runtime` 为软链接。
- 基础设施生效配置：`/etc/ainvr/infra/compose.yaml`；项目 `.env` 的 COMPOSE_FILE 指向它。显式指定旧仓库 compose 会绕过此选择，不能混用。
- Docker data-root、containerd root、PG、Mongo、录像、索引、观测、证据、底图与增长型日志均在 SSD。
- Nginx runtime/nginx 指向 `/mnt/ainvr-ssd/cache/nginx`，包括临时上传和代理缓存；`SRS_CONF_PATH=/etc/ainvr/infra/config/srs.conf` 必须指向容器实际读取的目录。该目录允许后端服务组原子更新。
- 本机 models 挂载目录、runtime/secrets 软链接、部署二进制目录加入 `.git/info/exclude`，避免将部署机布局或凭据入口误提交。

### 15.2 挂载和启动保护

`.190` fstab 使用 UUID、`noatime`、`nofail` 和启动超时。`nofail` 只允许操作系统在无 SSD 时启动，不允许业务退回 eMMC：Docker、containerd、AINVR 业务单元及 SSD 日志服务均用 `RequiresMountsFor=/mnt/ainvr-ssd`、`BindsTo=mnt-ainvr\x2dssd.mount`，业务启动前执行 `mountpoint -q`。

基础设施由 `ainvr-infra.service` 在挂载后执行有效 compose 的 `up -d --wait`。数据库只监听 loopback；SRS 的管理 API/HTTP 保持 loopback，RTMP/RTC/SRT 按实际业务对外。SRS 启停仍接受授权 enforcer 管理。

journald 使用 64 MiB 有界 RAM 缓冲并转发 syslog；持续系统文本日志在 `/mnt/ainvr-ssd/logs/system`，定时 logrotate（16 MiB 阈值、4 份）。SRS observer 与国标媒体日志也明确在 SSD。logrotate 阈值不是磁盘硬配额。

### 15.3 空白环境额外经验

1. 工具链必须看实际可执行文件：系统 `/usr/bin/cargo` 1.75 不能读当前 version=4 Cargo.lock；本板已有 rustup Cargo/rustc 1.99.1，LLM CMake 显式使用 `/root/.cargo/bin/cargo`。不能把“装了 cargo”当版本已兼容。
2. 分词器源码要带完整 `.git`/子模块；Abseil、SentencePiece 均按锁文件校验。旧项目的裸源码拷贝不满足提交验证。
3. Node 26 用固定绝对路径安装所有 Node 服务，前端构建仍是 `tsc -b && vite build`。Vitest 工作进程需避免 Node Web Storage 遮蔽 jsdom。
4. 平面图 JPEG 测试素材是 Git 外依赖：缺失时可在 `test/runtime/ai-codecs/jpeg.jpg` 准备 640×320 的合法 JPEG，再运行对应测试；记录该准备步骤，不把 ENOENT 隐藏成 skip。
5. 默认 apt nginx 可能自动占用 80；只在 `nginx -t` 通过后禁用发行版实例，启用 `ainvr-web`。
6. 新板补齐 `ainvr_alarm_service` 专用用户及 alarm/LLM/search 独立配置 token；PG 用现有 `PgConfigStore.publish` 与加密 secret 路径，不复制旧板秘密。
7. ONVIF 和 GB 网关从本次源码编译；第三方 MediaServer 与 media-bridge 从已锁定 .189 产物转移后逐个 SHA256 比对，并携带许可证。没有将旧板第一方运行目录冒充当前源码构建。
8. 首次控制台密码由用户在浏览器设置；不在实施手册保存密码。用户推流输入通道为“测试输入”，`live/test-input`，不属于模拟数据。
9. 后端 v27 迁移执行成功不等于所有测试开了数据库集成门控；测试中的 SKIP 要单独记录。未运行的相机/PTZ/国标端到端用例仍待实际设备验证。
10. 硬件图片入口要求 baseline 8-bit 4:2:0 JPEG。首次测试图为 4:4:4 时硬件明确拒绝；重新生成合规 4:2:0 测试素材后通过。生产不增加 CPU 解码或图像回退。
11. 不把 `ready` 与启用混淆：LLM 初次配置 disabled，搜索初次没有存储选择/采样授权；必须在硬件检查后通过配置中心正常启用，并核对 desired/applied 与模型状态。

本次记录目录：`test/results/s100-production-20261105/`；基础设施验证另见 `/mnt/ainvr-ssd/implementation-records/s100-infra-20261105/`。具体测试数字、启用状态与验收边界见下文。不能仅凭安装步骤或进程健康宣称全部业务验收通过。

### 15.4 已完成的业务检查

- 测试输入通道推流：`rtmp://192.168.100.190:1935/live/test-input`。实际输入 H.264、1920×1080、约 20 Mbps；录像里的源画面日期与板端接收日期不同，不能用源画面水印作为服务器时间。
- 测试输入分析：YOLO26x、跟踪启用、5 FPS；实测 5 FPS、处理耗时 P95 约 45 ms，检查时过载丢帧 0。此数字是单路本次观察，不是多路容量承诺。
- 识别历史归档已打开，默认上限 10,000 条，真实目标 JPEG 与记录已写入 SSD 上 Mongo；页面可打开截图。
- 录像目录通过配置中心选为 `/mnt/ainvr-ssd/recordings`，预算 100 GB、循环覆盖。先验证原输入录像，再切换为测试分析输出全天录像，停止输入的重复录制；已有输入录像保留。60 秒分段按关键帧切割，本次首段 67 秒；浏览器已实际播放文件。
- 2B 模型常驻已启用并确认配置 v7，模型 SHA256 `e74174589a8a4c2b43f2e7e1865ad7430401689d65c066235cbc1552e3b45281`。独立 BPU 探针约 2.244 秒；服务 HTTP 合成图复审返回 200、约 4.457 秒（含预处理及配额）。二者不能混为纯推理耗时，也不代表现场准确率。
- Node 26 验证：后端首次 845 通过/1 缺素材失败/191 跳过，补齐外部 JPEG 后对应文件 3 通过/1 跳过；前端完整运行 1573 通过/1 超时，该 SearchPage 文件独立重跑 49/49 通过。告警服务 324 通过、125 跳过、0 失败。不得将跳过计入通过或声称一次完整运行全绿。
- LLM CTest 6/6 通过；ONVIF、GB 网关 Go 测试通过。搜索与最终启动验收以收尾记录为准。
- root npm/cache、sunrise cache 已迁移到 SSD/build-cache 并保留原路径软链接；构建临时 swap 仅用于本次编译，不能成为生产内存充足的证据。
### 15.5 必查媒体插件，不能只看 AI 检测状态

新板有 GStreamer 开发库及 base/good 插件仍不够。实际发现检测 5 FPS 正常，但输出流不存在；日志出现“发布管线链接失败”，原因是缺少 `h264parse`、`h265parse`、`rtmp2sink`。补装 `gstreamer1.0-plugins-bad` 后重启 AI 服务，SRS 已接收到 `live/test-analysis`。

首次安装应执行并检查退出码：

```bash
apt-get install -y gstreamer1.0-plugins-bad
gst-inspect-1.0 appsrc >/dev/null
gst-inspect-1.0 h264parse >/dev/null
gst-inspect-1.0 h265parse >/dev/null
gst-inspect-1.0 flvmux >/dev/null
gst-inspect-1.0 rtmp2sink >/dev/null
```

插件存在只说明依赖满足；还必须实际验证 SRS 输出流的 publish 状态、持续字节增长、SEI 和浏览器播放。此次补装是解析/封装/传输依赖，未引入 CPU 推理或 CPU 图像回退。
### 15.6 搜索模型路径必须满足安全打开约束

搜索 `model_package.cpp` 对模型根路径的每一级使用 `O_NOFOLLOW`。源码或 models 父路径为软链接时，即使文件校验和一致，清单仍为空。**不能删除安全校验来兼容部署布局。** .190 改为以下持久挂载：

```fstab
/home/sunrise/models /mnt/ainvr-ssd/ainvr/ai-service/models none bind,nofail,x-systemd.requires-mounts-for=/mnt/ainvr-ssd 0 0
/mnt/ainvr-ssd/ainvr /home/sunrise/ainvr none rbind,nofail,x-systemd.requires-mounts-for=/mnt/ainvr-ssd/ainvr/ai-service/models 0 0
```

先挂模型，再递归挂仓库。第二条必须为 **rbind**：普通 bind 不带入已存在的 models 子挂载，会看到空目录。挂载点必须是真实空目录，不是软链接；首次转换前验证原链接确实指向上述目录，停止使用模型的服务，保存 fstab 到 SSD 回滚目录。

AI、LLM、search、backend、review-reference 的 `40-model-mounts.conf` 增加：

```ini
[Unit]
RequiresMountsFor=/home/sunrise/ainvr /mnt/ainvr-ssd/ainvr/ai-service/models
```

保持已有 SSD `BindsTo`/挂载前置检查。完成后以 sunrise 身份执行 `ainvr_search_service --models`，应发现 SigLIP2 包；`model_validation_pending` 表示文件发现成功、尚未执行启用校验，不是模型推理通过。最终还要验证配置确认和真实搜索。
### 15.7 搜索索引权限与录像身份

- `.190` 的源码目录归 root，服务以 sunrise 运行。UI 选择磁盘根后索引相对目录为 `ainvr/search-index`，首次供应应执行 `install -d -o sunrise -g sunrise -m700 /mnt/ainvr-ssd/ainvr/search-index`。否则配置能保存但服务报 `storage_unavailable`；不能通过把整个源码树设成可写或放宽数据库权限修复。
- 修复目录后服务可重试原版本。保存失败不代表配置未写入；遇到版本冲突先重新加载页面，核对当前版本和就绪状态，不重复覆盖。此板搜索配置 v10 已应用。
- 现有 `searchSourceCatalog.ts` 使用输出通道 ID 作为 `recording_channel_id`；输入与输出是独立录像身份。只录原输入时搜索图片仍可检索，但候选不能直接跳转输出录像。该板最终录制 `live/test-analysis`，不再同时重复录制 `live/test-input`；原有测试录像保留。输出透传视频和 SEI，当前输出不含音频；若现场要求声音，需明确选择原输入录制及搜索关联产品方案，不能宣称衍生流保留声音。
- 搜索模型 SigLIP2、历史证据上限 1 GB/30 天，复用 Mongo；派生索引在 SSD。首次检索已返回真实场景候选，样本覆盖只从启用采集后开始，不补造此前历史。
- 搜索 AI 参考复核目前保持暂停，模型迁移能力提示仍有边界；不为让页面显示全功能而绕过各自能力/验收开关。告警图片复审的 2B 常驻服务独立可用。
### 15.8 构建收尾与验收边界

- 搜索 CTest 最终 **27 通过、5 跳过、0 失败**。跳过为真实 Mongo 门控：history、http、session、migration_artifacts、verification；不能算集成测试通过。
- 两项初始测试失败已解决：缺旧 SigLIP SO400M 分词器素材，从 .189 的 SSD 备用模型目录复制测试文件（SHA256 `ef78f86560d809067d12bac6c09f19a462cb3af3f54d2b8acbba26e1433125d6`）；BPU 文本契约测试还断言默认 Qwen，与当前默认 SigLIP2 冲突，修正断言并重跑。未修改实际默认模型逻辑。
- 录像硬件 helper 已安装并通过 `90-evidence-recovery.conf` 配置给 recorder。在真实输出 MP4 中按 packet position 3960 精确恢复首个关键帧，生成 249455 字节 JPEG，使用 VPU 解码、GLES 缩放、JPU 编码；不是 ffmpeg CPU 截图替代。
- UI 已验证：原始录像播放、分析衍生流及 SEI 叠框、识别历史截图、文本搜索返回真实候选、关联录像在当前已登录标签页播放。自动化新标签页曾出现状态未知/播放失败，同一地址在当前登录页成功；新标签会话继承尚不能按此结果认定全面通过。
- 编译过程中曾发生内存不足并临时启用 SSD swap；收尾已成功 swapoff 并删除该临时文件，未写 fstab。重启前 Linux 内存 4412 MiB、可用约 819 MiB、Swap 0；不可把 ION 余量当 CPU 内存余量。
- 单路视频测试期间，归档启用及编译同时运行曾出现 51 次归档反压跳帧，随后检测回到 5 FPS；不声称全程零丢帧，更不声称已完成多路压力/长稳验收。
- 未配置现场布防/告警触发器，未以模拟自动确认冒充现场审核通过；未做现场误报率评估、多路容量、长稳、PTZ/国标外部设备联调。人脸/GPEN/开放词汇模型文件到位不等于每个模型已在此板逐项验收。
- 一年授权按机器码正常签发并激活；私钥只保留本机签发工具，未上板、未进仓库。该阶段没有提交或推送；后续按用户授权提交，见第 16 节。
### 15.9 开机实测发现：systemd 单元本身不得依赖 SSD 挂载

首次整板重启后，PG/Mongo/SRS、Web、LLM、搜索等恢复，但 AI 单元为 not-found。原因是 `/etc/systemd/system/ainvr-ai.service` 及 wants 链接直接指向 SSD 上的单元文件，systemd 开机读取单元时挂载尚未完成，连依赖声明都读不到。

**最终布局**：单元定义作为固定配置保存在 `/etc/systemd/system/ainvr-ai.service` 普通文件；`multi-user.target.wants/ainvr-ai.service` 指向该系统文件；ExecStart/WorkingDirectory 仍指向 SSD/兼容 bind 入口。保留所有 SSD、模型挂载依赖。不能仅用 daemon-reload 后启动成功代替冷启动验证。

此点与旧 AI 增量升级器“必须链接仓库 unit”的前置检查存在冲突：后续升级器应支持/核验本机固定 unit 定义及挂载保护，不能为了满足旧检查把单元链接回启动时不可用的 SSD。此次未改写旧升级器、未伪造其检查通过。
### 15.10 最终重启验收（2026-11-05 17:33–17:35 CST）

第二次整板重启通过，boot ID 已变化。18 个业务/辅助常驻单元均 running，基础设施 oneshot 为 active/exited；PG/Mongo healthy，SRS 运行，systemd failed 单元为 0。Web 控制台显示 **13/13 服务正常**。输入与分析输出流自动恢复，输出录像继续生成；一年授权仍有效。

- CPU 内存：4412 MiB 总量、可用约 2125 MiB，Swap 0。UI 快照显示 ION 3.73/7.00 GB、BPU 内存 3.37 GB。为单路现场流、归档、录像、SigLIP2 与 2B 常驻的当时实测，非多路容量上限。
- backend、alarm live/ready、LLM、search、license 探活均 200；LLM `ready:true`，搜索带鉴权的 `/v1/status` 也为 `ready:true`，模型空间 `search-v1-515bf4fe107a1fe47043d0b032c0d25758b25bb692322b07ef57d28546fb8710`。
- 固定目录及持久挂载复核通过，临时编译 swap 文件已删除；基础设施回滚快照 2 份，日志配置回滚 1 份，均在 SSD。
- 测试、硬件探针和状态记录：`test/results/s100-production-20261105/`。代码修改只有 Node26 的 Vitest worker 配置及过时默认模型测试断言，另外为实施文档；当次部署未提交或推送，后续提交范围见第 16 节。

后续使用推流地址 `rtmp://192.168.100.190:1935/live/test-input`，控制台 `http://192.168.100.190/`。现场告警规则、准确率、多路压力和新标签播放问题按 §15.8 边界继续验收。
## 16. Node 26 统一升级与实施文档审计

本节为后续维护入口，前面的 .190 时间点记录保留历史事实。主手册覆盖实际安装、配置与验证，但**不是可无人值守执行的一键安装器**：第 12 节所列新板供应缺口、现场授权和业务参数仍需工程人员处理。未执行的验收项不会因文档补全而变成已通过。

### 16.1 已有板升级步骤

1. 记录 Git HEAD/status、每个 Node 服务的实际 `/proc/<PID>/exe`、完整 unit/drop-in 与原启动参数；确认不是只替换全局 node 链接。
2. 将验证过的 ARM64 Node 26.13.0 安装到 `/opt/node-v26.13.0-linux-arm64`，核对来源和转移校验和。保留 `/opt/ainvr/node-v24.20.0-linux-arm64` 以供回滚，禁止将带密码的 runtime 或其他板授权状态一起复制。
3. 在隔离测试目录使用该绝对路径及同版 npm，按 package-lock 执行 npm ci；前后端 build 含类型检查，然后运行前端、后端、告警测试。外部素材、数据库门控跳过、重试必须分别记账。
4. 对 backend、alarm、review-reference 的 unit 及已有 drop-in，只替换 ExecStart 的 Node 可执行文件，保持既有发布目录、bootstrap、取证工具、用户、沙箱及资源限制。不增加固定旧发布目录的高优先级覆盖，否则后续部署可能仍运行旧版本。变更前把原 drop-in/unit 配置放 SSD 的 ainvr-rollback/node-runtime/时间戳，每服务域最多 3 份。
5. 仅重启 Node 业务服务，逐一检查进程实际可执行路径和业务健康。AI/C++、LLM、搜索、PG/Mongo/SRS 不因 Node 升级而重启。验证控制台鉴权请求、告警列表/审核状态和已有录像可访问。
6. 保存部署清单、测试日志、重启前后状态与回滚说明。Node 升级失败时恢复备份的 unit/drop-in 与 node/npm/npx 链接、daemon-reload，按原路径重启；不要回滚客户数据库。
7. 提交仅包含审查过的源码、测试与文档。模型、密钥、node_modules、dist、客户视频/截图、临时测试日志与运行配置不进入 Git。

### 16.2 新板实施必查清单

- [x] 原理与实际路径一致：源码/models 用 bind/rbind，systemd unit 自身保存在系统配置盘。
- [x] PG/Mongo/Docker、增长型日志、录像/索引/证据均明确 SSD 路径和额度。
- [x] GStreamer 发布插件、FFmpeg ABI、tokenizer/Rust/Go 及 JPEG420 硬件约束已记录。
- [x] 参数库迁移、主密钥、独立服务身份、模型授权、初次密码与一年授权流程已说明。
- [x] .190 实测推流、检测归档、搜索、录像和两次重启问题与最终结果已记录。
- [ ] 通用可重入首次安装器：仍未交付，禁止直接把历史增量升级器当作它。
- [ ] 多路/长稳、现场误报率、PTZ/国标外设以及新标签播放故障：仍需对应环境验收。
### 16.3 .189 Node 26 实施结果（2026-11-05）

用户授权本次提交、推送及旧板升级。.190 的源码修正和实施文档先提交为 `946a281` 并推送 GitHub；.189 快进到同一提交后进行隔离验证。原有未跟踪的旧手册已保存在 SSD 回滚目录，未混入提交。

- 两板使用相同的 `/opt/node-v26.13.0-linux-arm64`。从 .190 已部署目录打包转移，包 SHA256 `94ae804d76b9e46b3363fdc8351b5451845c6653df0bffefb101f6718962b83c`，.189 解包前校验一致；Node 可执行文件 SHA256 `66f4a883c880ef336276e7730c01cbae2b92fb8e6a51f7371f920599cac824b7`。这是两板传输一致性校验，不声称重新核验了官方发布签名。
- .189 在 SSD 独立 worktree 执行各项目 `npm ci`；前后端 build 含类型检查均通过。前端 207 文件、1574 测试通过；后端 846 通过、191 跳过；告警 324 通过、125 跳过，三套无失败。数据库/硬件门控跳过不算通过。
- 线上告警与参考复核发布目录的 88 个 MJS 文件另外通过 Node26 语法检查。六个部署入口以及九个验收脚本的 Node24 固定路径已统一为 Node26；Python 编译检查和 shell `bash -n` 通过，未声称这些硬件/外部设备脚本都完整执行过。
- 只修改三个 Node 服务既有 unit/drop-in 的解释器路径，并同步 `/usr/local/bin/node`、`npm`、`npx`。保留原发布目录、bootstrap、凭据及硬件取证程序，不新增锁定旧发布路径的 99 级覆盖。仅重启 backend、alarm、review-reference，三者 `/proc/<PID>/exe` 均指向 Node26，自动重启计数为 0。
- 服务刚启动 5 秒时告警 HTTP 仍未监听；等配置中心应用完成后探活与真实鉴权查询通过。因此升级脚本应以有超时的 readiness 轮询验收，不能把 systemd active 或固定睡眠当作就绪。
- 后端 `/api/health`、Web 入口、告警 `/livez`、`/readyz` 及带鉴权 `/v1/events?limit=1` 均成功，告警配置 v6 已应用、ready=true；返回告警未暴露 checkpoint/lease_token。参考复核日志持续 queue_idle。没有新造告警或修改已有人工结论来冒充审核验收。
- AI、LLM、搜索、录像、接入 PID 与升级前一致；PG/Mongo/SRS 未重启；systemd failed 为 0。本次未做 .189 整板重启、浏览器交互/录像播放复测或长稳测试。
- 回滚配置在 `/mnt/ainvr-ssd/ainvr-rollback/node-runtime/20261105/`，此服务域当前 1 份；旧 Node24 安装保留。恢复该目录中三个 unit 及各自 drop-in、按 runtime-links.json 恢复三个链接，daemon-reload 后重启三个 Node 服务即可回退，不回退数据库。
- 完整测试日志与升级前后摘要在 `.189:/mnt/ainvr-ssd/ainvr-tests/node26-20261105/`，不把依赖、视频、私有配置或运行日志提交 Git。

**源码与线上发布边界**：升级前发现 .189 告警运行目录的 `review-authorization.mjs`、`ingestion.mjs`、`group-events.mjs`、`group-review.mjs` 与 Git 最新源码不同。本次保留运行目录，只升级 Node；上面的全量测试指 Git 源码，不能等同于线上全部业务代码已更新。若需要发布这些既有群组告警改动，应独立审查、部署和验收。

**Git 凭据**：板上只读拉取可用，.190 HTTPS 推送未配置凭据。本次在板上生成提交，经 Git bundle 转到已授权本机 Git Credential Manager 推送，未将 GitHub 凭据复制到板上。完成后两板 main 快进同步；以后仍仅在用户明确要求时提交/推送。

## 17. 默认 Web 入口：直接输入设备 IP（2026-11-05）

交付地址统一使用 `http://设备IP/`，用户无需输入端口：

- .189：`http://192.168.100.189/`
- .190：`http://192.168.100.190/`

HTTP 默认端口为 80。两板当前 AINVR nginx 和仓库 `deploy-package/prepare-s100p.py` 模板已在同一 server 内同时配置 `listen 80;`、`listen 8088;`，不是新增一套代理。8088 保留为旧书签兼容入口，默认交付说明不再要求输入 8088。实际配置持久保存在 `deploy/s100p/runtime/nginx.conf`，由已启用的 `ainvr-web.service` 加载；.190 的实际私有配置在 `/etc/ainvr/runtime`。

新板部署应检查 80 是否被发行版 nginx 或其他服务占用；不要在已有业务占用时强行抢占，也不要并行启用默认 nginx。验证实际加载的配置与模板一致，执行指定 prefix/config 的 nginx -t，再通过设备 IP 检查首页、静态资源、前端深层路由与 API。同一入口继续复用现有接口、录像和媒体鉴权路由，保留 Host / X-Forwarded-Host；不能为省端口绕过鉴权。

2026-11-05 从开发电脑访问两板实测：80 和 8088 的首页、`/alarms`、`/analytics`、`/api/auth/status`、`/api/health` 均为 HTTP 200，80 下引用的 JS/CSS 资源返回 200；同一板两个入口首页 SHA256 一致。两板 nginx 配置检查通过。这里的路由 200 是入口连通性检查，不等于已登录交互、录像播放或告警审核验收。现有运行配置已满足要求，本次未改端口配置、未重启服务。

从 8088 切换到 80 属于浏览器来源变化，本地存储的登录状态可能需要重新登录，这是正常的来源隔离。当前入口为 HTTP，未配置 HTTPS 证书；不要把 `https://设备IP/` 作为已经可用的地址。以后配置域名与受信任证书时再启用 443，并单独验证 HTTPS、媒体协议及登录行为。

## 18. .190 运行体检后的修复（2026-11-05，覆盖前文旧容量值）

### 18.1 回放媒体会话与时间轴

原故障是列表携带控制台请求头能成功，但原生 video 的媒体 Cookie 未通过验证；MP4 文件存在且授权 Range 返回 206，不能提示为循环覆盖。现在每次选择片段、手动重试及原有 30 秒保护续期均先 POST `/api/auth/media-session`，随后以纯 Cookie GET `/api/auth/media-check`，通过后再取得录像 availability/播放保护。保持 HttpOnly、同源和原服务鉴权，不把令牌放进 URL，不整段下载 blob。

媒体播放失败时每次用户选择最多自动恢复一次，保留当时目标/已解码时间，核对请求身份防止切换通道或片段后的旧异步结果覆盖新选择。自动恢复仍失败时停止循环，展示错误原因并允许手动重试。404/410 才按明确缺失移出时间轴；401 提示登录，其他读取或解码问题不再笼统说已覆盖。已有完整片段发布、实测时长、播放保护和媒体时间校验继续复用，没有新增并行索引或重复采集。

### 18.2 HLS 实际 GOP 与 tmpfs 容量

.190 原 256 MiB HLS tmpfs 在两路约 20 Mbps 视频下发生 FileWrite 和 HLS 子进程反复恢复重启。`hls_fragment` 是目标值，不能突破上游关键帧边界；现场曾得到约 16.7 秒分片，不能按配置的 2 秒估算内存。

最终 `.190:/etc/ainvr/infra/compose.yaml` 的 SRS `/run/srs-http` 为 **384m tmpfs**，容器内存上限仍 **768m**；内部 hls.conf 改为 `hls_fragment 2; hls_window 12; hls_dispose 30;`，两份仓库 HLS 模板同步。按实际分片、音频、码率、同时发布通道和静态资源计算峰值并留余量；本结果只覆盖当前两条流，不代表任意多路容量。

仅修改磁盘上的 Compose 不会改变已创建容器的 tmpfs；应先 `docker compose -f /etc/ainvr/infra/compose.yaml config --quiet`，再在允许短暂推流重连的窗口执行 `docker compose -f /etc/ainvr/infra/compose.yaml up -d --no-deps srs`。本次执行了一次，输入、AI 输出和录像已恢复。不要清空录像目录或整套重启数据库。

### 18.3 系统日志与蓝牙

把 rsyslog 路径改到 SSD 还必须更新 AppArmor；仅 chmod 不够。仓库 `deploy-package/repair-s100-runtime.py` 在既有 rsyslog local include 中只增加 `/mnt/ainvr-ssd/logs/system/` 的读及子文件读写规则，重载 profile 并验证 rsyslog，保持 AppArmor 启用。SSD 挂载依赖和现有 logrotate 策略继续生效，备份在 SSD 的 host-logging 域，最多三份。

`.190` 没有可用 hci 适配器，厂商蓝牙固件初始化持续超时，且 AINVR 当前不使用蓝牙。本次显式使用 `--disable-unused-bluetooth` 停用该初始化服务，未修改 Wi-Fi。脚本会拒绝对已有 hci 适配器执行此操作；其他新板不要无条件禁用。若以后需要蓝牙，先验证硬件、固件及串口，再恢复该服务，不能称本次已修好蓝牙驱动。

验证日志时同时检查 `journalctl` 与 SSD 上实际文件。可用 `logger --socket /run/systemd/journal/syslog -t ainvr-health-fix 'SSD log verification'` 测试 rsyslog 路径，再核对文件内容；单看服务 active 不足以证明日志落盘。

### 18.4 Mongo 余量和诊断方式

原容器上限 768 MiB，体检曾观测到约 715 MiB；20:22 发生一次非正常重启，现存日志不足以确定根因。后续 serverStatus 的进程驻留约 480 MiB、WiredTiger 缓存约 173 MiB/256 MiB，说明容器统计不能直接等同于缓存超限。诊断 mongosh 和健康检查也消耗同一 cgroup 的内存。

本次保留 WiredTiger 0.25 GB 缓存，把 .190 Mongo 的 `mem_limit`、`memswap_limit` 都改为 **1g**，并用 `docker update --memory 1g --memory-swap 1g ainvr-mongo` 在线应用，没有因该调整重启数据库。系统 swap 仍为 0。不要在紧配额容器里并发启动多个诊断 shell；优先复用现有驱动做有限查询。新板应按业务峰值与诊断开销验证内存，而不是只看空库启动。

### 18.5 SRS 故障记录

SRS7 的大写 `[WARN]/[ERROR]` 曾被采集器仅匹配大小写混合格式的正则漏掉。现已兼容大小写，并记录 `hls_worker_exit` / `hls_storage_recovered`，只保留错误码和固定信号，继续去除 URL、密钥和视频数据。部署文件为 `/opt/ainvr/srs-observer.py`，更新后只重启 `ainvr-srs-observer`。日志容量仍有边界，不把“13 个进程健康”当作全部业务链路验收。

### 18.6 发布验收与边界

本次前端全量 208 个测试文件、1578 项通过，类型检查及生产构建通过；录像服务针对定位、保护、鉴权、配额和索引异常的 43 项测试通过，SRS observer 19 项通过，git diff --check 通过。测试日志与构建位于 SSD `/mnt/ainvr-ssd/health-fix-20261105/`，不随源码提交。

内置浏览器在已登录的 .190 控制台验证新版页面：20:39:09 片段成功解码为 1920×1080，点击进度条后定位到 20:39:42，随后视频继续前进；切换到 20:40:15 片段正常播放，播放器与时间轴均显示 20:40:32，识别框恢复显示，无播放错误。页面保留旧资源支持已打开的标签页，入口 index 原子替换；前端回滚包位于 SSD web 域，最多保留三份。

20:50 复查：无 failed systemd 单元；PG、Mongo healthy，告警 livez/readyz 为 200；HLS tmpfs 114/384 MiB，SRS 重建后约 14 分钟无 FileWrite、StreamBusy 或 HLS worker 恢复重启；rsyslog 修复后无警告，系统可用内存约 1.5 GiB。Mongo restart_count=1 是 20:22 已发生的历史重启，调整后未新增，不能把此值写成 0。

以上不等于长期或任意多路压力保证。本轮没有人为填满生产磁盘、删除录像或重启整板；异常清理依赖针对性测试，冷启动需独立窗口。当前未配置现场告警规则，不能把服务健康等同于群组触发或大模型准确率验收。画面原有烧录时间来自测试源，回放轴使用录入系统的录像时间，二者不应混为一项指标。


### 18.7 生产 S100 构建与二期审核部署补记（2026-11-05）

启用真实告警及 2B 复核后，不能根据空闲时构建成功推定生产板仍有构建余量。本次 tsc 在业务运行中触发宿主机 OOM，被终止（21:51，node-MainThread）；后续不在带业务的 12GB S100 上运行前端重型构建。改为开发电脑使用锁文件 npm ci、Node 26.13.0 执行 tsc/vite，再上传静态产物并校验，生产只运行服务。测试迁移到本机须保持仓库相对目录及共享 test/fixtures，不能把缺少夹具的失败写成代码失败或全绿。

独立 Mongo 测试也不要使用 192MiB 的小 tmpfs：Mongo7 的 journal/诊断数据可能使其启动即 FileStreamFailed 退出。本次改为 SSD 独立测试目录、127.0.0.1:27931、512MiB 容器上限及 0.25GB WT 缓存，串行测试后移除该临时容器。禁止测试写入生产库，禁止为跑测试重启生产 Mongo。

2B 的默认单目标双视图策略与实测边界见 docs/ALARM-AUTO-CONFIRM-20261026.md 最新章节。现场既有严格授权不会因拉取源码被静默放宽；经用户授权，用 deploy-package/configure-paired-review.mjs 先预览再 --apply，并重启告警服务加载新代码。脚本核对已加载模型哈希，不把这一现场得分门槛用于未经验证的其他模型。仍保留不确定结果及人工改判。


私有授权文件原子替换时须同时保留 uid、gid 和 mode（本板为 root:sunrise 0640），不能只设 chmod 640；发布后用服务实际用户验证可读性。configure-paired-review.mjs 已保留这些元数据，已有策略再次执行为无操作。权限错误期间只允许参考分析，不能绕过授权自动结案；修正后原未审核记录依据授权版本自动重审。


### 18.8 2026-11-06 单目标审核输入与生产构建限制

- 当前人员单目标路径见 `ALARM-AUTO-CONFIRM-20261026.md` 的 2026-11-06 节。`target-focus-v2` 必须由支持当前 `target-review-abc-v2-rule` 的 LLM 二进制、审核服务及授权共同部署。原模型包/权重不变，不能修改包内 task-template 来冒充原签名输入。
- 启用顺序：兼容 LLM 二进制 → 告警服务/前端 → `node deploy-package/configure-paired-review.mjs --focus` 预览 → `--focus --apply`。三类分别是人员、非人员、无法辨认；新分数不能套用旧二选一的语义。默认 0.95/0.99 人员门槛、双视图逐帧 0.99 非人员门槛，均不是校准概率。
- AI 输入只有真实布防区蓝色边界，不填充、不画目标框；人看的页面使用 12% 淡蓝填充，目标/轨迹可开关；出现类是否有区域取决于规则快照，不能按行为名称一律删除区域。布防坐标与目标框必须使用同一原始帧坐标系，区域不能画到裁图灰边上。
- `focus` 配置需显式授权且模型哈希匹配；脚本保留 root:sunrise、640 等原权限。旧部署无 focus 时保持旧策略，组合告警原约束不放宽。回滚需一起回滚 focus 授权与审核服务；旧 LLM 不能支持新 profile。
- S100 的约 4.4GB CPU 内存不适合在线编译大型 C++ 翻译单元。本轮 `-j1` 和内存/CPU 限制下仍观察到 AI watchdog 重启；后续不要边采集边做重型构建。优先专用同架构构建机；可在有明确余量的同 SDK ARM64 机器独立 SSD 临时目录构建，不能修改其正在运行的项目。
- 本轮工具链 GCC 11.4、Node 26.13、固定 FFmpeg 8.1.2；C++ 使用 `-O1 -DNDEBUG` 降低构建资源，BPU 图与权重不变。迁移构建除 llm-service/src、ai-service/platform 头文件，还要 shared/cpp、固定 tokenizers/运行库及链接清单；检查目标板动态库兼容性和产物哈希。前端在开发机执行类型检查、测试和构建。
- 真实 Mongo 门控测试使用一次性容器：仅 127.0.0.1:27931，SSD 数据目录，512MB 容器上限、WiredTiger 0.25GB；不用生产 27017，不用小 tmpfs journal。测试完停止并删除该容器。
- 历史告警只有用户明确授权才清理。使用 `/v1/events/purge`、`scope=all`、认证 actor 和稳定幂等键，不能直接 deleteMany 丢失删除屏障。保留验收样本和清理截止时间，再只统计新告警。通道、规则、录像、识别历史和其他统计不在清理范围。


### 18.9 规则证据审核发布实录与维护顺序（2026-11-06）

本轮只在 .190 的 SSD 构建和部署，未操作 .189。`target-review-abc-v2-rule`、`target-category-abc-v2-rule`、`rule-evidence-v4` 是当前组合。模型权重仍是原 2B；`spatial-review-abc-v1` 仅作单帧空间关系旁路验证，不参与确认/误报，不得因为接口可用就启用自动空间判断。

**暂停和恢复次序必须保护实时取证。** 维护前记录各服务 active 状态。先停 AI 输出，等待已有取证任务排空，再停 alarm/review-reference/LLM/search 等需要释放资源的服务；输入接入、SRS、录像、参数库和 Mongo 按实际依赖保留。恢复时先启动 LLM 并等 `/health.ready=true`，启动 alarm/review-reference 及取证依赖，再恢复原本运行的 AI 输出和搜索。不能在告警取证服务停止时先恢复 AI。本轮中途这样恢复过，形成数条只有规则事件、缺少实时关键帧的维护告警；保留原记录交给录像补证，不删除以美化审核率。当前仅 AI 输出通道启用录像，源输入通道没有启用录像；AI 停机形成输出录像空档是预期维护影响，不能声称输入录像始终可用。

同板编译仅在明确允许的测试维护窗口进行：构建 `out/build/llm-s100`，`TMPDIR` 指向 SSD 独立结果目录，单作业 `-j1`、`-O1 -DNDEBUG`、`MemoryMax=1800M`、`CPUQuota=150%`；先留足系统内存，不将限制参数当作在线构建安全保证。前端仍在开发机使用 Node 26.13.0、锁文件依赖执行类型检查、测试、Vite。临时 Mongo 27931 在恢复业务前移除，生产 Mongo 27017 不动。

LLM 启动后可能需要约 30 秒预热；systemd active 不等于模型 ready。授权脚本在 ready=false 时应明确提示等待，而非报告模型哈希不符。预览后 apply，检查模板、权重哈希及 root:sunrise 0640。升级兼容已知旧 focus 模板并保留更严格门槛；不接受未知模板、不改其他类别授权。静态资源先发布，index 原子替换；保留已有标签页引用的旧资源。源码、二进制、网页入口/资源哈希与实际 PID 放在发布记录。

验收分开记录：软件测试、真实 Mongo 门控测试、实际模型对照、新告警现场观察、系统健康。软件全绿不能代替视觉准确率。本轮完整前端 1583 项通过，最后 UI 收紧后的相关 38 项/类型检查/构建通过；告警完整 Mongo 门控运行 420 通过、64 跳过，追加规则冲突/空间范围回归 48 项通过；LLM 软件 7 项通过。详细结果见 `test/results/rule-review-20261106/`。待审核数不等于队列拥堵，需区别未完成调用、明确缺证、分类未达阈值与规则冲突。浏览器验证实际模型输入与历史规则，不把当前布防套用旧告警。


18.9 后续修正补记：当前决策版本升级为 `rule-evidence-v5`；旧 `target-review-abc-v1` 调用保留旧提示词字节，v2 不变。限定区域 appearance 在特写及扩大图中均保留区域。空间图存储标识必须沿用存储层返回元数据，兼容 Mongo 与 SSD 文件路径，不能硬编码。扩大补证仅在已有 paired_support 授权且逐帧强扩大证据、弱特写无明显冲突时启用，门槛审计见告警文档。运行测试必须注入测试授权，不能让测试读取真实授权改变预期。测试 Mongo 用 loopback 27931，与生产库隔离；原生/临时数据仍在 SSD，先停 AI 再停取证，恢复时反向，保留历史告警。


## 2026-11-06：多通道共享 BPU 模型实例

### 运行契约

- AI 服务中的 YOLO 通用、YOLOFace/SCRFD、YOLOE、搜索视觉编码器通过 `BpuImageRunner` 使用 `BpuModel::Acquire`；YOLOE 的文本/RepRTA 和 GPEN 也使用相同入口。同一进程内，同一 HBM 文件内容 SHA-256 + program 参数共享一个 SDK 模型及输入输出张量。不同模型、不同版本、不同 program 仍分别加载。默认空 program 与显式 program 是不同键，调用方需保持一致。
- 加载时固定文件描述符并计算内容哈希，路径别名不会造成同内容重复加载；部署模型仍必须采用原子替换，禁止原地改写正在使用的模型文件。
- 注册表只保留弱引用。最后一个使用者退出后释放 SDK 资源；并发加载、释放与再次获取通过同一个 slot 串行协调，避免释放期间再加载第二份。
- 单模型按 FIFO 串行执行，锁覆盖输入复制、提交、等待、输出复制。各请求带自己的输入及输出副本；各通道仍保留自己的 GLES 线程上下文、预处理、跟踪、YOLOE 标签向量。既有每通道最多两个 future 的限制不变，未增加调度线程或无限积压队列。FIFO 按进入模型调用的顺序，不代表逐通道严格轮询。
- 模型共享不等于每路零内存开销。解码、帧缓存、编码、快照、跟踪与搜索采样仍随通道增长；吞吐受 BPU/GPU/VPU 总能力限制，配置帧率不是多路保证帧率。当前只验证双使用者硬件推理，不把它当作多路完整视频压力验收或最大通道数结论。
- Qwen 审核服务已有单 Engine 和有界队列，Qwen embedding 已有进程内 owner，本次沿用。进程间不共享 SDK 句柄；不同模型任务不能仅因名字相近就合并权重。
- BPU 超时/任务释放失败仍触发现有故障隔离与重启机制，不释放可能仍被 DMA 使用的缓冲，不使用 CPU 回退。

### 构建与验收

- 新依赖仅使用项目已依赖的 OpenSSL Crypto，`ainvr_bpu` 显式传播链接依赖。
- 编译、TMPDIR、探针产物全部位于 SSD。12GB S100 在业务运行时内存有限，先停止 AI 输入分析，再停止审核/LLM/搜索等相关负载；记录原状态，构建后恢复。保留数据库、接入和录像服务，维护期间 AI 输出存在计划停机间隙。
- 可复现软件测试：构建 `shared_runtime_test shared_bpu_test bpu_timeout_control_test`，执行 `ctest --test-dir out/build/ai-s100p -R 'shared_runtime|shared_bpu|bpu_custody' --output-on-failure`。
- 硬件探针构建目标 `bpu_shared_probe`，手动传入 HBM 路径执行。探针只使用合成测试输入，验证实例复用、并发输出一致性和最后引用释放；不验证识别准确率。应在停止相关模型业务的维护窗口顺序执行，不加入自动 CTest。
- 本轮 10 项软件/故障注入测试通过；包含 16 个并发获取者、100 次释放竞争、320 次不同输入输出隔离检查。真实 YOLO 通用、人脸、YOLOE、GPEN 的双使用者探针均通过，第二个使用者 ION 增量均为 0 字节。最后引用释放后仍可能有进程级 SDK 内存驻留，不能把 registry 为空等同于全进程 ION 为零。
- `/health` 的 `bpu.shared_runtime` 显示实例数、内容身份和引用数；引用数不是严格的通道数。加载期间快照不等待 SDK，可能暂时不显示正在加载的实例。单通道若同时启用搜索视觉模型，两个不同模型实例是正常现象。
- 发布前备份旧 AI 二进制到 SSD `ainvr-rollback/ai-service/<时间>/`，原子替换并校验哈希。观察 AI 归档、搜索写入、LLM ready、录像存储和服务重启次数；systemd active 或 search `/health` alive 不能独立证明业务功能完整。
- 本次证据位于 `test/results/shared-model-20261106/`（测试、探针、构建与健康记录，不纳入提交）；源码和测试未自动提交。此次部署目标为 .190，未操作 .189。


### 本轮额外发现（不能用探活掩盖）

部署观察发现搜索采样 `write_rejected_by_store` 增长，且部分采样成功入库。为排除本轮回归，曾短暂恢复发布前的旧 AI 二进制：运行 47 秒时同样记录 313 次拒绝、1 次成功提交；结果保存在 `health-baseline.json`。随后恢复共享模型版本并校验二进制哈希。该问题在旧版已存在，本轮尚未定位拒绝的具体子原因，也未声称修复；现有统计把准备失败等情况合并为该拒绝原因，不能直接断言 Mongo 或 HTTP 拒绝。需另行检查图片准备、采样有效期、描述符/请求契约等分支。启动阶段存在 dconf 无写权限提示及发布缓冲淘汰记录，不能当作运行期无告警的证据。


## 2026-11-06：配置驱动的模型驻留与安全释放

### 产品规则与所有权

在上一节共享实例的基础上，增加配置驻留引用。配置声明本身不加载普通 BPU 模型；首次实际使用后，配置引用保留实例，调用结束不卸载。取消最后一个配置引用，只撤销常驻引用，正在执行的任务继续持有资源，结束后才释放。普通 BPU 模型的构造函数已私有，所有调用必须使用 `Acquire`。当前仍以内容 SHA-256 + program 区分模型；同一模型的多个引用不等于多份权重。

- 通道 `enabled=true` 且不是 `deletion_pending` 声明检测模型需求；手动停止输入不等于删除已启用配置，已加载模型继续保留，禁用/删除通道才撤销。未启用的通道不声明需求。
- YOLOE 依据已有编译 sidecar 的 `dynamic_text` 展开文本与 RepRTA 依赖。组件首次使用后随配置保留，不再每次初始化通道都重新加载。坏的依赖 sidecar 单独计入诊断，不阻止其他已取消配置的模型释放。
- 启用截图增强时声明对应 GPEN/CodeFormer 需求；通道创建不预加载增强权重，首次真实增强时加载。增强注册表随配置撤销，不再永久持有模型；历史在途归档仍持有自己的任务引用。
- SigLIP 图像模型由 AI 服务的有效搜索采样授权拥有，文本模型由搜索服务当前配置 generation 拥有，分别使用不同计算图，不应合并。文本模型也已迁移到共享 BPU 入口。
- Qwen embedding 的图像和文本查询共同使用 AI 服务中的唯一 runtime。搜索服务使用每个 encoder 实例独有的 `lease_id` 保活；禁用/切换配置销毁 encoder 时立即释放自己的租约，旧实例不能释放新实例的租约。进程崩溃/通信丢失时以 90 秒租期加最多 5 秒回收周期兜底；正在执行的采样/查询引用仍优先保证安全。加载未完成时撤销需求，加载完成后不得继续保留常驻引用。不同模型切换等待旧 owner 退出，不同时加载两个大型 runtime。
- 审核 Qwen 沿用单 worker/Engine。`llm-service.enabled` 是显式配置的审核能力及预热需求，启用后预热并常驻，禁用后停止接收任务并在当前调用退出后卸载。本次没有把“暂时无告警”解释为取消配置，也不因空闲卸载。加载中允许禁用；模型包改变先清退旧工作、释放旧实例再加载新包。受配置中心管理时，不能在 `enabled=true` 下用临时 admin unload 绕过配置所有权；先禁用相应配置。独立测试模式仍允许 load/unload 验证。

这是一种进程所有者明确、按需求驻留的机制，不是跨进程共享 SDK 句柄。审核 Qwen 和 Qwen embedding 是不同权重/任务，不能因名称相似而合并。没有创建另一个调度服务或模型数据库。依然只在 BPU 推理，图像处理遵守原硬件路径。

### 运行与故障处理

AI 启动工作线程前登记当前模型需求；配置 SaveOverlay/ReplaceOverlay 在同一个提交锁内完成持久化与需求登记，成功后才向调用者返回。工作线程 Load 同样受锁保护，不能在持久化与登记之间启动新配置。后台每秒串行校准作恢复兜底，不依赖读取健康接口触发。登记失败时 Load 拒绝激活新配置，保留已持久化配置供后台重试；不能把 HTTP 保存失败理解为磁盘完全未变化。配置中心仍通过原有应用状态报告是否生效。`/health` 下 `bpu.shared_runtime.configured` 展示资源、配置所有者和是否已驻留；`models` 是当前实际实例，包括由其他有效任务所有者持有的搜索模型。`model_residency_failures` 记录配置需求同步/依赖错误。审核服务 `/health.residency` 展示预热需求和清退状态。不能只用实例数判断所有权，也不能将 ION 共享池全部占用归因于模型。

启用后尚未首用、取消后任务清退、进程退出后的 SDK 回收是不同阶段。模型/配置/文件损坏应报错，不能改用 CPU 或丢掉任务引用来强制释放 DMA。配置同步失败需要诊断，不能伪报全部已卸载。

### 新模型接入与验收要求

新增普通模型必须走 `BpuModel::Acquire`，在既有配置/sidecar 中声明依赖并由对应配置 owner 持有；不得新建静态永久强引用、按请求创建 Engine，或按通道复制大型模型。新模型包在其已有唯一所属服务中执行，其他服务复用既有接口。`test/ai_port/model_loading_contract.py` 在 CTest 中阻止新增原始 SDK 初始化入口；目前只允许普通 BPU loader、embedding BPU pack、审核 BPU program 三个经过所有权管理的入口。未来新增 loader 必须连同所有权设计与测试显式审核，不能声称一个扫描规则能证明任意未来代码正确。

验收覆盖：零配置不加载、首次使用一次加载、多使用者共享、取消一个不影响另一个、取消最后一个后等待在途任务、加载中撤销、配置版本切换、加载失败恢复、进程异常租约过期。硬件探针显式执行，不自动与业务争抢 BPU。`bpu_shared_probe <模型> configured` 验证配置保留及撤销后的真实卸载；`ainvr_llm_lifecycle_probe <模型包目录>` 使用真实 Service 配置/worker 路径验证审核模型生命周期，不修改生产参数库。

构建及证据目录：`test/results/model-lifecycle-20261106/`。AI、search、LLM 二进制应一起更新以启用配置租约释放；旧客户端仅超时保活，不能当作“立即释放”验收。编译与临时文件在 SSD，部署前保存各自二进制回滚包（每服务最多三份），恢复服务后验证采集/识别/录像/审核状态。本轮不自动提交 Git。上一节已记录的搜索采样拒绝属于独立问题，未因模型生命周期重构自动解决。


本轮最终验收：AI 生命周期/并发/故障/架构检查 13 项、搜索租约协议 1 项、LLM 软件 7 项均通过（合计 21 项）。四个真实 HBM 的配置常驻、双使用者输出隔离和撤销释放通过；第二个使用者 ION 增量仍为 0。真实审核 Service 的加载中取消、同模型配置重用及禁用卸载通过：ION 加载时 3,200,581,632 字节，取消/卸载后 73,728,000 字节（初始 56,360,960 字节；差额为进程 SDK 基础驻留）。这是模型生命周期验收，不等于识别准确率或最大并行视频通道数验收。


### 2026-11-06 配置同步与并发加载复审修正

- 配置观察者在 ConfigStore 提交锁内执行，不得重入 ConfigStore。管理 API、配置中心 Save/Replace 和后台校准共用这条路径，防止旧轮询快照覆盖新需求，以及 YOLOE 短生命周期组件在需求登记前加载又释放。外部直接编辑配置文件不属于即时生效接口，应通过配置中心操作。
- Qwen embedding 的前台 Acquire 与后台 Ensure 共用 Acquire 中的加载锁和包身份校验，等待锁之后再次检查需求与已有实例。已有其他包时返回 pending，等待旧使用者退出，不另外加载第二个大型包；撤销租约的后台加载不能保留常驻引用。
- 审核模型加载失败以最新配置版本收尾：新版本已禁用时释放硬件后提交该禁用版本，不能让旧版本失败留下永久 pending。配置仍启用且版本已变化时由 worker 继续处理新版本；当前版本失败仍报告 fault，不伪报 ready。禁用后即使资源仍在清退，health.ready 立即为 false。
- 普通 BPU 模型诊断增加每实例 active_calls、waiting_calls，前者为 0/1，后者为同模型 FIFO 排队数。这是瞬时快照，不是严格逐通道公平性或时延承诺；不同模型依旧使用 SDK 硬件调度，审核任务沿用既有有界队列和提交时间预算，没有另建全局无限队列。
- 回归测试覆盖保存/替换回调、保存与并发读取互斥、登记失败与校准恢复、不同包前后台竞态、旧加载失败与新禁用版本交错、诊断引用释放。软件故障测试 `ainvr_llm_lifecycle_probe --failure-state` 不分配模型；传入模型包路径的真实硬件测试仍须手动在维护窗口执行。

本次构建、测试与发布证据放在 `test/results/model-lifecycle-fix-20261106/`。沿用已有所有权、配置中心和调度机制，无新增技术栈。不自动提交 Git；已知搜索采样拒绝问题仍应独立跟踪，不能据本轮生命周期验收宣称全部业务无缺陷。


复审修正后的验收：AI 18 组 CTest、搜索 1 组、LLM 8 组全部通过，包含通道控制器及配置中心回归。控制器测试暴露采样库遗漏模型包校验库依赖，现已在库层 PUBLIC 链接，避免依赖主程序偶然补齐符号。首次新增校验测试误用了现有配置解析并不拒绝的端口值，已改为明确非法的流地址并重跑；原失败日志保留在结果目录。

真实硬件四个 HBM（通用 YOLO、人脸、YOLOE、GPEN）的配置常驻、并发输出隔离、撤销释放均通过，第二使用者 ION 增量均为 0 字节。Qwen 审核真实 Service 的加载中取消、同模型版本复用、禁用释放通过：加载时 ION 3,200,581,632 字节，取消和卸载后 73,728,000 字节。本结果仍不等于多通道视频容量或模型识别准确率验收。


### 2026-11-06 加载成功竞态与跨包租约补充修正

复审发现原 27 组测试未覆盖加载成功与再次启用的交错，也未覆盖不同 embedding 包的租约隔离；因此此前“可提交”判断撤回，需以下修正后重新验收。

- 审核 Service 独立记录实际加载的配置身份，Apply 比较实际权重的 package_id/package_root，不能只比较前后两份期望配置。模型加载成功后再次检查当前 enabled、配置版本与模型身份；已撤销或过期的结果标为 draining，先释放后重新应用，不能暴露 ready 或确认新配置已生效。卸载清除实际模型元数据。
- Qwen embedding 租约同时记录 owner、package_id 和到期时间，只有属于当前包且未过期的租约能保留该包。删除 B 的最后租约立即撤销 B 常驻引用，A 的失败或等待租约不再延迟 B 卸载；有效租约不能被复用成另一个包身份。崩溃仍由既有租期回收，活动请求持有的资源引用仍需等待任务退出。
- 前后台共享加载锁之外，embedding 使用唯一资源 slot，保证跨包切换也等待旧 SDK 析构结束，避免弱引用已过期但 ION 尚未释放时开始加载新包。查询同时核验请求包身份和模型版本。
- 新增 `llm_success_after_reconfigure` 软件测试，使用真实 Service 状态转移方法且不启动硬件 worker；覆盖旧加载成功、禁用后再启用、实际权重与期望配置不符、同模型复用。Qwen Host 测试增加跨包租约及 lease 身份复用的回归断言。

本轮结果位于 `test/results/model-races-20261106/`。只更新 AI 与 LLM 二进制，搜索协议未改；仍运行搜索租约兼容测试。既有搜索采样拒绝问题与本次两个竞态分别记录，未以探活代替业务验证。

本轮修正后的验收：AI 18 组、LLM 9 组、搜索租约协议 1 组，共 28 组 CTest 通过。真实 Qwen Service 加载中取消、同包复用、禁用卸载通过：ION 从加载时 3,200,581,632 字节回落至 73,728,000 字节。跨包竞态由真实 Host/Service 状态逻辑配合软件模型验证；本次未加载第二个实际 embedding 模型包，也不将软件测试称为多包硬件精度或容量验收。


### S100 / 7GB ION：板上构建的内存边界（2026-11-06 实测）

.190 的 Linux 可用物理内存约 4.4GB、无 swap。即使 Node 堆限制到 768MB，TypeScript 构建与推理、Mongo 同时运行仍可能触发整机 OOM；本次 14:02:36 Mongo 被系统终止并自动恢复，期间一条告警未取得完整图像。不能只看 BPU/ION 余量判断可否并行构建。

- 优先在独立构建环境生成前端产物。必须在板上构建时，先记录服务状态，暂停 AI、搜索和大模型推理，确认 Linux 内存余量；构建与测试串行，Vitest 使用 `--maxWorkers=1`。用退出清理流程恢复原先运行的服务；构建失败也必须恢复。
- 编译、依赖和日志仍放 SSD。`NODE_OPTIONS=--max-old-space-size=768` 仅限制 V8 堆，不是整机内存保护，不得用它代替暂停业务。
- 临时 Mongo 门控测试只监听本机专用端口，设置容器内存上限及有界临时盘，用完删除；不要与前端编译并行。
- 部署后检查内核 OOM、Docker restart count、Mongo ready、告警证据恢复队列及录像新增片段。进程恢复不等于故障期间每一帧都有留存；缺失的证据只能从具有精确身份的录像恢复，不能按附近时间猜图。
- 单帧检测告警使用帧内 detection ID，不是跟踪 ID。录像恢复通过显式 `observation_mode: detections`，同时核对通道、SEI 会话、PTS、生产者帧号及几何元数据；原跟踪恢复继续要求精确 track ID。缺少同一帧的生产者证明时保留人工，不伪造轨迹或恢复结果。


### 2026-11-06 告警原图可靠交付部署补充

- `AINVR_REVIEW_FRAME_ROOT` 必须位于已挂载 SSD；新增 `raw/` 存放待消费的原图、元数据、检查点 pin 和 ACK，不再把 `/dev/shm` 的几十秒缓存当可靠证据。
- 原图及元数据 fsync 后才发布 observation journal；消费检查点要求 Mongo journal 确认后才 ACK。清理只针对 ACK 超过 30 秒且无 pin 的图片，未 ACK 原图不能按 TTL 删除。
- SSD spool 上限 2 GiB。磁盘或保留库满时处理明确故障/背压，不能删除仍在保留期内的审核原图腾空间。需要监测缓存 failed、journal pending/failed、存储容量。
- 人工审核也需要原图，关闭 AI 审核不能关闭证据交付。
- 新规则使用有版本的持续风险去重；现有规则通过正式配置 API 保存升级，历史规则快照不重写。详见 `ALARM-INCIDENT-EVIDENCE-20261106.md`。
- .190 实测暂停消费者后约 99 秒的 5 张原图仍完整且哈希一致；恢复后积压清零。SSD 损坏/耗尽时仍不能承诺物理事件 100% 保存，必须报告失败。


### 2026-11-06：S100 低内存板编译与运行时修订

- .190 的 Linux 可用物理内存约 4.4 GiB（另有 ION 保留）。实测即使 `-j1` 并已停 AI、搜索、大模型、告警，生产 Mongo 和其余服务仍可能使 `reused_channel_worker.cpp` 编译被 OOM 杀掉；不能把“串行编译”当成充分保证。
- 所有构建目录、临时目录（`TMPDIR`）、日志、回滚产物放 SSD。先记录运行中的服务和容器；维护窗口内先停业务依赖，再停 Mongo/PG，确认可用内存。编译完先恢复数据库并等待健康检查就绪（不能只看 docker start 返回），再恢复原有服务，最后核对通道、录像、告警输入、审核队列和内核 OOM 日志。不要自动启动原本停用的服务。用户不能接受停机时，应使用匹配 SDK 的独立构建环境。
- 配置持久化与运行时登记状态分开：健康数据和配置读取增加 `runtime_configuration`。保存已经落盘但登记失败时返回 `configuration_saved_pending`（HTTP 503，`persisted:true`），不得按“未保存”重复创建；激活仍禁止使用未同步配置，配置中心可读取已持久化配置并再次校准。损坏的 overlay 明确报错，不再静默退回基础配置；需修复文件或通过经校验的完整替换恢复。
- 模型卸载改为有界后台回收，常规配置登记不等待 SDK 释放；同模型重新加载仍等待旧实例释放，退出时等待回收完成。极端连续变更超过 64 个待回收批次会施加背压，不能保证 SDK 永久卡死时配置调用无限畅通。保留每秒校准，以覆盖外部配置和模型依赖文件变更。
- 告警 `GET /v1/status` 新增 `evidence_sync`：进程启动以来 durableFile 操作尝试数、失败数、总耗时、最大耗时和互斥时延区间（≤1、1–5、5–20、20–100、>100 ms）。这是文件写入、fsync、rename 和目录 fsync 的整体操作耗时，不是单次 fsync 延迟或多通道容量证明。正常摄入去掉同一 pending 的第二次保护写入；崩溃恢复仍重新保护，证据持久化完成前不能 ACK。

- 真实 Mongo 集成测试应使用独立端口和随机测试库。大量创建索引的摄入/仓储套件会耗尽 256 MiB tmpfs；本次改用 SSD 专用临时目录后通过。测试结束停止并删除测试容器，核对目录归属后删除该专用目录，绝不能连接生产库清理。


### 2026-11-06：模型哈希缓存与依赖故障指标

- BPU 获取模型仍以内容 SHA256 和模型名称作为共享实例键；新增进程内最多 128 项 LRU 哈希缓存。每次打开文件，通过文件描述符读取设备号、inode、大小、纳秒级 mtime/ctime，身份不变且 ctime 已稳定至少两秒才复用摘要；近期变更或未来时间戳仍重新扫描，防止低精度时间戳导致邻近写入误命中。并发冷请求合并为一次扫描；身份变化重新计算，并在计算后再次校验。缓存不替代模型共享、SDK 串行执行或卸载互斥。
- 模型升级必须写临时文件、校验后原子替换，禁止边推理边覆盖原文件内容。文件元数据不是密码学完整性证明；本缓存针对受控本地文件系统，不能抵御能伪造元数据的恶意存储。
- AI `/health` 的 `bpu.shared_runtime.digest_cache` 展示 hits、misses、bytes_hashed，用于核对反复获取模型是否仍扫描整文件。冷扫描串行，避免多路初始化同时争抢 SSD；状态读取不等待哈希锁。
- 新增 `model_dependency_health`：state（healthy/degraded/unknown）、current_invalid_dependencies、check_failed、checks、failed_checks、incidents、recoveries。相同 sidecar 持续损坏只增加失败检查次数，不反复制造新故障；恢复后再次损坏才计为新故障。检查本身异常时保留最后已知依赖状态并标 unknown，不能当健康。
- 原 `model_residency_failures` 保留兼容，其累计值不是当前故障数量。告警应使用当前状态和持续时间；事件统计使用 incidents/recoveries。每秒配置与 sidecar 校准保留，不能仅因 overlay 未变化就跳过依赖检查或失败重试。

## 2026-11-06 .190 通道增长与 CPU 内存保护

本节仅适用于 S100 12GB、ION约7GB 的 .190；不得直接套用到 .189。Linux可见内存约4.31GiB，memory控制器为cgroup v1。

在 `/etc/systemd/system/ainvr-ai.service.d/30-memory-budget.conf` 配置：

```ini
[Service]
Environment=AINVR_AI_ACTIVE_CHANNELS=2
Environment=AINVR_AI_AU_TOTAL_MIB=192
Environment=AINVR_AI_AU_CHANNEL_MIB=96
MemoryAccounting=yes
```

在 `/etc/systemd/system/ainvr-recorder.service.d/30-memory-budget.conf` 配置：

```ini
[Service]
Environment=AINVR_RECORDER_BUFFER_MIB=256
MemoryAccounting=yes
```

执行 daemon-reload 并重启对应服务后，核对 AI `/health` 的 memory 字段，以及录像 `/v1/recorder/health` 的 memory 字段。活动名额含关闭输出的通道；手工停止只释放运行时资源，停用配置才释放启用承诺。源代码默认容量并非此板部署值，新板必须显式选择容量档。现有 SRS 768MiB容器、384MiB tmpfs、Mongo 1GiB继续保留。缓冲预算不包含全部RSS、GPU/驱动与子进程常驻，不可当作整机绝对内存上界；tmpfs不得与已包含它的容器用量重复相加。

构建目录、TMPDIR与回滚备份放SSD，C++用 `-j1`。4.31GiB可用物理内存的板子应先暂停业务及数据库，完成构建后启动PG/Mongo并等待探活成功，再恢复原来运行的服务清单。保留暂停清单，不要重复覆盖。部署前备份二进制、前端dist和既有drop-in。

测试注意：AuSpool软件测试要求SSD夹具父目录存在；录像跨语言SEI测试依赖 `test/results/locateanything-point-sei-fixtures-v1.json` 原始夹具。录像配额测试在SSD执行时必须记录真实mount identity；不能将整个录像套件移到不足5GB的tmpfs后误判为实现故障，更不能因此放宽生产低空间或换盘保护。

本次验收：C++五组通过、录像344项通过、运维助手89项通过、前端相关11项通过，TypeScript与生产构建通过；同源双AI通道运行、第三路409且不落配置、停止/重启/删除后额度归还均通过。17个服务恢复运行。只是短期同源双路验收，尚不构成4K/8K或24小时容量认证。内置浏览器因Work设置禁用，未完成视觉截图验收。

设计与边界见 `docs/CHANNEL-MEMORY-BUDGET.md`；可复核记录在 `test/results/channel-memory-20261106/`，回滚在 `/mnt/ainvr-ssd/ainvr-rollback/channel-memory/20261106-pre/`。未自动提交Git。


## 2026-11-06 配置应用中断恢复补充

若 SaveOverlay/ReplaceOverlay 已落盘，但模型需求登记抛异常，通道创建或更新的后续步骤可能未执行。因此 `runtime_configuration` 不得仅凭下一次模型登记成功就显示 applied。

现在该异常会设置本进程不可清除的 restart_required 标记：登记未恢复时为 pending；登记恢复后为 restarting，runtime_synchronized 仍为 false，禁止通过 Load 激活半应用配置。即使用户随后保存修正配置，标记也不清除；最新校验通过的配置仍会持久化。

后台检测到可恢复后，走原有 StopAll、服务停止和模型排空流程，以退出码75结束；部署必须保持 `Restart=on-failure`（.190已核对）。新进程读取最新落盘配置并重建通道，才恢复 applied。正常保存不触发整服务重启。此故障恢复会短暂中断AI分析输出；独立录像、SRS、数据库服务不随它重启。持久损坏的配置仍明确报错，不静默回退。

测试覆盖：新建配置登记失败、后台恢复仍禁止假报 applied、修正保存保留恢复标记、重建ConfigStore读取唯一新通道、更新后的名称和帧率在新实例生效。测试没有向在线服务注入模型登记异常，线上验证采用构建产物一致性、systemd恢复策略和正常业务探活。


## 2026-11-06 评审补充：回收屏障、退出测试和容量边界

- 通过BpuModel共享入口进行的新模型冷加载前，等待进程内已排队的异步回收，包括增强包装器与BPU驻留引用；等待超过5秒则拒绝该次冷加载，沿用通道退避重试，不能带着未释放的退役资源继续分配。缓存命中不经过该等待，不阻塞正在使用的同模型。健康数据 `bpu.shared_runtime.retiring_batches` 表示尚未完成的回收批次数。该屏障不卸载活跃任务持有的模型，不保证不同有效模型的总ION峰值自动适配硬件容量，也不跨服务协调LLM/搜索模型。
- `model_residency_failures` 改为依赖故障事件次数，与 `model_dependency_health.incidents` 一致；每次检查失败数仍读取 `failed_checks`。相同故障不再每秒冒充一次新事故。依赖和配置的周期检查暂保留，避免漏掉sidecar外部修改；未经完整的配置及依赖版本检测，不只看overlay的mtime跳过校准。
- 运行退出共用可测试的StopControlPlane：排空异常时仍尝试关闭监听，主线程继续既有清理。子进程测试核对调用顺序和退出75；排空失败返回1，正常停止返回0。此测试覆盖生产使用的退出辅助函数，不是对全部硬件SDK退出行为的无限时保证。
- `AINVR_AI_ACTIVE_CHANNELS` 单独按1到64的整数通道数解析，不再借用MiB参数解析器；非法值错误明确表示通道数。子进程测试覆盖0、65、负数、小数、空串、非数字及有效2。
- .189当前仍须单独确定容量档并显式配置 `AINVR_AI_ACTIVE_CHANNELS`、`AINVR_AI_AU_TOTAL_MIB`、`AINVR_AI_AU_CHANNEL_MIB` 与 `AINVR_RECORDER_BUFFER_MIB`。仅拉取源码不会更新二进制；本轮只编译测试，不部署，不复制.190的两路档到.189。应先核对实际systemd EnvironmentFile/drop-in及运行进程环境，再在相机开启时测8K实际码率、GOP、缓冲峰值、超限丢包及重连峰值。100Mbps×3秒约37.5MB，乘1.6约60MB只是估算，不含突发/GOP和其他CPU内存，不能作为路数认证。
- LocateAnything旧TRT分支的768MiB不是所有LocateAnything的统一需求。当前S100/S100P服务先校验可用适配器，未开放的模型应明确拒绝；BPU研究实现另有SSD帧保留契约。未来开放模型时必须同时完成适配器能力声明、模型清单、缓冲准入和真实硬件验收，不能只调大环境变量解除限制。
- cgroup版本应检查memory控制器挂载，不根据/sys/fs/cgroup根目录是tmpfs推断。当前两板memory为v1；不配置仅适用于v2的MemoryHigh作为保护依据。
- 不进行无压测依据的fsync批量化、不削减整帧截图预留、不放宽paired_support审核阈值。4K/8K多路和24小时稳定性仍为容量认证条件，软件测试不能代替。

- 配置恢复一旦启动，即使HTTP仍响应，也不再发送WATCHDOG=1；这防止SDK排空卡住时不断续健康心跳。部署必须配置WatchdogSec和Restart=on-failure；.190实查WatchdogSec=30s、TimeoutStopSec=30s。看门狗是故障兜底，不保证SDK本身一定能正常退出；被迫结束时仍依赖既有SSD持久交付恢复。

- 本轮最终验证：SSD串行编译AI服务成功；config_store、config_center、au_buffer、systemd_watchdog、shared_runtime、shared_bpu、configured_residency、model_loading_contract八组测试全部通过（0失败）。测试记录位于 test/results/runtime-followup-20261106/。本轮仅编译测试，维护结束恢复原服务，不替换部署二进制、不提交Git。


### 2026-11-07 推理性能与维护停机补充

.190 的审核证据已改为有界异步提交，观测日志等待真实持久化回执后才供告警消费；具体协议、实测与测试见 `S100P-INFERENCE-PIPELINE.md` 的 2026-11-07 节。不要以 `review_frame_offer` 接近零误判图片尚未保存：它现在只统计提交和容量背压，落盘完成延迟另看 cache completion 指标。

编译仍使用 SSD 的构建目录、TMPDIR 和临时 swap，单任务 `-j1`；业务恢复后关闭并清理临时 swap，不把交换空间当运行容量。若需要暂停 LLM，应一并暂停告警审核消费者（当前为 alarm-service），待 LLM `/health` ready 后再恢复，避免在模型停机期间耗尽告警重试次数。若维护已经造成 `review_unavailable`，只通过现有带审计的重试机制、按维护时间范围重入队；不得直接改确认/误报结论。恢复后检查新证据 failed/dropped、观测消费、录像可读性和实际 FPS，不只检查进程存活。


## 2026-11-08 补充：S100 多路部署与验收

- `.190` 为 S100 12 GB、ION 6 GiB，不可直接套用 S100P 的容量结论。
  多路测试结论、业务边界、恢复配置见 `docs/CHANNEL-STRESS-190-20261107.md`。
- 解码保持全帧和原始 PTS；在 NV12 拷贝前按检测目标的约两倍取样，降低主存复制开销。
  `source_fps` 表示完整解码吞吐，`delivered_fps` 表示送入采集线程的采样吞吐；
  `decoded_delivery.copy_skipped` 是主动省略像素复制，不是录像丢帧。
- 跟踪首次资格判定保留两秒窗口；已进入跟踪时使用五秒窗口抵抗短时调度抖动。
  2.95 FPS 门槛和超过一秒的源时间/处理时间断帧保护保持不变。仅看平均 FPS 不足以验收轨迹。
- 小内存板 MongoDB 不再用周期性 `mongosh` 探活；配置和挂载步骤见 `deploy/infra/README.md`。
  现场独立 Compose 副本必须同步脚本挂载，不应只更新仓库代码。
- 压测采样使用流式 JSONL、有限内存；禁止在板上反复展开全部历史 JSON。
  大样本分析在开发机进行，避免采样器本身消耗上百 MiB 并污染容量结果。
- 编译放 SSD，单线程并暂停 AI/搜索/大模型/告警后恢复；临时 swap 只放 SSD，完成后关闭并清理。
  新增 CMake 测试 `frame_copy_cadence`、`tracking_cadence` 在 Release 构建下也保留断言。
  媒体验收包含 H.264/H.265 B 帧原始压缩数据、显示 PTS、采样帧及真实 JPU JPEG。

- 八路检测约3 FPS、BPU平均91–93%已测到，但大模型并行时存在真实长间隔，不能据平均利用率认证连续轨迹。
  八路全部AI输出还触及内存安全线；关闭新增七路输出的测试不是八路完整业务容量认证。
- AINVR_BPU_TASK_PRIORITY默认0；128与254对照均未改善本次轨迹结果，不应作为推荐部署值。
  高优先级不等于模型可抢占，需编译FC分段并重新验证候选模型；本轮没有替换模型包。
- 压测应分别记录检测累计吞吐、单路长间隔、跟踪资格、内存最低值以及审核并发条件；详细结果见容量报告。

- 2026-11-08最终隔离测试：暂停LLM和告警消费者、只保留原通道视频输出时，8路各3.3003 FPS、BPU平均93.11%、采样跟踪资格100%，约5分钟短测通过。恢复全部业务后仍不能承诺同等轨迹稳定性；不得把停审成绩标作全业务容量。

## 2026-11-08 .189 部署与容量补充

实施时必须同时核对 Git 提交、systemd ExecStart/WorkingDirectory 和实际二进制哈希：拉取代码并不代表旧 release 已被替换。本次发现旧告警发布目录和不支持 target-focus-v2 的旧 LLM；升级后做实际协议调用验证。

观察队列、分析状态必须明确配置在 SSD，并设置 RequiresMountsFor。AI 与告警的 AINVR_OBSERVATION_SPOOL_ROOT 必须一致；AI 的 AINVR_ANALYTICS_STATE_ROOT 也应在 SSD。迁移应停生产者/消费者、校验文件后切换，保留回滚资料，不用符号链接规避服务路径校验。

复核上下文池和原始证据池分别受容量约束。出现 storage_busy 时先查实际池使用量、保留期、SSD 容量，再通过配置中心调整有界配额，不删证据或降低审核门槛掩盖问题。.189 本次复核池由默认 1 GiB 调至 2 GiB、保留 7 天，错误已清除。

识别历史可逐通道关闭 snapshot.enabled；不能因此停止承担告警与证据职责的 MongoDB。已配置模型和告警所需证据仍按各自机制运行。

容量须以实际 FPS、跟踪 active 比例及复核并发联合验收。当前 YOLO26x 在 .189 未达到 16×3 FPS，8 路轻负载结果也不能当作复核重负载保证。详见 [S100P 容量实测](S100P-16-CHANNEL-CAPACITY-189-20261108.md)。

### .189 二期：2 FPS与H.264解码筛选

- 前端、AI保存接口和后端能力目录的最低计划跟踪帧率统一为2 FPS；运行时仍须达到真实节奏要求。不能将UI可以保存2 FPS解释为任意路数下轨迹可靠。超过1秒的观测间隔保护继续保留。
- `AINVR_AI_REFERENCE_DECODE`默认0；.189通过 `98-reference-decode.conf` 显式设为1。它只在低采样率H.264路径筛选明确可丢弃的非参考画面，压缩旁路完整分发在筛选前执行。H.265、未知NAL/状态SEI、无DTS及高采样率保持完整解码。启用前用实际码流验证，不能假设所有摄像头都能减负。
- `decoded_delivery.non_reference_skipped`记录筛选数量；`source_fps`记录输入AU速率，不能再把它与解码量等同。关闭优化可将上述环境变量改为0，daemon-reload后重启AI；不要改动其他drop-in。
- 本轮16路约2.1 FPS、BPU平均92%–93%，但跟踪资格未满足每路98%的联合验收，14路留余量测试也未通过。不能设置为已认证生产容量。临时通道/容量/优先级参数已清理，LLM恢复原40%额度和30秒执行超时。
- 低额度试验中审核耗时可达31–47秒，若业务调用方超时未配套会导致重试；不要照搬试验的5%额度。保留原配置，通过真实检测+审核混合负载验证后再调整。
- 构建、回滚包和测试样本放SSD；复核模型不做未经验证的替换。最新二进制哈希、测试边界和可复查原始数据见 [S100P容量实测第二阶段](S100P-16-CHANNEL-CAPACITY-189-20261108.md#第二阶段2-fps-支持与解码优化2026-11-08最终记录)。


### 2026-11-08 低帧率跟踪实施补充

- 跟踪程序运行与采样质量分开检查：`tracking_capability.status=active`不保证轨迹/计数准确，必须同时检查`cadence`和`continuity_gap`。持续低速不得靠反复清空会话处理；真实间断必须进入告警观察协议，禁止跨缺失证据推断穿越。
- LLM逐SDK任务让出提交机会，同时保留窗口限额；额度包含SDK等待时间，不应写成硬件利用率。16路检测与偶发审核须联合测量；10%额度只是容量实验，日常配置已恢复40%，勿复制成所有硬件通用默认值。
- 16路测试须核对通道准入、编码内存预算、实际输入分辨率/编码、AI视频输出、录像与历史开关。此次只验证独立检测/跟踪和业务回放，不等同16路录像、截图归档及真实告警全链路认证。
- .189最后一轮结果和部署哈希见同目录`S100P-16-CHANNEL-CAPACITY-189-20261108.md`第三阶段；原始证据在SSD的`tracking16-work/`。不得把吞吐通过或单元测试通过改写为24小时/任意场景准确率验收。

- .189体检另发现测试前已存在的`rtw_8822ce` PCI超时；部署验收应同时查看内核设备日志，不能以systemd active代表整机硬件健康。该问题未通过本轮业务代码修复，禁止将它记录为已消除。


## 190 现场补充：BPU 空闲但通道低帧率（2026-11-08）

190 已同步到 `15d46de`。本次严重低帧率复现为审核原图保留池的 1 GiB / 30 天配额耗尽，`evidence_capacity` 使消费检查点停住，继而撑满 2 GiB SSD 交付池、阻塞 AI 证据队列。不能仅凭 Mongo 探活或 BPU 使用率判断业务健康。

部署时按实际图片体积、告警量和保留天数配置容量。本板通过现有配置中心发布 v12，将审核原图额度增至 8 GiB；30 天不变、原告警不删除。8 GiB 是本板容量档，不保证任意事件量的 30 天保留。需监测 `/v1/status` 中消费者 pending、failed、last_persisted_at 及证据容量，达到额度前处理；不应静默删除未过期告警引用的证据。

复现、发布哈希、测试与恢复后实测见 [190 部署记录](S100-190-DEPLOYMENT-20261108.md)。本次取用 .189 已提交但未推送的两笔更新，没有推送 GitHub。


### 2026-11-12 双板基线部署补充

- .190 开发仓 `/home/sunrise/ainvr` 是 SSD 工作树的挂载别名；.189 仓库在 eMMC，不能据源码位置推断构建产物也在 SSD。
- .189 原 `out/build/ai-s100p` 已移至 `/mnt/ainvr-ssd/ainvr-build/ai-s100p-baseline-20261112`，原路径保留符号链接以兼容 CMake 缓存中的绝对路径。部署前用 `readlink -f` 和 `df` 核对；新板直接在 SSD 配置 CMake。板上编译 `-j1`，资源不足时暂停 AI、搜索和 LLM，完成后恢复原服务。
- .189 告警服务使用 SSD 版本发布目录，不直接执行仓库源码。必须检查 `systemctl show ainvr-alarm -p ExecStart -p WorkingDirectory`，把已提交的 `alarm-service/src` 发布至新版本目录，并更新 `/etc/systemd/system/ainvr-alarm.service.d/99-current-runtime.conf`。保留原环境文件、观测数据目录和 ReadWritePaths；仅 git pull 不会更新运行中的告警代码。
- 参数库迁移沿用后端启动机制。车辆功能需要 028/029 迁移；发布前在 SSD 备份 PG，发布后核验参数表和历史名单表。测试数据库故障恢复使用独立临时 Mongo（例如仅绑定 127.0.0.1:27931），不得用生产 27017 执行清理测试。
- 车牌源尺寸与组合检测预算在保存和运行两侧校验。不能以 HBM 文件存在或服务 active 作为验收：需读取新帧、确认同帧结果与配置、检查实际帧率、跟踪状态和错误/重启记录。
- 备份统一 `/mnt/ainvr-ssd/ainvr-rollback/<服务>/<时间戳>`，每服务最多 3 份。前后端产物、AI 二进制、告警 systemd 配置和 PG 备份均应在发布前准备；二进制原子替换后核对 SHA256。

- 固定提交后再编译，编译期间禁止修改源文件。CMake/Make 按时间戳判定增量依赖；编译中途改源可能留下完成时间更晚、内容却较旧的目标文件。如发生这种情况，明确强制重编受影响单元并做真实 API 行为验证；仅比较“构建文件等于部署文件”的 SHA256 不能证明它对应最终源码。本轮曾因此漏掉组合模型参数修改需重建的分支，强制重编并通过浏览器接口验收后才进入提交。
