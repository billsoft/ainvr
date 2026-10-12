# AINVR：新生产板从零部署与升级

## 逐帧识别归档验收

- 归档开启后，每个有目标的推理帧逐目标保存；不支持按时间间隔抽样。旧文件中的非零 `snapshot.min_interval_ms` 加载后按 0 执行，新建/更新接口拒绝非零值。归档关闭仍为热更新，已接收任务继续收尾。
- 存储或处理跟不上时，本通道在开始下一帧推理前等待队列和截图额度。不会为了维持显示帧率而丢弃已识别结果。相机原始帧率与实际推理帧率是两个指标。
- 整帧截图预算为 384 MiB，各通道按输入尺寸保留两帧额度；额度不足会在推理前明确报错。已有通道不会因为其他通道占走保留额度而等待，但 GPU、CPU、磁盘仍共享。
- MongoDB 断开时使用有界本地暂存，暂存写入失败时保留任务并反压；慢写不会无限溢写同一块系统盘。处理失败只有成功保存隔离文件后才能移出待写批次。隔离文件不等于已入库，需修复处理原因后安排重放。
- 核对每通道 `archive_stats.delivery`：`accepted = committed + outstanding + quarantined + deleted`。这是本进程接收/载入的任务账目，不是历史库总条数；滚动删除不会减少累计写入确认。还应检查 `dropped_count`、`crop_failed_count`、`invalid_crop_count` 和 `quarantined_bytes`，不能仅以丢弃数为 0 判断完整性。
- 正常停机等待待写任务落盘；存储持续不可写时会记录 `shutdown waiting for pending persistence`。断电、强杀或 systemd 停止超时仍可能损失未持久化的内存任务，不能承诺硬件故障下绝对不丢。
- 新板验收同时检查两路推理、归档积压、录像缺口和磁盘余量。验收数据单独记录，机制说明见 `docs/archive-reliable-design.md`。

## 代理、网络与归档兼容性更新

- 网页修改已有管理密码必须验证当前密码；首次设置不要求旧密码，忘记密码走下方 sudo 重置工具。登录限速按可信 nginx 转发的真实客户端地址统计，直接访问后端伪造 `X-Real-IP` 无效。后端只信任通过 Docker DNS 查询到的 `frontend` 容器地址，不信任整个局域网。
- `configure-internal-network.py --install-monitor` 安装 `ainvr-internal-network.timer`，每约 30 秒重新发现控制台 Docker 网段，只有变化时原子更新白名单。AI、录像和两个助手每 5 秒热读取；手工 `docker compose down/up` 更换网络后通常 40 秒内恢复，无需为此重启业务。要立即同步可执行 `sudo python3 deploy-package/configure-internal-network.py`。首次升级必须包含 AI 和 Python 服务，旧程序不支持热读取；安装器保留旧版本兼容重启。
- 不写死全客户统一网段。分机部署在提供 AI/录像/助手的主机上，由 root 创建 `/etc/ainvr-ai-trusted-peers.json`，内容例如 `["192.168.100.182/32"]`，填写**实际 TCP 来源地址**，不是照抄示例。工具将这些地址与 Docker 网段合并；服务令牌/API Key 仍必需。远端主机没有控制台容器时，用 `--static-only --install-monitor`。禁止 `/0`；建议使用单个 IP，不开放整个局域网。该文件独立保留，不会被自动发现覆盖。
- 外层代理终止 HTTPS、内部 HTTP 的部署：在控制台 `.env` 设置 `TRUSTED_EDGE_PROXY_CIDRS=受控代理IP/32`（多个以逗号隔开），重建 frontend 容器。外层代理必须覆盖 `X-Forwarded-For` 与 `X-Forwarded-Proto`，保留外部 Host。内层 nginx 仅对明确可信来源采用这些信息，并覆盖发给后端的来源头；默认空列表，直连用户伪造 HTTPS 头不会生效。无需关闭来源校验；错误 CIDR 会阻止 nginx 启动。
- 归档统计新增 `pending_bytes`（待重试）和 `quarantined_bytes`（隔离证据）。两者合计受每通道 1 GiB 暂存上限约束，重启不重置隔离占用；清空历史对应的待重试任务在处理时按删除规则移除并扣减。`.bad` 不自动删除，排查完成后在停止该通道期间由维护人员归档/清理，重启通道重新统计。不能只扣计数而遗留无限增长的隔离文件。
- 启动配置和 overlay 的空 API Key 语义统一为“未启用 Key 校验”；生产仍必须供应非空 Key，来源白名单继续生效。录像显式加载共享白名单模块，不依赖其他模块先导入。

## 忘记 Web 管理密码：本地 sudo 重置

本工具只重置 Web 控制台管理密码，不修改 Linux/SSH 密码、设备授权、通道、录像或识别历史。没有 GM 万能密码。需要合法的设备 sudo 权限，以及可运行的新版控制台后端、参数库和原配置主密钥。

开发母版执行：

```bash
# 可先只读检查：不改密码、不重启
sudo python3 /home/sunrise/ainvr/deploy-package/reset-admin-password.py --check
# 交互重置：隐藏输入两次新密码，输入“重置管理密码”确认
sudo python3 /home/sunrise/ainvr/deploy-package/reset-admin-password.py
```

新生产板的发布包根目录也包含 `reset-admin-password.py`，在该目录用 `sudo python3 ./reset-admin-password.py` 运行。自定义后端容器名时追加 `--container 容器名`。

密码长度 8–100，与网页校验一致；不通过参数、环境变量、文件或管道传入明文。工具复用后端的 scrypt、配置密钥加密和数据库事务，在参数库记录 `local-root-reset` 审计。不会清空密码，也不会生成或替换配置主密钥。完成后只重启控制台后端，使所有旧登录会话及媒体凭据失效；网页短暂不可用，请重新登录。AI、录像、SRS、数据库和授权服务不重启。

重置过程中如超时，数据库可能已提交；工具会尝试重启后端使旧会话失效，并明确报告未确认结果。先检查后端和参数库状态，再重试；不要删除数据库、配置主密钥或授权状态。若工具报告后端重启失败，可执行 `sudo docker restart ainvr-backend` 后尝试用新密码登录。仅准备/检查工具不等于已执行实际密码重置。

## 管理与归档加固升级检查

- 首次打开控制台必须设置至少 8 个字符的管理密码；未设置时只允许初始化密码和公开状态接口。未激活也能设置密码、登录并进入授权管理，恢复链路保持可用。已有密码无需重设，旧摘要自动升级为加盐 scrypt 校验记录。
- 浏览器使用随机会话，有效期 12 小时；注销、改密码或后端重启后重新登录。录像媒体使用独立 HttpOnly Cookie，不再接受 URL 中的 `token`。跨站管理请求被拒绝。首次设置应在受控网络完成，远程接入使用 HTTPS/VPN。
- AI、录像、系统助手只接受 loopback、实际控制台 Docker 子网和显式配置的可信远端地址。安装器在创建容器后执行 `configure-internal-network.py --install-monitor`，生成 `/etc/ainvr-ai-internal-networks.json` 并启用自动更新。手工部署亦须执行此步骤。新版服务热读取策略；不要恢复整个 `172.16.0.0/12` 白名单。端口监听仍可为 `0.0.0.0`，来源限制检查真实 TCP 对端，不信任转发 IP 头。
- 激活前先校准系统时间。比注册码签发时间落后超过 5 分钟返回 `LICENSE_CLOCK_UNSYNCED`，不会消耗授权序号；校时后用原码重试。小幅允许误差以内以签发时间作为最早计时起点，内部单调计时仍从激活开始。已有授权的计时规则不变。
- 逐帧归档 `min_interval_ms=0` 保留。Mongo 暂时不可达时，独立暂存线程把已接收目标保存到该通道 pending 目录，释放共享帧预算；恢复后用原 ObjectId 幂等重放。正常运行暂存上限为每通道 1 GiB，保留磁盘可用空间 5 GiB；停机保存已接收任务不受该容量门槛限制。磁盘也故障或容量耗尽时仍会反压，不能同时承诺无限断库、有限存储与不丢图。
- 观察 `archive_stats.spooled_count`、`spool_blocked`、队列积压及 `pending spool blocked` 日志。出现不可编码任务会限次隔离并记录 CRITICAL，不应静默丢弃。关闭归档仍热生效，已接收任务继续收尾。
- 通道启动最多并行 2 路，持续失败按通道 4/8/16/32/60 秒退避；手动启动可立即重试。授权本地连接遇到资源短缺会退避重试，监听器不可恢复时进程失败退出由 systemd 拉起；观察 `uds_accept_error` 的 errno。
- 保留“授权暂时未知不主动停 SRS”策略，避免短暂故障误停业务。首次安装 SRS 由可信授权触发启动；这不等于对 root 管理员提供不可绕过的流媒体保护。主授权状态损坏仍走恢复码，不自动加载可能滞后的副本。

升级后核对：授权有效、四路录像持续产生、两路 AI 与归档连接正常、SRS 未被意外重启；浏览器完成密码设置/重新登录后再验收实时播放和回放。代码、构建和生产切换记录分别保存在维护日志，不能只用进程存活代替功能验收。

更新：2026-10-05。授权协议以 [当前设计](../../license-service-design.md) 为准；注册码采用 v3 签名，服务间信号仍为 v2。详细恢复和迁移规则见 [v3 设计](../license-v3-design.md)。

## 0. 先分清设备角色

| 角色 | 用途与约束 |
|---|---|
| 开发母版 `192.168.100.183` | `/home/sunrise/ainvr` 开发、Git、构建及隔离验证。**不加密、不重刷、不烧写熔丝，不因签入审查安装或重启服务。** |
| 受控工厂签发环境 | 保存单板供应材料、独立 v3 Ed25519 私钥和签发台账；私钥、注册机、台账不得随制品交付。 |
| 新生产板 | 干净系统、匹配运行库、单板供应、安装制品，并单独完成业务和平台安全验收。不能克隆母版 SSD 直接出厂。 |

本手册所有 `sudo` 安装、初始化、功耗和服务操作只用于选定的新生产板或明确维护窗口，不能在母版照抄执行。
本次完成的是源码和脚本审查、构建/隔离验证，不声称已完成新生产板实机部署。

## 流媒体接流隔离：独立 HLS 进程与内存盘（2026-10-03）

