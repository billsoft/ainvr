# AINVR S100P 非 AI 模块移植

工作目录为 `/home/sunrise/ainvr`，硬件为 RDK S100P。参考子模块只读，已经移植的前端和基础设施保持独立。AI 微服务本身未复制或构建；控制台的 AI 接口及配置结构保留，等待后续接入。

## 模块

| 目录 | 内容 |
|---|---|
| `srs-web-console/backend` | 配置中心、认证、视频通道、录像代理、授权、系统操作接口 |
| `ingest-service` | RTSP 拉流和转发管理，FFmpeg 复制码流 |
| `recording-service` | 分段录像、索引、回放、SMB、本地存储和 SEI 提取 |
| `license-service` | C++20 授权服务，S100P 板卡序列号与 Ed25519 校验 |
| `relay-server` | 远程协助服务端代码及工具；部署目标是独立中继主机 |
| `shared` | 配置、授权客户端，主机观测、网络、重启和授权执行辅助服务 |
| `tools` | 授权申请及发行工具 |
| `deploy-package` | 发布、安装、审计工具及 S100P 专用构建入口 |

## 构建

先使用 `deploy-package/bootstrap-s100p.sh --check` 检查环境，再执行 `bash deploy-package/build-s100p.sh`。Python 服务使用项目独立 `.venv`，Node.js 使用 24.x，授权服务依赖 OpenSSL、yaml-cpp、nlohmann-json、cpp-httplib 和 GTest。构建不需要 CUDA、TensorRT、Jetson OpenCV 或 AI 环境。

系统 FFmpeg 4.4 用于已有兼容功能；RTSP 接入及 HEVC 读取使用独立 `/opt/ainvr/ffmpeg-8.1.2`，不会替换系统 FFmpeg。FFmpeg 第三方源码发布签名须通过官方公钥验证。

## 标识和权限

产品、版权、接口协议命名空间和服务名均采用 AINVR。录像 SEI 标识为 ASCII `AINVR-SEI-v1` 加 `00 00 00 01`，共 16 字节，与前端一致。机器身份及签名域、授权码前缀均使用 AINVR，原产品授权不可直接混用。

板端默认非特权账号为 `sunrise`。录像及主机辅助服务使用 root 处理存储挂载和系统操作，内部端口只监听本机并校验服务凭据。生产授权服务仍强制验证；发行私钥保留在发行端。安装工具生成设备凭据，无发行公钥时授权服务仍可启动管理流程、生成申请，但不接受任何授权码。

发行版本构建时通过 CMake 的 `AINVR_ISSUER_KEY_ID` 和 `AINVR_ISSUER_PUBLIC_KEY_HEX` 注入 AINVR 自有发行公钥。缺省构建不信任任何签发方，也不继承参考项目的公钥。测试使用合成签名凭据，不应将测试私钥或测试发行版本作为生产授权服务。

## 部署边界

现有 SRS、PostgreSQL、MongoDB 位于 `deploy/infra`，沿用已经验证的 host 网络配置。S100P 当前内核的 Docker bridge 限制仍存在，优先使用原生 systemd 管理后台及 Python 服务。网络辅助服务的测试使用模拟接口，不改变现有 Netplan、IP、网关和 DNS。

历史发布工具中的 AI、CUDA、Jetson 和模型打包分支只服务于旧平台，S100P 的非 AI 构建使用上面的专用入口。中继部署、SMB 实盘和关机操作需要各自实际环境，单元测试不能当作现场验证。

## 启动和访问

构建后执行 `sudo bash deploy-package/install-s100p.sh --start`。安装工具生成 7 个 `ainvr-*` systemd 服务，沿用现有三个基础设施容器。页面为 `http://192.168.100.189:8088/`，第一次进入由用户设置管理密码。内部服务地址为后台 3001、录像 8100、接入 8120、主机辅助 8299、重启及观测 8199、授权 8001；均监听回环地址。授权 IPC 位于 `/run/ainvr-license/license.sock`。

运行凭据保存在 `deploy/s100p/runtime` 的私有文件中，录像及业务状态保存在 `data`，这些目录不进入 Git。重新运行准备工具不替换已有凭据。签发端工具位于 `tools/license-keygen`，只在发行端生成、保存私钥；板端编译仅需要公钥：

```sh
cmake -S license-service -B out/build/s100p-license \
  -DAINVR_ISSUER_KEY_ID=<AINVR签发方ID> \
  -DAINVR_ISSUER_PUBLIC_KEY_HEX=<64位十六进制Ed25519公钥>
cmake --build out/build/s100p-license -j4
sudo systemctl restart ainvr-license
```

没有配置发行公钥及激活时，界面和诊断可以工作，生产接入、录像与播放仍受原有授权门控制。本次没有生成或激活正式授权，也没有启动 AI 微服务或授权执行器。中继服务端应部署在独立中继主机，当前只完成代码移植与测试。

SRS 配置以目录只读挂载进容器，后台在宿主机进行原子替换，SRS 通过 inotify 热加载。已实测自动 WebRTC candidate 保存及重载成功，RTC 代理透传浏览器访问的 Host。改变 IP 的操作未在本次执行。

## 2026-10-11 验证结果

| 范围 | 通过数 | 验证内容 |
|---|---:|---|
| 后台 | 337 | 认证、配置、授权门、代理、服务编排；含 30 项实际 PostgreSQL 迁移、存储及发布测试；TypeScript 构建通过 |
| 录像 | 284 | 实际 H.264／H.265 媒体、分段与帧数守恒、存储保护、回放与 SEI |
| 接入 | 6 | 拉流配置、地址校验、进程监督 |
| 公共与主机辅助 | 260 | 网络及系统管理、授权客户端、关机失败恢复、原生服务观测 |
| 中继 | 72 | 远程协助协议及服务端 |
| 签发工具 | 9 | AINVR 授权签发工具 |
| 授权 C++ | 66 | 签名、身份与状态保护；空公钥不允许激活 |
| 授权 Python | 5 | 凭据准备、实际双进程身份锁隔离 |
| 非 AI 发布 | 70 | 安装、打包及配置验证 |

共 1109 项通过；另有 5 项需显式启用独立 Docker 故障环境的测试未执行，包括反向代理信任、冻结／崩溃／磁盘写满及 HLS 故障隔离。AI 构建、模型打包测试在本次范围外。前端此前已完成构建与 786 项测试。

PostgreSQL 实测入口为 `.venv/bin/python test/non_ai/postgres_integration.py`，每次创建仅拥有临时测试库的独立角色，串行运行三个数据库测试组，最后清理本次测试角色和数据库。它不使用生产应用密码，不修改生产配置表。结果保存在 `test/results/non-ai-postgres/`。

复用脚本：`.venv/bin/python test/non_ai/live_pipeline.py`。它创建有界合成 RTSP 摄像头，调用实际接入复制进程和录像管线，经现有 SRS 分段为 MP4，逐段检查编码、数据包和完整解码，并导出参考帧。此组件测试不改控制台配置、不修改生产授权；结果和视频保存在 `test/results/non-ai-live/`。已实测 H.264、H.265 两种编码通过，SRS 挂载调整后也再次通过。640×320／15 fps 测试用于验证链路，不代表 4K／8K 性能测量。

本次构建、单元测试、源文件校验和部署结果位于 `test/results/non-ai-port-20261011/`。参考子模块保持原提交且工作树干净，AI 目录占位内容及既有前端源码保持原样。没有提交 Git。