**原则**：接流线程中的同步磁盘操作可能阻塞其它协程。此前 HLS 迁入内存盘后曾连续 14 小时未断流，
这是改善证据，不代表所有断流均已定位。现在同一授权容器内运行两个独立 SRS 进程：主进程接流、WebRTC、HTTP；
HLS 进程仅监听回环 1936，负责分片。主进程通过协程转发、有界队列（沿用 `play.queue_length 10` 秒）给 HLS 送流。
HLS 停顿时只丢弃转发队列中的旧数据；进程退出由入口脚本单独拉起，不重启相机接入。
所有 HLS 输出仍写 `/run/srs-http` 内存盘，主进程通过原 8080 地址提供读取，前端降级播放无需换地址。
容器名仍为 `ainvr-srs`，授权停止容器时两进程一起停止。使用同一 SRS 7.0.162 镜像，无需编译 SRS。

### 新开发板上怎么创建、怎么设置

内存盘**不需要在宿主机上手工创建**，它是容器启动时由 Docker 挂载的 tmpfs，随 Compose 文件一起交付：

1. 交付并使用发布包里的以下文件（缺一不可，不能只热更新配置）：
   - `docker-compose.yml`：srs 服务里有 `tmpfs: - /run/srs-http:size=2g,mode=0755`；
   - `deploy/srs-conf/srs.conf`：本进程 HLS 关闭，转发到回环 1936，HTTP 根为 `/run/srs-http`；
   - `deploy/srs-conf/hls.conf`：独立 HLS 配置，禁止 RTC/API/HTTP/再转发，PID 文件独立；
   - `deploy/srs-entrypoint.sh`：启动前检查 `/run/srs-http` 必须是 tmpfs 且配置路径一致，否则**拒绝启动**
     （防止发布包缺挂载时悄悄退回写系统盘）；两份配置自检通过后启动进程及 HLS 自动恢复循环。
   - `deploy/srs-observer.py` 与 `deploy/ainvr-srs-observer.service`：安装为 `/opt/ainvr/srs-observer.py` 和系统服务。
2. 启动：`docker compose up -d`（只重建 SRS：`docker compose up -d --no-deps srs`，会短暂断流）。
3. 验收（都应通过）：
   ```bash
   docker exec ainvr-srs mount | grep srs-http          # 应是 tmpfs on /run/srs-http ... size=2097152k
   docker exec ainvr-srs df -hT /run/srs-http            # 类型 tmpfs，容量 2.0G
   docker exec ainvr-srs find /usr/local/srs/objs/nginx/html -name '*.ts' -o -name '*.m3u8'   # 应为空
   docker logs ainvr-srs | grep hls_capacity             # 每 5 分钟一条容量日志
   docker exec ainvr-srs cat /run/srs-ingest.pid /run/srs-hls.pid # 两个不同 PID
   systemctl is-active ainvr-srs-observer
   ```
   并确认相机发布会话不反复变化（`docker logs ainvr-srs | grep "token released"`）。
4. **容量设定**：2GB 是上限不是预分配，估算占用 ≈ 总码率(MB/s) × 约 45 秒 × 1.2，关键帧间隔长时还需余量。
   两路约 100Mbps 在分片滚动时已实测写满旧的 1GB 上限，因此提高为 2GB。新增高码率通道前必须重新核对峰值，
   并把它计入内存预算（tmpfs 占用的是内存，在 `free` 里算作 shared；AI、GOP 缓存、系统另需预算）。
5. **满了会怎样**：HLS 进程的 `hls_on_error disconnect` 只断开内部转发连接；主进程保留相机连接并自动重连 HLS。
   容量超过 80% 时 `hls_capacity` 日志进入 `pressure`；监测到 95% 以上或 HLS 写入失败后，空间回落至 80% 以下，单独重启 HLS 进程，
   清除写满后的封装状态并恢复生成。入口脚本不会删除正在播放的分片，也不会重启接流主进程。
6. 内存盘重启即清空，里面全是临时分片，不是数据，不需要备份。

### 其它

- SRS Docker 日志采用非阻塞 4MB 缓冲及 10MB × 3 轮转。缓冲满时允许丢日志，避免日志写盘背压拖住接流；
  授权决策日志仍由原授权服务记录。
- 更新这些配置需要在维护窗口重建 SRS 容器（会短暂断流），无需重启数据库和授权服务。
- 隔离集成测试：`SRS_IO_INTEGRATION=1 python3 srs-web-console/deploy/tests/test_srs_io_integration.py`
  （需要 Docker 和 `/opt/ainvr/ffmpeg-8.1.2`，使用不发布端口的独立容器，不碰生产）。
- 进程故障注入：`SRS_IO_INTEGRATION=1 python3 srs-web-console/deploy/tests/test_hls_process_isolation.py`。
  在临时容器暂停 HLS 超过队列时长、杀死 HLS、填满临时盘，验证源发布会话不变且 HLS 恢复。
- 现场日志：`journalctl -u ainvr-srs-observer -o cat`。每秒采样 API 延迟、源会话、主/子进程等待、内存换页、
  NVMe 与网络累计计数；异常记录前序样本、TCP 队列/重传、Wi-Fi 信号与重试、线程栈。
  若系统装有 tcpdump，还保留最近 TCP 连接标志/零窗口文本，不记录视频内容、不写 pcap。
  探针只读，不操作任何业务服务；API 延迟不是精确的 SRS 内部调度耗时，日志需与网络现场一起判断。
- 系统盘长时间卡顿仍会影响本地录像和授权主文件，这项隔离不等于修复 SSD。

### 母版上线验收记录（2026-10-03 14:53，非长期稳定性保证）

- 最终部署在 13:42 完成；13:44 起至本次检查，原始流与 AI 输出的发布会话均未变化，未新增发布、HLS 子进程重启或分片写入失败。
- 当前为两路约 100 Mbps 的 H.265 流。HLS 内存盘上限 **2 GiB**（不是预分配）；期间容量日志采样为 **53%–58%**，即时检查约 52%。
- 授权有效，AI、录像、SRS、诊断服务均运行；两路录像当前缓冲为 0，近一小时丢弃为 0，观察窗口内没有 `recording_drop`。
- **存储长延迟仍存在**：观察窗口有 23 条 `recording_pressure`，写入恢复日志记录的最长等待约 **12.8 秒**；当前缓冲吸收了等待，不能据此认定 SSD/文件系统问题已解决。
- `ainvr-srs-observer` 在该窗口没有记录新的 API 超时、慢响应或发布会话变化事故。继续增加通道前应重新核对内存盘峰值、录像积压及网络带宽，不能仅按 SSD 标称顺序写入速度估算。

## 授权预算参数（2026-10-02）

授权租约只能用到"已确认落盘"的预算，落盘是异步的；预算参数集中在 `license-service/src/license_budget.hpp`：

| 参数 | 值 | 含义 |
|---|---|---|
| `kMaxLeaseSec` | 30 | 单个租约最长时长（客户端协议上限也是 30 秒） |
| `kBudgetAheadSec` | 60 | 已落盘预算剩余不足 30+60 秒就发起续期 |
| `kBudgetReservationSec` | 180 | 每次续期预留的预算，必须大于 30+60 |

- 系统盘卡顿时，授权主文件落盘实测最长 32.6 秒。原参数（60/10）只能扛 40 秒；现在从发起续期起，落盘卡住
  90 秒以内租约不会归零，续期频率也从约每 20 秒降到约每 90 秒。
- 代价：授权服务崩溃或断电时最多多扣 180 秒授权时间；按天计的授权可忽略，但分钟级的短测试授权要注意。
- 短租约被压短或续查失败时业务如何处理，见下一节"授权连续运行策略"（以激活截止时间为准，不再有 1 小时防抖）。
- 替换授权服务二进制必须"另处编译 → 停服务 → 替换 → 启动"，不能覆盖运行中的文件（客户端按 `/proc/<pid>/exe` 校验对端）。
- 诊断：授权服务日志（`journalctl -u ainvr-license`）里 `budget_commit`/`primary_write` 记录每次落盘耗时，
  `permission_evaluation` 记录租约被压短的原因；日志经独立线程写出，不会拖住授权请求。

## 授权连续运行策略（2026-10-02）

短租约是续查/持久化预算信号，不是激活码总有效期。授权服务签发
`authorization_ms`；AI、录像、SRS 执行器及控制台按请求发出时的内部计时
计算固定截止。连接失败、程序替换或授权落盘异常，只进入降级告警，不能
延长已验证截止，也不能在截止前停业务。明确签名的到期、注销、clock_error 或 recovery_required 立即清除截止并停止业务；storage_error 只告警。
授权服务不可达期间无法获知新的注销；最长继续到最近确认的激活截止。
这是产品明确选择的连续运行策略，不再采用 15 秒联系新鲜度或一小时防抖限制。

首次尚未得到可信授权时，AI/录像/控制台不放行新业务；执行器结果未知时
不操作已有 SRS。已验证的截止仍按包含休眠的内部时钟推进，不靠墙钟续期。
客户端重启后必须重新查询，不能凭磁盘上未签名的缓存恢复授权。
执行器仅恢复它自己因授权而停止的 SRS，使用 systemd StateDirectory
`/var/lib/ainvr-license-enforcer` 记录停止责任；不拉起手动停止的容器。

替换授权程序须使用隔离构建目录；停授权服务后原子替换，再立即启动并验证。
不得直接在运行路径编译链接。客户端允许旧运行映像的 `(deleted)` 后缀，
仍校验对端 UID、精确 systemd 服务身份及响应签名，不能取消这些检查。
更新执行器 unit 后执行 daemon-reload；数据库和控制台基础管理能力保持可用。

## 1. 硬件、系统与生产安全准备

确认具体模块 SKU、16GB 内存、载板、存储型号和厂商 BSP；不要仅凭“Orin Super”营销名称选择刷机配置。
使用匹配硬件的 JetPack 6.2 / Jetson Linux R36.4.3。后续版本升级必须重新验证 TensorRT engine、CUDA/OpenCV 和运行库 ABI。

需要抵御拔盘的生产板，在受控刷机工位按 NVIDIA 官方流程制作设备绑定的加密 rootfs/数据分区，并使用自己的 OEM 密钥。
覆盖 `/etc`、授权状态、模型、应用、Docker/数据库数据根、供应目录、备份与敏感交换空间；解锁明文密钥不能留在同一 SSD 或未保护 initrd。
可信启动、关键应用/动态库/启动配置的完整性以及受验证更新链分别验收。Secure Boot 不自动验证所有应用文件。

刷机和熔丝操作需要准确 SKU、密钥保管、恢复方案和产线审批，本手册不提供可误用于母版的一键烧录命令。
参考：[NVIDIA R36.4.3 磁盘加密](https://docs.nvidia.com/jetson/archives/r36.4.3/DeveloperGuide/SD/Security/DiskEncryption.html)、[Secure Boot](https://docs.nvidia.com/jetson/archives/r36.4.3/DeveloperGuide/SD/Security/SecureBoot.html)。

初始化系统用户 `ainvr`；当前 systemd 身份、UDS 校验和运行库路径依赖该账号。设置独立运维凭据，记录该板资产编号。
首次部署在隔离维护网络操作，直到控制台登录口令、数据库用户和接口权限配置完成。

## 2. 准备运行环境

母版已核对的兼容基线：

| 项目 | 基线 |
|---|---|
| 架构 / 系统 | aarch64 / Ubuntu 22.04 / L4T R36.4.3 |
| GPU / CUDA / TensorRT | sm_87 / CUDA 12.6 / TensorRT 10.3.0.30 |
| OpenCV | CUDA 版 4.11.0，见下一节固定路径 |
| 授权服务库 | libcpp-httplib0 0.10.3、libyaml-cpp0.7、OpenSSL 3 |
| Python | 系统和 ainvr 都为 CPython 3.10；字节码 magic 必须一致 |
| 录像 Python 包 | fastapi 0.115.12、uvicorn 0.34.1、pydantic 2.11.3 |
| Compose | 母版为 2.40.3；需支持 `up --wait` |

构建阶段还需要 CMake、C++/CUDA 工具链、Node 和 Docker；业务源码只留在构建环境。生产 AI 直接使用 C++/TensorRT，不需要 PyTorch。

先取得经过批准的 aarch64 Miniconda 安装器及其官方公布的 SHA256，保存于新板受控目录。不要在生产脚本中下载不固定版本的 latest 并直接以 root 执行。

```bash
# 新板；RELEASE 是已解包的发布目录，具体名字由产线记录。
cd "$RELEASE"
bash bootstrap-jetson.sh --check
# 首次安装：下面两个变量由产线填入已经核对的文件路径和 SHA256。
sudo env CONDA_INSTALLER="$CONDA_INSTALLER" \
  CONDA_INSTALLER_SHA256="$CONDA_INSTALLER_SHA256" \
  bash bootstrap-jetson.sh --new-board
```

bootstrap 补齐系统运行库、ffmpeg、SMB、Docker/Compose 和 ainvr；保留 Docker 的已有 `data-root` 等设置，并备份修改前配置。
它不配置磁盘加密、可信启动或熔丝，也不替代运行库 `ldd` 验收。已有 ainvr 时可显式 `SKIP_CONDA=1`，但路径仍必须为 `/home/sunrise/ainvr/.venv/bin/python3`。
离线产线应预置批准的 apt/conda/pip 镜像或离线运行环境；`--with-thirdparty` 只解决 Docker 公共镜像，不代表 bootstrap 全离线。

功耗模式由具体模块、载板和散热验证决定，先查看 `nvpmodel -q` 及对应配置。脚本默认不改功耗、不锁频；只有显式 `--power-mode <已核对ID>` 才设置模式。不要假定模式 0 总是 MAXN_SUPER。
依据：[NVIDIA Orin 功耗模式](https://docs.nvidia.com/jetson/archives/r36.4.3/DeveloperGuide/SD/PlatformPowerAndPerformance/JetsonOrinNanoSeriesJetsonOrinNxSeriesAndJetsonAgxOrinSeries.html)。

## 3. OpenCV 运行库（首次必须准备）

当前 AI 二进制 RPATH 使用：

```text
/home/sunrise/opencv/opencv-4.11.0/build/lib
```

可以部署经过验证的同版本 aarch64 运行库镜像，必须包含其传递依赖；仅复制一个 `libopencv_core.so` 不够。
也可以在制作新板基础镜像时编译 OpenCV 依赖库。它属于基础运行库，业务应用仍从制品安装。

准备官方 OpenCV 和 opencv_contrib **4.11.0** 源码，分别放于 `/home/sunrise/opencv/opencv-4.11.0` 和 `/home/sunrise/opencv/opencv_contrib-4.11.0`，校验受控下载来源及文件哈希。

```bash
sudo apt install build-essential cmake pkg-config libgtk-3-dev \
  libavcodec-dev libavformat-dev libswscale-dev libv4l-dev libxvidcore-dev \
  libx264-dev libjpeg-dev libpng-dev libtiff-dev gfortran libtbb-dev \
  libdc1394-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libeigen3-dev
cmake -S /home/sunrise/opencv/opencv-4.11.0 \
  -B /home/sunrise/opencv/opencv-4.11.0/build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/home/sunrise/opencv/opencv-4.11.0/build \
  -DOPENCV_EXTRA_MODULES_PATH=/home/sunrise/opencv/opencv_contrib-4.11.0/modules \
  -DWITH_CUDA=ON -DCUDA_ARCH_BIN=8.7 -DCUDA_ARCH_PTX= \
  -DWITH_CUDNN=ON -DOPENCV_DNN_CUDA=OFF -DENABLE_FAST_MATH=ON \
  -DCUDA_FAST_MATH=ON -DWITH_CUBLAS=ON -DWITH_GSTREAMER=ON \
  -DWITH_FFMPEG=ON -DWITH_TBB=ON -DBUILD_TESTS=OFF \
  -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF \
  -DBUILD_opencv_python3=OFF -DBUILD_opencv_python2=OFF
cmake --build /home/sunrise/opencv/opencv-4.11.0/build -j2
```

发布前和新板安装前均检查下面两个二进制，任何 `not found` 都必须处理：

```bash
ldd "$RELEASE/ai-service/bin/ai_service"
ldd "$RELEASE/license-service/bin/license_service"
"$RELEASE/ai-service/bin/ai_service" --license-policy
```

最后一条应返回 `mandatory-v2-no-runtime-bypass`。该字符串只是兼容性检查，不是安全签名。

## 4. 构建和传输制品（母版/构建机）

构建不会在母版配置加密、熔丝或安装服务：

```bash
cd /home/sunrise/ainvr
bash deploy-package/build-release.sh --with-thirdparty
```

脚本默认从当前工作区重新构建前后端镜像、C++ 与 Python 制品，并执行发布检查。修改源码或部署文档后须重新出包；开发板上已部署的新镜像不会自动更新以前导出的发布压缩包。
`SKIP_BUILD=1` 只用于已明确核对缓存版本的工程操作，不能将任意旧镜像当成新版本生产制品。

AI 二进制固定在 `out/build/ai-service-release` 独立目录以 `RelWithDebInfo`、CUDA `sm_87` 构建；
打包不再使用或重链接正在运行的 `ai-service/build/ai_service`。首次使用新目录不能跳过构建。
包内 `ai-service/build-info.txt` 记录源码提交、已跟踪文件的修改状态、构建参数和二进制 SHA256。
替换母版服务前备份原二进制，使用同目录临时文件原子替换后重启 AI；不能把编译链接视为已部署。
开发板遗留的 `ai-service/build/CMakeCache.txt` 可能仍为 Debug。禁止在生产程序所在的
`ai-service/build` 执行 `make` 或 `cmake --build`，也不要把该目录重新配置成 Release 后继续使用；
更改构建类型不能防止链接器覆盖运行程序。开发、测试和发布都使用独立的 `out/build/<用途>` 目录。
CMake 会拒绝在 `ai-service/build` 配置，保留该目录的已部署程序与回滚备份。

### 本机录像维护与运行诊断

- 本机配额删除和目录扫描使用独立、单任务维护车道。短暂重叠时在原超时预算内等待；超时保留在途任务，不继续提交、不创建更多线程，也不把维护超时当成全局停录依据。迟到的删除结果由扫描对账。
- 本机单文件元数据探测超时只结束本轮扫描。空间不足、真实录像写入长时间无进展和本机探活持续失败仍会触发保护；NAS 保留原有熔断与重挂逻辑。
- `/v1/recorder/health` 的 `maintenanceIO` 暴露维护任务和等待时间。压力日志保留磁盘、脏页、索引和各路缓冲状态；进程明细每分钟最多一组，压力解除单独记日志。部分 Jetson 内核不提供 `/proc/PID/io`，此时明确标记不可用，仍独立尝试记录阻塞栈。`recording_pressure_cgroup` 按服务记录 cgroup v2 的分设备累计读写计数，可用相邻快照的差值计算写入量，同组多个进程不重复相加。
- 通道列表区分“当前写入积压”和“近一小时有缺口”；回放时间轴区分积压丢弃与停止录制时未保存，不能由历史告警直接判断当前仍在丢帧。
- 服务器持续负载可使用 NVIDIA `nvfancontrol` 已提供的 `cool` 配置，修改前备份 `/etc/nvfancontrol.conf`，确认设备确实定义了该配置，再修改 `FAN_DEFAULT_PROFILE` 并重启 `nvfancontrol`。记录温度、频率和吞吐对比，不以目标温度或帧率作为未经验证的保证。
- 保持逐帧归档、人脸增强和可靠 Mongo 写入。GPU 优先级、多实例及磁盘调度器调整需要分别测量；无收益的试验不写入生产默认配置。

AI 全景识别截图按采样映射选择下载区域，多个目标合并取图；普通截图或较大计划回退到复用的整帧缓冲。
画质仍使用原 CPU cubic 插值及 1.5 倍超采样。队列满时不会先下载图像，后台只接收独立截图。
运行诊断：AI 通道 timing 包含 `frame_map`、`frame_unmap`、`snapshot_offer`、`sei_stamp`；
归档日志 `snapshot_crop` 至多每分钟记录下载字节、下载耗时、总裁剪耗时与是否整帧回退。
这些是 CPU 墙钟计时，`snapshot_offer` 包含未触发归档时的快速返回，不能用它的平均值代替实际截图耗时。

全景投影 `erp_equirect` 的 `max_crop_dimension` 支持 **1–1280**，配置加载、新建、修改时统一校验；
普通投影仍要求正整数。升级前检查已有全景配置，超过 1280 的需明确降低，程序不会静默截小或接受后丢图。
当前生产值 640 不受影响。预算超限的内部防线仍保留，并有独立的限频告警。
归档 `dropped_count` 表示未成功归档的任务计数，须结合具体错误分类；可靠归档模式下队列满会反压，Mongo 暂时不可达会重试，不应清空队列；
`invalid_crop_count`、`crop_failed_count` 用于区分未保存原因；`queue_full_drop_count`、`budget_drop_count` 仅保留兼容字段并恒为 0，队列满会反压而非丢弃。
`crop_error_count` 是失败批次数。它们不等于 AI 通道卡片的推理跳帧计数。
正常裁剪统计与失败告警分别限频，正常日志不会压掉首次失败告警。

`snapshot_store_test` 中的 8K GPU 用例默认跳过；维护窗口停止生产 AI 后设置 `AI_SERVICE_GPU_TESTS=1`
运行像素正确性检查。如需重复性能测量，再设置 `AI_SERVICE_CROP_BENCHMARK=1`（预热 2 次、测量 10 次）。
这些开关只控制测试程序，不是生产程序的运行选项；其余 GPU/真实流集成测试也应避免与生产争用资源。

每个版本交付：

- `AINVR-release-<时间>.tar.gz`：镜像、C++、pyc、安装工具、当前设计、本文及 `release-manifest.json`。
- `models-<同次构建时间>.tar.gz`：在 `models-manifest.json` 中绑定文件名和 SHA256。
- 单板授权供应包：另行受控交付，绝不塞入业务包。

业务包内包含 `docs/h265-codec12-support-design-2026-09-29.md`，供离线新板查阅 H.265 设计边界及 §14 现场验收清单。

业务包和模型包放在同一父目录；解包业务包后，模型包位于其上一级。不要重命名模型包，也不要临时往业务目录添加文件。
前后端镜像名固定为 `srs-web-console-frontend:latest` / `srs-web-console-backend:latest`；发布 Compose 只有 image，不含 build。
发布清单检测传输错误和文件混入，不是数字签名；真实性由工厂受控分发/验证更新链保障。

公共镜像以 `deploy-package/thirdparty-images.txt` 为唯一清单：`ossrs/srs:7.0.162` 锁定镜像 ID，构建与安装后都按清单校验，不一致即中止。
H.265 摄像头的录像读端使用该 SRS 镜像自带的 FFmpeg 8.1.2（许可已获得），安装录像组件时自动提取到
`/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg` 并校验 SHA256（清单位于 `/opt/ainvr/ffmpeg-8.1.2/SHA256SUMS`）；不另行下载。离线新板请用 `--with-thirdparty` 出包，
否则 `install.sh`（含 `--only python`）会因拿不到 SRS 镜像而中止。设计见 `docs/h265-codec12-support-design-2026-09-29.md`。

```bash
# 新板：发布目录位于受保护存储；此命令只验证，不启动服务。
python3 "$RELEASE/audit_release.py" "$RELEASE"
```

## 5. 初始化新板业务凭据

默认 `LAYOUT=home`：应用根 `/home/sunrise/ainvr`，控制台目录 `/home/sunrise/ainvr/srs-web-console`。
`LAYOUT=opt`：AI/授权在 `/opt/ainvr-ai`，Python 在 `/opt/ainvr-python`，控制台在 `/opt/ainvr-console`。同一设备不要混用布局。
两种布局均固定 Compose 项目名 `srs-web-console`，避免产生另一套命名卷。

```bash
# 新板，只运行一次。
sudo python3 "$RELEASE/init_board_config.py" --new-board --layout home
```

WebRTC 播放地址无需在安装时填写：默认按浏览器打开控制台的地址自动适配，有线、无线任一网卡、
之后改 IP 都无需设置。以名称（非 IP）访问控制台或经端口映射访问时，在「系统配置 → 流媒体配置 →
WebRTC 播放地址」选「指定地址」（下拉列出本机网口地址，也可手动输入），保存即生效。
旧手册中的 `--candidate-ip` 参数仍被接受但会被忽略。

初始化工具生成每板独立随机值，成对写入控制台 `.env` 和四个宿主环境文件，0600，不输出密钥：

| 宿主环境文件 | 与控制台同值的字段 |
|---|---|
| `/etc/ainvr-ai/service.env` | CONFIG_SERVICE_TOKEN_AI_SERVICE |
| `/etc/ainvr-recorder/service.env` | CONFIG_SERVICE_TOKEN_RECORDER |
| `/etc/ainvr-ai/os-helper.env` | OS_HELPER_TOKEN |
| `/etc/ainvr-ai/restart-helper.env` | RESTART_HELPER_TOKEN |

发现任一文件已存在就拒绝初始化。不要删除现有配置再运行来“换密码”；中途故障保留已生成内容，按受控维护流程补齐。
PostgreSQL 密码、控制台登录口令、服务令牌和授权密钥是不同概念。
授权凭据由下一节工厂供应，不是本工具生成。

## 6. 授权部署与日常使用（v3 完整流程）

### 6.1 先分清三类材料和操作地点

| 材料 | 存放地点 | 用途与约束 |
|---|---|---|
| Ed25519 签发私钥、`public.json`、`issued-v3.sqlite3` | 发行方电脑的受控私有目录 | 签发正常/恢复/迁移凭据；绝不传到设备、Git、镜像或发布包 |
| `trusted_keys.hpp` 的公钥和编号 | 源码及编译后的授权 C++ 程序 | 只验证签名，可以公开；必须与签发私钥配套 |
| 每板供应配置及四个消费者 env | 工厂供应目录 → 设备 `/etc/ainvr-license` | 本地状态认证、管理接口、服务间挑战；不是 v3 注册码签发私钥 |

设备短机器码保持不变，但**不能只凭短机器码签发**。正常/恢复操作均从“系统配置 → 授权管理”复制完整申请，前缀 `AINVR-REQ3-`。注册密钥前缀为 `AINVR-LIC3-`。

服务间信号和状态 MAC 中的 `v2` 域仍在使用，不要批量替换为 v3。AI 的 `mandatory-v2-no-runtime-bypass` 与授权程序的 `mandatory-v3-ed25519` 分别检查消费者门控和注册码策略，不是版本冲突。

### 6.2 签发电脑初始化与保管

Python 需安装 `cryptography`。默认私有目录为当前用户目录下 `.ainvr-license-issuer/v3`；可用 `--private-dir <绝对路径>` 指定受控目录。目录权限仅授予签发人员，备份同样受控。

**已有签发材料时不要初始化，也不要每台新板生成一套新签发私钥。** 只有首次建立发行方信任根、尚未发布产品时才执行：

```bash
python tools/license-keygen/issuer_v3.py --init-key \
  --export-header license-service/src/trusted_keys.hpp
```

公钥确定后再构建发行包。已有私钥但需要恢复公钥头文件时只使用 `--export-header`，不用 `--init-key`；核对公钥编号后构建。已有客户机需要更换发行方私钥时应单独设计公钥兼容升级，不能直接覆盖旧公钥。

当前签发电脑已经完成初始化，独立注册机和说明在 `C:\Users\bills\.ainvr-license-issuer\v3\`。Windows 使用示例（在该目录打开 PowerShell）：

```powershell
& C:/Users/bills/miniconda3/python.exe -X utf8 ./issuer_v3.py `
  --request-file ./request.txt --minutes 259200 --output ./license.txt
```

备份整个私有目录，至少包含 `signing-private.pem`、`public.json`、`issued-v3.sqlite3`；停止签发后做一致备份。不要只恢复旧台账继续发码。私钥丢失无法继续以原公钥签发，台账丢失也不能凭客户提供的序号自动重置权益。

### 6.3 新板供应、安装和首次激活

1. **新板**读取短机器码，此时无需启动授权服务：

   ```bash
   "$RELEASE/license-service/bin/license_service" --machine-code
   "$RELEASE/license-service/bin/license_service" --license-policy
   ```

   第二条必须返回 `mandatory-v3-ed25519`。

2. **工厂签发环境**准备该板的状态/管理/消费者凭据。`$FACTORY_SECRETS` 是原单板供应材料目录，与 v3 签发私钥目录不同。只在首次建立供应材料时执行第一条：

   ```bash
   python3 tools/license-keygen/gen_material.py --secrets "$FACTORY_SECRETS" --init
   python3 tools/license-keygen/gen_material.py --secrets "$FACTORY_SECRETS" \
     --code "$MACHINE_CODE" --out "$BOARD_PROVISION"
   ```

   只将该板 `license-service.yaml` 和 ai-service/recorder/console-backend/enforcer 四个 env 安全传到新板。禁止传送工厂主密钥、注册机私钥、台账或开发仓库。

3. **新板**按第 7、8 节安装启动、配置业务。首次启动授权服务会创建随机安装标识。打开“系统配置 → 授权管理”，复制“完整授权申请”，带回签发电脑保存成 UTF-8 `request.txt`。

4. **签发电脑**核对设备、客户与购买时长，然后签发：

   ```bash
   python tools/license-keygen/keygen.py --request-file request.txt \
     --minutes 259200 --output license.txt
   ```

   可直接运行独立 `issuer_v3.py`，参数相同。`259200` 分钟为 **180 天**，不等于所有日历定义下的六个月。支持 1～5,256,000 分钟；应按合同明确分钟数。

5. **新板页面**粘贴 `license.txt` 全部内容，点击“核对注册码”，核对分钟数与替换提示后点击“确认激活授权”。状态应变为已授权，各消费者下一次查询后恢复。按第 9 节核对实际推理、录像、归档与播放，不能只看进程存活。

### 6.4 续期、重复操作和删除

- **续期**：重新复制设备当前的完整申请，再按新购买分钟数签发并录入。新授权从本次激活开始，**替换**原剩余时间，不自动叠加；需要保留旧剩余权益时由发行方先核对，再决定总分钟数。
- **重复签发**：相同申请、用途与分钟数返回台账中的同一个注册码；若需要新一次授权，先从设备取得更新后的申请。
- **重复激活当前码**：幂等查询，不重新计时。旧序号、其他设备/安装的码和旧 AES 格式被拒绝。
- **删除授权**：页面点击“删除注册密钥”，必须完整输入 `删除注册密钥` 才能确认。剩余时长作废，保留注销及防重放记录；AI、录像、流媒体业务停止，管理页、数据库、业务配置和已有录像保留。再次使用需新码。
- 不通过删除文件、清空数据库或 `docker compose down -v` 模拟注销。

### 6.5 状态丢失、损坏后的恢复

| 场景 | 处理 |
|---|---|
| 主状态完整，仅备份副本缺失 | 正常运行并补写副本，不重新签发 |
| 已授权安装的主状态缺失/损坏、状态全部删除 | 进入 `recovery_required`，显示新的恢复申请 |
| 安装登记损坏 | 留存损坏证据，创建新安装标识并要求恢复 |
| 安装登记和状态全部删除/重新装盘 | 新随机安装标识，旧码不匹配；发行方按原机器码台账人工核对，不自动赠送完整时长 |
| 普通读取/写入故障 | 先修复存储，保留文件，再重启授权服务复查；不能直接认定为篡改或重新激活 |
| `clock_error` | 核对真实时间和内部时钟错误并修复；不调时间续命，不用恢复码绕过检查 |

恢复步骤：

1. 保留状态目录、日志和配置，先处理磁盘/权限故障，不删除文件“修复”。
2. 设备仍要求恢复时，复制页面的“恢复授权申请”，保存为 `recovery-request.txt`。
3. 发行方按客户记录与签发台账核对**应补发的剩余分钟数**，明确使用 `--recover`：

   ```bash
   python tools/license-keygen/keygen.py --request-file recovery-request.txt \
     --minutes 12345 --recover --output recovery-license.txt
   ```

4. 在同一设备页面核对并激活。恢复成功后该挑战被消耗；下次丢状态会生成新挑战，旧恢复码不能再领一次时长。

完全离线且所有本地记录丢失时，无法自动准确重建已用时长。若重新安装后申请类型是普通激活，不加 `--recover`，但仍须人工核对旧权益。只持有短机器码、旧注册码或客户声称的剩余时间都不作为自动补发依据。

如果已经确认状态损坏/丢失，但恢复申请落盘失败，仍保持 `recovery_required`，原因中附带 `RECOVERY_CHALLENGE_WRITE_FAILED`。此时先修复存储再重启，不能把已确认的篡改降级成允许继续业务的普通存储告警，也不应误报为时钟错误。

#### 普通激活与恢复的文件交接

授权页支持文件交接：点击“下载申请文件”，把 `.txt` 文件交给发行方；发行方用 `issuer_v3.py --request-file ... --minutes ... --output license.lic` 签发。用户点击“导入注册码文件”选择返回的 `.lic` 或 `.txt`，再核对时长并确认激活。导入只读取文本，不自动激活；签名、机器和安装绑定仍由授权服务验证。支持 Windows UTF-8 BOM/换行，不接受多枚注册码、申请文件或超大文件。

恢复申请仍需发行方人工核对权益，并显式指定 `--recover`。下面的迁移票据只能用于部署，不能通过网页导入完成迁移。

### 6.6 已激活 v2 设备迁移到 v3

仅适用于**有有效 v2 主状态**的设备；已注销、损坏、v1 或无法证明旧权益的设备走人工恢复，不能强行转换。

1. 安排维护窗口，备份旧程序、配置和三份状态，记录激活起点、总秒数、已用量、授权编号/序号。新程序先在独立目录编译，不覆盖运行程序。
2. 在旧板只读导出权益元数据（不导出设备密钥），目录必须尚不存在：

   ```bash
   sudo python3 license-service/deploy/export_migration.py --out /受控目录/migration-request
   ```

3. 将 `request.txt`、`migration-record.json` 安全带到发行方电脑，人工核对原权益。`MINUTES` 必须等于原 `total_seconds / 60`，签发迁移票据：

   ```bash
   python tools/license-keygen/issuer_v3.py --request-file request.txt \
     --migration-record migration-record.json --minutes "$MINUTES" --output migration.lic
   ```

4. 仅传回 `migration.lic`。建议放 `/etc/ainvr-license/migration.lic`，root:ainvr、0640。在当前供应配置中添加绝对路径 `migration_file`，并显式补齐 `installation_path: /var/lib/ainvr-license-identity/identity.json`，保留原设备/消费者密钥。`/tmp`、`/var/tmp` 会受到 systemd PrivateTmp 隔离，不作为正式票据路径。
5. 用旧状态**副本**、独立端口/UDS/状态/安装登记目录运行新程序预演。确认 `valid`、激活起点/总时长/授权编号和序号相同、已用量不减，并能移除迁移配置后正常重启。禁止使用正式状态目录做删除重放测试。
6. 正式切换时仅停止需要更新的组件，原子替换授权程序，更新 systemd 的两个状态目录写权限，启动并重复上述核对。新包安装器要求供应配置存在迁移票据，普通 `--only license` 不能代替迁移预演。若安装器会刷新消费者，应提前安排录像/AI 中断窗口，保持数据库和管理面可用。
7. 确认主状态 `schema=3` 和安装登记持久化后，删除配置中的 `migration_file` 字段，把票据移入受控迁移档案。迁移凭据不能通过普通页面当作新授权使用。

迁移保留原计时，可能按既有启动规则保守扣除未使用的预留预算，绝不重新赠送完整六个月。旧二进制不理解 schema 3；不要只换回旧程序或旧状态降级。

### 6.7 持久目录、备份与诊断

- `/etc/ainvr-license`：单板凭据，不打印内容，不提交 Git。
- `/var/lib/ainvr-license`：主计时状态、两个异步副本及锁文件。
- `/var/lib/ainvr-license-identity`：独立安装登记；正常升级、备份、迁移均需保留。
- `/run/ainvr-license`：运行时 UDS，可由 systemd 创建，不作长期备份。

systemd 配置应包含 `StateDirectory=ainvr-license ainvr-license-identity`，写白名单包含两个状态目录；不要自改 `installation_path` 到未获写权限的路径。迁移票据仅一次性读取，完成迁移后应移除配置，避免日后路径失效阻止启动。

先采集不含密钥的诊断：

```bash
systemctl is-active ainvr-license ainvr-license-enforcer ai-service ainvr-recorder
curl --noproxy '*' --fail http://127.0.0.1:8001/api/v1/license/status
journalctl -u ainvr-license -u ainvr-license-enforcer --since '15 minutes ago' --no-pager
```

重点核对状态、原因、剩余秒数、授权序号、`enforcer_tripped` 及停止前计算参数。短租约归零不等于激活到期；已有可信授权的消费者在原截止前按现有策略容忍存储/联系故障。首次启动尚无可信授权的消费者不能凭故障继续业务。

备份在停止授权服务后获取一致的配置、两个状态目录和版本信息；恢复需人工核对当前权益，不能作为延长时长的手段。本方案不防 root 修改程序或本地信任记录、整盘回滚；不要求开发母版加密或烧写熔丝。

### 6.8 发布和验收约束

发行包排除注册机、私钥和签发台账，强制检查授权程序 `mandatory-v3-ed25519`。私钥初始化、公钥变更和发行包构建有先后顺序；不能在设备上初始化签发私钥。

测试分工：`license_tests` 覆盖 v3 签名、状态、计时和落盘故障；`integration_v3.py` 使用隔离状态、登记和端口，在电脑端签名，通过交换申请/注册码验证真实服务。已移除不能验收当前程序的 `integration_v2.py`；`migrate_v1.py --legacy-v2` 仅维护历史版本，不能给 v3 设备签发。

#### 启动安全检查与故障处理

- 所有配置必须显式填写 `installation_path`。标准供应包为 `/var/lib/ainvr-license-identity/identity.json`；临时服务和测试必须使用自己的绝对路径，状态、UDS、端口也须隔离。程序同时独占主状态和安装登记，第二个进程不能共用其中任意一项。
- 旧供应包缺此字段时，保留原有机器码及全部密钥，只补上述路径，再运行供应校验。不要重新生成设备密钥来“修复”校验错误。
- 迁移前先准备正确的签名迁移票据。程序在写安装登记之前验证 v2 主状态和票据的机器、授权 ID、序号、时长、起点及旧注册码摘要；缺票据或内容不匹配会直接退出，文件不变，补正后可重试。
- 登记认证失败且主状态也不能认证时，程序不移动、不覆盖登记。先排查供应配置是否拿错、设备密钥是否被改以及磁盘读写是否正常；两份都验证失败不等于已证明“密钥配错”。无法恢复可信材料时由发行方人工处理，禁止清空目录重新计时。
- 主状态能用当前设备密钥认证而登记损坏时，保留损坏登记副本，进入带新挑战的恢复流程。临时读盘错误只报存储故障，不持久化恢复挑战；修复存储后重启并复查状态。
- 完整授权申请读取最后一次持久化成功的登记快照。激活/注销落盘尚未完成时，申请接口仍可响应，但显示的是上一次确认的登记；操作成功后重新复制申请即可。
- 已注销且已持久化的 v3 状态不再每次启动重复写盘。v2 注销状态迁移仍需写入 v3 状态，保留防重放记录。

升级部署包时必须重新运行受控构建。源码和打包脚本更新不代表磁盘上旧 `.tar.gz` 自动更新，禁止把旧包作为 v3 出厂包。


## 7. 安装并启动新板

```bash
cd "$RELEASE"
sudo env LICENSE_PROVISION_DIR="$BOARD_PROVISION" LAYOUT=home bash install.sh
```

默认安装预检：发布文件集合/校验和、供应设备绑定及字段一致性、生产加密存储、控制台凭据、Python 字节码版本、指定模型归档。
不通过就先解决原因，不用修改检查脚本来掩盖问题。工程环境只有明确使用 `--development-host` 才跳过存储门槛，它仍强制授权且不能作为生产验收通过；本手册不会要求在母版执行安装。

安装结果：

- `ainvr-license.service`：C++ 授权进程，用户 ainvr，8001 回环端口及 UDS。
- `ainvr-license-enforcer.service`：独立 SRS 执行器。
- `ai-service.service`：实际 `bin/ai_service`；`ainvr-recorder.service`：ainvr Python。
- os-helper、restart-helper 和 fallback-provision.timer：必要维护服务。
- PostgreSQL/MongoDB 先启动并等待就绪，BFF/前端启动；新建 SRS 容器时安装器写入 `start-pending`，enforcer 在首次有效授权后启动一次并消费标记。普通升级不会重新登记启动意图，因此不覆盖管理员主动停服。

### 7.1 用户密码、录像身份及流媒体端口

录像服务必须配置独立的 `CONFIG_SERVICE_TOKEN_RECORDER`，与后端同名变量一致；不要再复制管理员密码哈希到录像 `console.token`。旧字段不再用于鉴权。用户录像访问由控制台实时校验，控制台暂不可用返回 503，不能按无密码放行。

浏览器使用播放专用 HttpOnly Cookie。更新后刷新页面即可为已有登录状态取得 Cookie；新播放地址不包含管理员 token。退出登录清除 Cookie，改密码后旧凭据不能发起新播放。已建立的 WebRTC/FLV 长连接不会因改密码自动断开。

对外浏览器使用 Web 入口的 `/media/`、`/live/`、`/rtc/`；1985、8080 仅绑定回环，`/srs/` 调试代理已关闭。旧的直接 8080 播放链接应换成 Web 入口地址。RTMP/SRT 摄像机协议仍属于受信任摄像机网络，必须网络隔离，不应宣称网页登录密码保护了所有 RTMP 客户端。详见 `docs/release-readiness-auth.md`。

授权配置 `/etc/ainvr-license`，计时状态 `/var/lib/ainvr-license`，独立安装登记 `/var/lib/ainvr-license-identity`，UDS `/run/ainvr-license/license.sock`。普通升级必须保留两个状态目录。
发行包不会带入构建机的真实 AI 配置；首次使用示例配置，升级保留目标板配置。
`--no-start` 只安装文件；旧服务可能仍运行旧代码，后续必须显式重启/重建消费者。

## 8. 首次数据库及业务配置

**PostgreSQL**：全新命名卷按 `.env` 密码初始化。升级时仅修改 `.env` 不会修改已存在角色的口令，需要显式轮换数据库并同步消费者。

**MongoDB**：以 `--auth` 运行。全新实例在容器 localhost exception 下创建第一个管理员；已存在用户时禁止重复初始化。
通过交互式 `passwordPrompt()` 输入强口令，不放在命令行或 shell 历史：

```bash
docker exec -it ainvr-mongo mongosh
```

在 mongosh 中：

```javascript
use admin
db.createUser({user: "factory_admin", pwd: passwordPrompt(), roles: [{role: "root", db: "admin"}]})
exit
```

再以管理员身份交互登录，创建最小业务用户：

```bash
docker exec -it ainvr-mongo mongosh --username factory_admin --authenticationDatabase admin
```

```javascript
use ai_snapshots
db.createUser({user: "ai_service_writer", pwd: passwordPrompt(), roles: [{role: "readWrite", db: "ai_snapshots"}]})
exit
```

在配置中心的数据库配置中保存对应连接串和 `authSource=ai_snapshots`，使用业务写入账号，不使用管理员账号。AI 是宿主机进程，本机 MongoDB 必须使用 `127.0.0.1:27017`；容器内 MongoDB 监听正常不代表开发板局域网 IP 可以访问。Compose 只发布回环端口，不为解决配置错误重新开放局域网访问。

已有板升级时必须检查实际生效配置：基础 YAML 会被 `ai-service/data/config_overlay.json` 覆盖，配置中心未声明的字段可能继续沿用旧覆盖值。将经过验证的完整连接保存到配置中心，让保存并应用流程校验、加密入库并重启 AI；保留账号、密码、数据库和连接选项，不仅修改 YAML。禁止将含凭据的连接串打印到日志或写入 Git。

**控制台**：首次无登录口令时可能允许访问，必须在隔离网络完成“配置中心”的登录口令设置再开放设备网络。
设置真实摄像头、模型路径、AI API 鉴权、SMB/NAS 和录像保留策略，校验与所选部署布局一致。
不要把示例摄像头/模型路径当作出厂有效配置。

**密钥备份**：BFF 的 `/app/data/keys/config-master.key` 位于控制台数据卷，用于解密 PostgreSQL 中敏感字段。与数据库一起受控备份；丢失或随意替换该文件会导致原密文无法解密。
三类持久卷分别是控制台配置密钥、PostgreSQL 数据、MongoDB 数据；授权计时和安装登记另存宿主 `/var/lib/ainvr-license` 与 `/var/lib/ainvr-license-identity`。禁止用 `docker compose down -v` 处理授权故障。

## 9. 注册和新板验收

先确认未激活时登录、授权页、配置中心、网络维护和 `/dashboard` 诊断可用，PG/MongoDB 保持运行，AI/录像拒绝业务。
在授权页面录入工厂注册码，核对预览时长和替换语义后确认。服务保存授权后，各消费者在下一次挑战获取许可，恢复不是全局瞬时同步。

```bash
systemctl is-active ainvr-license ainvr-license-enforcer ai-service ainvr-recorder
systemctl is-active ainvr-os-helper ainvr-restart-helper fallback-provision.timer
systemctl is-enabled ainvr-ingest && systemctl is-active ainvr-ingest   # 摄像头拉流（RTSP）服务
timedatectl show -p NTPSynchronized -p Timezone                            # 时间是否已同步，见“系统日期时间”一节
docker ps --format '{{.Names}} {{.Status}}'
curl --fail http://127.0.0.1:8001/healthz
curl --fail http://127.0.0.1:3001/api/health
curl --fail http://127.0.0.1:8000/health
python3 check-business-ready.py --require-archive --wait-seconds 90
# H.265 相关组件
(cd /opt/ainvr/ffmpeg-8.1.2 && sha256sum -c SHA256SUMS && bin/ffmpeg -hide_banner -version | sed -n '1p')
docker image inspect --format '{{.Id}}' ossrs/srs:7.0.162   # 与 thirdparty-images.txt 一致
curl -s http://127.0.0.1:8000/health | grep -o '"capabilities":{[^}]*}'   # 含 h265、codec12
```

新板逐项记录：

上面的验收脚本在源码目录中使用 `python3 deploy-package/check-business-ready.py`。应在激活、配置并启用至少一个归档通道后运行；未激活或未启用归档不能当作归档验收通过。`/health` 的 HTTP 200 和 `status=ok` 仅表示控制面存活；`business.ready=true` 且归档连接数量匹配才表示业务依赖就绪。最后必须在识别历史确认旧记录可查询、真实识别后最新时间和写入数量增加。断连时仪表盘应提示归档异常，历史统计应为“暂不可用”，不能把连接失败显示成真实的 0 条。

1. 申请码跨重启稳定、多板不同；设备/供应/工厂台账一致。
2. 首次激活、同码重复不补时、新码替换、旧码重放被拒绝。
3. 测试激活过期、注销、签名时钟异常/篡改状态使核心业务停止；授权服务离线、短租约归零及存储故障在原激活截止前只告警，截止到达后停止。管理和数据库仍可用，新有效授权可恢复。
4. 真实 GPU 推理、推流、录像、媒体读取、NAS/本地降级缓存、手动停通道意图保持。
5. 新板上做系统时间前后调整、重启和断电验收；不在母版更改时钟验证。断电后开机核对时间（无时钟电池的板子会回到上次保存的时间），离线现场按“系统日期时间”一节在页面校准。
6. 数据卷、配置密钥、授权状态和升级备份可恢复；供电/散热/功耗模式经重启核对。
7. 拔盘读取、换板解锁、篡改启动/关键应用以及可信更新符合产线安全要求。
8. 按现场实际使用的接入协议逐一验收，见“多协议摄像头接入”一节的新板验收步骤。
9. 接有 H.265 摄像头时：按设计文档 §14 验收（通道编码显示 H.265、AI 输出为 codec12、录像分段可回放、iPad/Chrome 实时画面与识别框；"关于"页可看本机与服务端 H.265 能力）。

没有可信外部时间/硬件单调状态时，全部关机时间和整盘快照回滚仍有设计边界，不得承诺纯软件绝对防绕过。

## 新板到手后必须调整的事项（2026-10-01 实测整理）

以下每条都来自开发主板的真实故障，不是通用建议。

1. **关闭桌面文件索引器**：`sudo deploy-package/harden-host.sh`（`bootstrap-jetson.sh --new-board` 会自动调用，`--check` 会核对）。只对 `ainvr` 用户的 `tracker-miner-fs-3` / `tracker-extract-3` 等用户级单元做 mask，可逆（`systemctl --user unmask`），不删文件、不改默认 target。历史原因是系统盘争用曾拖住同步落盘并导致短租约失权。当前已采用异步副本和独立的激活有效期判定；关闭无用索引仍可降低磁盘争用，但不能把旧失权机制描述成当前行为。
2. **不要在生产板上编译或跑集成测试**：大量磁盘与 CPU 占用会造成同样的系统盘停顿。在构建机编译，传输制品。
3. **绝不覆盖正在运行的授权服务/执行器二进制**：客户端校验 `/proc/<pid>/exe`；旧版曾因覆盖导致对端校验失败，现有客户端已兼容合法替换后的 `(deleted)` 标记，但这不允许把原地编译当作部署。正确顺序：另处编译 → 备份 → 停服务 → 原子替换 → 启动并验收。AI 和授权的 CMake 都拒绝在部署 build 目录配置。
4. **录像配额默认只有 10 GB**：8K 高码率约每小时数十 GB，按码率与保留时长重新设置，否则很快被滚动删除。
5. **验收前单独验证 NAS 写权限**：用 `ainvr` 身份在挂载点创建、写入、删除一个测试文件；QNAP 的回收站（`@Recycle`）会吞掉滚动删除导致写满，写保护/卷状态会让 Linux 客户端创建文件返回只读错误（EROFS），需要在 NAS 侧检查。录像服务有卷空间守卫，但不能代替 NAS 侧配置。
6. **8K/高码率相机优先走有线网络**：无线网卡会让推流反复断开重连。
7. **相机推流要求**：H.265 Main 8-bit、闭合 GOP、IDR 间隔 ≤ 2 s、无 B 帧；音频关闭或使用原始 AAC；按目标码率与通道数压测；早期高码率断流曾与 SRS 磁盘阻塞重合，不能据此认定当前 100 Mbps 相机必然不稳定。
8. **崩溃栈位置**：AI 服务致命信号的栈写入 `ai-service/logs/ai_service.log`（不在 journal 里）。
9. **授权状态备份**：升级前一致备份配置、计时状态和安装登记（例如 `/var/backups/ainvr-license-<时间>`）。schema 3 不可直接回滚旧程序；恢复必须核对已用权益，不能用旧快照重新计时。
10. **流媒体服务**：主进程与 HLS 进程分离，HLS 与静态文件在内存盘 `/run/srs-http`、日志非阻塞轮转；验证两份 PID、HLS 实际分片和诊断服务。主进程日志保留 info，HLS 进程为 warn。
11. **时钟电池**：开发主板实测断电后硬件时钟回到 1970 年（未装纽扣电池），开机只能靠上次保存的时间加联网对时。出厂前确认载板时钟电池已安装（官方 P3768 载板为 J3 接口，是否需补焊元件、电池型号以载板手册为准；客户自制载板按其设计）。未装电池的离线现场按“系统日期时间”一节处理。
12. **网络端口**：现场防火墙/交换机按实际使用的协议放行，见“多协议摄像头接入”一节的端口表。不要为排障开放 1985、8080、5432、27017 等仅回环使用的端口。

## 10. 升级、维护和故障处理

维护前备份目标板配置、三类数据卷、BFF 解密密钥、授权计时与安装登记两个目录和对应版本制品。保持台账完整。

```bash
# 新版本仍先传输完整匹配的业务包和模型包；完整升级：
sudo env LICENSE_PROVISION_DIR="$BOARD_PROVISION" LAYOUT=home bash install.sh
# 同协议版本的局部升级示例：
sudo bash install.sh --only console
sudo bash install.sh --only ai-service
sudo bash install.sh --only python
sudo env LICENSE_PROVISION_DIR="$BOARD_PROVISION" bash install.sh --only license
```

仅更新前端页面（例如新建通道的编码提示、窗口布局或关于页文案）不需要数据库迁移、授权重新供应或修改 systemd 单元。发布包仍须重新构建；目标板使用新包的 `--only console` 安装入口会更新控制台组件，随后刷新浏览器。不要用旧发布包覆盖已更新页面。

opt 布局的每次命令都需带同样的 `LAYOUT=opt`。局部升级不能替代第 6.6 节的 v2→v3 迁移；v1 设备需人工核对旧权益。
授权升级会刷新已有消费者和重建 BFF；AI 更新需要配套模型；Python 更新会把旧代码放到 `/var/lib/ainvr-deploy-backups/python-*`，保留运行数据。

| 现象 | 检查方向 |
|---|---|
| 生产存储检查失败 | 新板加密覆盖、Docker data-root、供应/备份目录、工厂材料残留；不是修改开关关闭授权 |
| ELF 无法启动 | ldd、httplib/OpenSSL/yaml/OpenCV/CUDA ABI 与固定 RPATH |
| 业务 503 | 授权服务、设备凭据、UDS 权限/实际 ainvr GID、租约和消费者日志 |
| 已激活但录像仍失权 | 授权进程必须是 ainvr，录像可为 root；不要删除 peer 检查 |
| 更新后仍是旧版本 | 完整重启/重建、实际 bin 路径、Python 备份与导入目录 |
| Compose 换布局后看不到数据 | 检查固定项目名和原命名卷，禁止重新初始化覆盖旧库 |
| PG/Mongo 被停止 | 当前授权设计不会停止它们，检查其它运维操作、异常或旧版本 enforcer |
| 配置中心 secret 无法解密 | 服务令牌两端一致、配置解密密钥及数据库备份配套 |
| state recovery_required / 旧协议状态 | 保留证据，通过工厂记录迁移/恢复，不删除状态或重置签发序号 |
| H.265 通道录像显示"缺少 H.265 组件" | `sudo bash install.sh --only python` 补装 FFmpeg 8.1.2（从 SRS 7 镜像提取）；离线板需带 `thirdparty.tar` 的发布包 |
| H.265 通道 AI 报"没有 IDR 关键帧"/录像 `no_idr`、`open_gop` | 相机需设为闭合 GOP、周期 IDR（≤ 2 s）；不是服务故障 |
| 浏览器无法播放 H.265 / 只能 HLS | 看画面上的原因与"关于"页本机能力：需浏览器有 H.265 硬解、SRS ≥ 7.0.33；通道需启用 HLS 才能兜底 |
| 页面提示“设备时间无效”，录像/AI 暂停 | 系统时间早于 2026 年（断电无时钟电池且未对时）。在“系统配置 → 日期和时间”校准，或指定局域网时间服务器；校准后自动恢复，不要重启授权服务或重新激活 |
| 新建 RTSP 通道提示“接入服务尚未就绪” | `systemctl is-active ainvr-ingest`、`/opt/ainvr/ffmpeg-8.1.2/bin/ffmpeg` 是否存在；控制台与拉流服务凭据由安装器成对生成，缺失时重跑 `sudo bash install.sh --only python` |
| RTSP 通道一直“等待视频” | `journalctl -u ainvr-ingest` 看重试次数；核对相机地址、账号、TCP/UDP（默认 TCP，UDP 需相机能回送 RTP）及设备到相机 554 端口是否可达 |
| SRT 推流连不上 | 现场是否放行 UDP 10080；相机须为“主动推送（caller）”模式，流标识按页面给出的完整格式填写 |
| WHIP 推流返回 401 | 发布凭据已轮换或撤销，重新生成后更新发送端；通道“启用输入”须为开 |
| 安全关机后设备没断电 | 仪表盘会显示失败步骤并已恢复原本在运行的服务；按提示原因处理后再关机 |

旧设备迁移和设备主密钥轮换见当前设计；安装器不会自动完成旧状态转换或无停机双密钥轮换。
安装过程不是全系统事务。失败保留日志和备份，在维护窗口恢复一致版本；不能只回滚旧授权文件来获取额外时长。

## AI 通道删除与识别历史清理

删除 AI 通道会停止识别和衍生推流，并删除该通道 MongoDB 集合 `snapshots_<通道ID>`（含历史记录、截图及索引）。原始接入通道和录像不受影响。界面要求输入通道名称确认；需要保留历史时使用停止通道。

后端先持久化 `deletion_pending`，停止识别并等待归档写入线程结束，再确认数据库集合删除成功，最后移除通道配置。数据库不可达或配置保存失败时保留“删除待完成”入口，禁止启动、编辑及开机自动运行，恢复后点击“重试删除”。重复清理已不存在的集合视为成功。不要手动删通道配置来掩盖清理失败，也不要在存在待删除通道时回滚到不识别该状态的旧 AI 二进制。

本改动需配套更新 AI 二进制和控制台前后端；正常完整出包会自动包含，不新增数据库迁移和 systemd 单元。旧版本已删除通道形成的孤立集合不自动清理，需核对归属后另行处理。

## OEM 品牌定制（产品名、版权与联系方式）

网页左上角主标题与副标题、左侧导航底部简称与版本、"关于"页（产品名、介绍、版权、联系人、电话）、浏览器标签页标题都来自目标板上的一个配置文件，**改配置即可，不需要重新编译或重启**：

```bash
# home 布局；opt 布局为 /opt/ainvr-console/deploy/branding/branding.yaml
sudo nano /home/sunrise/ainvr/srs-web-console/deploy/branding/branding.yaml
# 保存后刷新浏览器即生效
```

- 格式为每行"字段: 值"，模板内每个字段都有中文说明（product_name、subtitle、short_name、version_label、tagline、copyright_holder、copyright_start_year、contact_name、contact_phone）。
- **文件存在时以文件为准**：某字段留空或删除，页面上对应一项就不显示，不会回退成出厂品牌；删除整个文件恢复出厂默认品牌。
- `version_label` 留空显示软件真实版本；填写后按填写内容显示（售后排查以"关于"页之外的服务版本与日志为准）。
- 首次安装时放入出厂模板；**升级、重新安装不会覆盖已存在的 branding.yaml**，OEM 定制随设备保留。
- 字段写错（未知字段、年份非法、缺冒号）只忽略该行并在控制台后端日志记录 `[branding]` 警告，页面照常显示。

## 真实 H.265 相机序列头兼容（2026-09-30）

部分 codec12 相机的 hvcC 头字段与实际 SPS 不一致。AI 插件以实际 SPS 校验 Main / 8 bit / 4:2:0，并修正序列头后解码、推流；真实 Main10 等超出当前范围的码流仍明确拒绝。

升级需重新构建 ai-service 并重启其系统服务，同时重建并更新前端镜像；无新增依赖或配置迁移。离线部署包需使用此版本重新构建的 AI 二进制与前端镜像。

验收不能只看 SRS publish.active：AI 帧数、推理数与 SEI 注入数应增长，输出流的 video 应有编码和分辨率，浏览器应实际播放。已在生产母板验证 3840×1920 H.265 codec12 真实相机输入、AI 推理、SEI 输出和 WebRTC 播放。断流时页面显示具体输入错误、等待视频恢复，隐藏旧实时性能值。


## 开发母版运行期间的维护约束（2026-10-02）

### 发布包构建与系统盘

开发母版兼作生产录像机。发布包导出、压缩和编译曾造成录像写入积压；默认禁止在录像服务运行时执行完整构建。构建入口统一经过 `deploy-package/run-controlled-build.sh`。

- 内核支持块设备限速时，纯打包使用独立 systemd scope，主机读限速 40 MB/s、写限速 20 MB/s、低 CPU 优先级。
- 当前 Jetson 内核未启用 `CONFIG_BLK_DEV_THROTTLING`，虽然可见 io 控制器，但没有 `io.max`；不能将 systemd 接受限流参数视为限流生效。这类机器在录像期间连 `SKIP_BUILD=1` 打包也默认拒绝。
- Docker/BuildKit 的构建进程不属于上述 scope，完整镜像构建必须安排维护窗口或使用独立构建机。
- 维护窗口已安排、允许录像中断时，可显式运行 `AINVR_MAINTENANCE_BUILD=1 bash deploy-package/build-release.sh`；该变量表示操作员接受维护影响，不能提供缺失的内核限速。
- 全量部署安装 `60-ainvr-writeback.conf`：后台脏页阈值 64 MiB，写入者阈值 256 MiB，替代按内存百分比累计的大批量刷盘。该设置减少积压，不能保证 SSD 不再出现长延迟；仍须观察录像写入积压和授权主文件落盘耗时。
- 此次母版修改前的值保存在 `/var/backups/ainvr-ops-20261002/writeback-before.txt`。回退时先移走对应 sysctl 配置，再恢复文件中记录的原值；不要同时设置字节阈值与百分比阈值。

### 管理与消费者签名密钥轮换

`rotate-consumer-keys.py` 仅轮换管理 API 密钥及四个消费者的签名密钥，不更改设备解密密钥、申请码和已激活状态。先以 root 运行不带参数的校验，安排短暂维护后：

1. 停止授权执行器；保持 SRS 运行。
2. 运行 `python3 deploy-package/rotate-consumer-keys.py --apply`。
3. 重启授权服务、AI 和录像服务；按现有 Compose 项目强制重建 backend **容器**以加载新环境文件，无须重新编译镜像。
4. 启动执行器，验证四个消费者取得有效签名、后端授权为 valid、录像恢复，以及 SRS 启动时间没有变化。
5. 工具将旧配置备份到 root 专用、权限 0700 的 `/var/backups/ainvr-license-keys-*`，文件为 0600。回退必须协调恢复整组凭据再重启消费者，不能只恢复某一个 env 文件。备份仍含旧密钥，应按运维保留策略保管。

设备原对称密钥曾暴露，以上轮换不能使该密钥失效。v3 已将注册码签发能力迁至发行方 Ed25519 私钥，设备对称密钥不能签发新注册码；它仍保护本地状态，更换时必须重新认证现有状态并保留序号、已用时间和注销记录，禁止直接改配置值。旧 v2 工厂材料仅作为受控迁移档案保管，不能再作为新注册码签发入口，也不得复制到生产制品或提交 Git。v3 私钥和签发台账只存放于发行方电脑，需单独备份。

### NAS 与 TensorRT 警告

此次使用既有 `wanglei` 凭据、独立临时挂载点完成 SMB 3.1.1 的创建、fsync、回读、改名和删除验证，全部通过；未修改用户录像或切换当前本机存储。过去的只读故障不代表当前仍不可写；再出现时应重新对照服务端权限、挂载状态及实际写入结果。

TensorRT 10.3.0.30 在 Jetson 上存在同一设备生成引擎、重启后仍提示跨设备引擎的已知案例。[NVIDIA 官方讨论](https://forums.developer.nvidia.com/t/trt-engine-plan-file-across-devices-warning-after-reboot-on-jetson-orin-nano/376848)。单凭该警告不能认定引擎来自错误设备。保留警告；只有加载失败、输出异常、实测退化或硬件/运行库升级时，才在匹配目标板上重建并验证引擎，不在运行中的母版上仅为消除警告升级 JetPack。


### 识别历史归档开关验收

每通道 `snapshot.enabled` 为持久化热配置。关闭后拒绝新截图任务并唤醒等待中的提交；拉流、解码、推理、SEI、输出流和录像继续运行，不重启 AI 通道。已接收任务继续裁剪/投影、亮度校正、增强、JPEG 编码和 Mongo 写入，不能承诺数据库故障时几秒内收尾。历史查询和数据库连接保留；关闭期间不会补存。

开启后对每个有目标的推理帧逐帧归档；不允许非零采样间隔。首次模型加载在归档线程执行，但共享 GPU 和有界队列仍可能影响推理速度，不承诺完全不影响。持续写入期间条数可暂时超过配置上限；正常批次修剪，以及关闭或空闲时的尾批修剪，会恢复到上限。数据库故障期间不承诺严格数量上限，须结合归档错误和积压指标判断。

维护窗口验收：保存原开关状态，关闭小门归档，确认配置返回 hot、推流连接 ID 和 AI 进程不变、已接收任务清空后写入计数停止；再恢复原状态，确认写入增长。仅改变开关，不改变每帧保存、GPEN 或采样设置。


## AI 进程故障恢复配置

升级时必须同时替换 AI 二进制和服务单元，再执行 daemon-reload。服务通过本机 `/livez` 探针向 systemd 发送心跳，连续 180 秒无心跳才触发进程恢复；低帧率、归档反压和存储告警不作为强制重启条件。部署后检查 `systemctl show ai-service -p WatchdogUSec -p WatchdogTimestampMonotonic -p NRestarts`，间隔十秒检查心跳时间递增。完整边界见发布包 `docs/recovery-policy.md`。

## 多协议摄像头接入

完整安装包含 RTMP 1935/TCP、SRT 10080/UDP、WebRTC WHIP 和 RTSP 拉流。
接入管理中新建通道时选择输入协议；录像和 AI 按通道选择来源，不重复选择协议。
已有 RTMP 通道不需要迁移。H.265 RTMP 优先沿用 CodecID 12；本机 HEVC 未收到视频时，AI 重连可回退到本机 HTTP-FLV 读取，外部地址不自动改写。

- RTSP：填写视频地址、用户名、密码及 TCP/UDP。密码保存后不回显。通道设置异步应用，收到视频后才显示在线；连接失败按退避节奏恢复。关闭输入不会删除历史录像或识别历史。
- WHIP：创建发布凭据后复制地址及一次性显示的凭据给发送端。发送端须完成 ICE 收集后发送 SDP；本版不接受 PATCH trickle ICE。撤销、轮换、停用及删除确认旧发布会话停止后才完成，停止失败会返回失败。控制记录保存在加密参数库，重启后仍可撤销。
- SRT：使用页面给出的发布地址和流标识。当前监听与服务级加密属于部署配置；页面显示地址不是修改监听端口的入口。RTMP/SRT 首期仅用于可信局域网，未提供每通道发布鉴权。
- 视频自动探测 H.264/H.265；验收范围是 8 位、闭合 GOP、定期 IDR。本版只接入视频，不转码、不接入音频；不承诺任意浏览器能编码或播放 H.265。

RTSP 由 `ainvr-ingest.service` 管理，每路一个独立转封装进程。安装器从锁定的公共镜像提取 FFmpeg 到 `/opt/ainvr/ffmpeg-8.1.2/`，不依赖目标板临时联网安装。`configure-ingest.py` 为服务生成独立凭据，写入 `/etc/ainvr-ingest/service.env` 和控制台环境文件；勿把生产凭据复制进离线包。`--only python` 更新并启用该服务，`--only console` 更新协议页面及接口；旧版本升级应同时更新 AI 二进制、Python 制品和控制台镜像。首次开放 SRT 端口需要重建 SRS，须安排维护窗口。

部署后检查 `systemctl is-enabled ainvr-ingest`、`systemctl is-active ainvr-ingest`、控制台协议能力，以及每路视频帧进度。诊断日志使用 `journalctl -u ainvr-ingest`；不要以进程存在或控制连接流量证明收到视频。归档保持每个有目标的推理帧保存，积压只反压对应通道。

如需停用拉流组件，先关闭 RTSP 通道输入，再运行 `sudo systemctl disable --now ainvr-ingest`。移除组件前确认没有 RTSP 通道使用，保留录像、Mongo 历史及参数库。不要手工删除凭据或 WHIP 控制记录替代正常撤销。

### 端口与网络

| 端口 | 方向 | 用途 | 何时需要 |
|---|---|---|---|
| 80/TCP | 浏览器、WHIP 发送端 → 设备 | 控制台；WHIP 信令 `/ingest/whip/<通道ID>` | 总是 |
| 8000/UDP | 浏览器、WHIP 发送端 ↔ 设备 | WebRTC 观看及 WHIP 媒体 | 用 WebRTC 观看或 WHIP 接入 |
| 1935/TCP | 相机 → 设备 | RTMP 推流 | 有 RTMP 相机 |
| 10080/UDP | 相机 → 设备 | SRT 推流 | 有 SRT 相机 |
| 554/TCP（相机端口以实际为准） | 设备 → 相机 | RTSP 拉流 | 有 RTSP 相机；UDP 传输还需相机能向设备回送 RTP |

1985、8080、3001、5432、27017、8120 仅供本机或容器内部使用，不对局域网开放。RTMP/SRT 没有按通道鉴权，相机网络应与办公网隔离。

### 新板验收步骤

新生产板只用离线包安装，不在生产板编译或运行集成测试。对现场实际使用的每种协议，各建一个通道核对：

1. 接入管理新建通道，选择协议。RTMP/SRT/WHIP 按通道详情给出的地址配置相机或发送端；WHIP 先在通道详情生成发布凭据，凭据只显示一次。RTSP 填相机地址、账号、密码与 TCP/UDP。
2. 通道在收到视频后才显示在线，编码栏显示 H264/HEVC 与分辨率；只有连接没有视频时显示“等待视频”。
3. 录像页该通道持续生成分段且能回放；AI 通道选该通道为来源后，帧数、推理数增长，识别历史出现新记录。
4. 断开相机约 1 分钟再恢复，确认自动恢复，不需要重启服务。

验收边界见随包 `docs/multi-protocol-ingest-acceptance-20261009.md`：功能链路已用 8 位、闭合 GOP 测试源覆盖四种协议的 H.264/H.265；真实相机的 10 位、开放 GOP、音频及多路满帧并发不在已验收范围。

## 系统日期时间（离线现场、无时钟电池）

授权计时、录像文件名和识别记录都依赖系统时间。设备断电后若硬件时钟没有电池，开机回到上次保存的时间；能联网时自动对时，离线现场需要人工处理。

- **时间无效保护**：系统时间早于 2026-01-01 时，授权对外报“设备时间无效”，录像与 AI 暂停，网页红色提示；管理页、授权页、日期和时间页照常可用。校准后自动恢复，不需要重启授权服务或重新激活，也不额外消耗授权。
- **校准入口**：系统配置 → 日期和时间。可一键使用当前电脑时间，也可手动输入。校准后正在运行的录像与 AI 自动重启一次，从新时间开始记录；被人工停止的服务保持停止。校准后仍会保持网络对时，联网后以网络时间为准。
- **防误操作**：授权按时间只进不退计费，把时间设到未来会一次性消耗授权。所填时间与电脑时间相差超过 1 天时页面要求二次确认，操作前先核对电脑时间是否正确。
- **局域网时间服务器**：同一页面可填写最多 5 个现场时间服务器（IP 或主机名），保存后立即生效；清空即恢复默认的互联网时间服务器。设备开机后尚未对时且未人工校准时，页面黄色提示，可关闭。
- 根本解决是安装时钟电池，见“新板到手后必须调整的事项”第 11 条。

## 安全关机

仪表盘的“安全关机”依次停止录像服务（最长 35 秒）、AI 识别服务（最长 95 秒），再关闭系统；流媒体、控制台和数据库随系统正常关闭，下次开机自动恢复。任一步失败即中止关机，把关机前原本在运行的服务恢复，并在页面显示失败原因，不会留下“没断电也没在录像”的设备。直接拔电可能丢失尚未落盘的录像和识别记录。
