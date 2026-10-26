# AINVR ONVIF 音视频接入：实现、发布与验收

更新：2026-10-26。交付范围是音视频接入子集，不是完整 ONVIF Profile S/T 客户端认证。尚无物理 ONVIF 摄像头；以下模拟验收不能替代厂商/固件兼容验收。

## 架构与操作入口

摄像头的 SOAP/发现请求由独立 Go `ainvr-onvif` 服务处理；媒体沿用 `ingest-service → RTMP → SRS → 原始监看/录像/AI`。不引入生产 MediaMTX、第二套播放器、录像索引或业务数据库，不升级或重启现有 SRS。

- 系统配置 → ONVIF 接入：全局开关、控制服务、发现网卡、摄像头允许网段、超时及应用版本。拉流容量和音频转换配额复用现有接入服务配置。
- 接入管理 → 新建/编辑通道 → ONVIF：设备地址/独立凭据、明确证书信任、物理视频源、Media1/Media2 Profile、音频及启停。可发现，也可手动添加。设备/视频源多时可搜索。
- 设备、视频源、Profile 和 AINVR 通道各有独立身份；不以名称、IP 或临时媒体 URI 代替。Profile 消失时报错，不自动换另一幅画面。编辑使用版本检查。
- 关闭页面不停止取流；停用输入才停止取流。多个消费者复用一套发布；输入画面无 AI 叠加，热区/轨迹/告警/计数属于 AI 输出。
- 通道详情显示媒体实际状态、音频原因、重连信息；仪表盘沿用服务列表。

本次已在开发板部署并通过实际生产向导创建临时模拟通道，验证原始播放器解码及带 AAC 的现有录像链路。临时设备/通道已移除，监看布局和原四个通道保留，全局 ONVIF 开关恢复为关闭。12 个服务健康；启用真实设备前先配置允许网段和发现网卡。

## 协议核对与边界

规范来源优先于开源参考。开发前后核对本期相关条款：

- [ONVIF Core 26.06](https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf)：SOAP、命名空间、Fault、认证、时间、发现和设备能力。
- [ONVIF Streaming 26.06](https://www.onvif.org/specs/stream/ONVIF-Streaming-Spec.pdf)：媒体 URI、RTSP/RTP、keep-alive、同步和会话释放。
- Device、Media1、Media2 WSDL/onvif.xsd 原始快照及 SHA-256：`onvif-service/protocol/manifest.json`，固定 onvif/specs 提交 `e5790320408db7acb19a8f826411f1a94083bf96`。不是所有传递 import 的完整快照；运行时不下载 WSDL。

| 条款/行为 | 实现与验证 |
|---|---|
| SOAP 1.2 / QName Fault | 按命名空间 URI 匹配；不以 Reason 文本判断认证；限制 2MiB、深度32、节点4万、单节点64KiB，拒绝DTD；固定报文测试 |
| Core 5.9.1 认证 | WSSE 与 HTTP Digest 分开；Digest 重试移除 WSSE，覆盖多挑战/auth-int；独立 Python 模拟器分别校验，两种方式实际取流通过 |
| Core 5.9.5 / 设备时间 | 随机原始 nonce + Created + 密码摘要；设备时间偏移只用于该设备，120秒偏移测试；认证失败持久停止，显式修正/探测才恢复 |
| GetServices/GetCapabilities | 检查真实服务地址，受控兼容回退；设备信息、时间、服务及每次媒体解析均有超时/大小/并发限制 |
| Media1 | GetProfiles / StreamSetup / MediaUri；InvalidAfterConnect、Timeout 决定探测后是否重新取 URI；正小数有效期向上取整，未知有效期保守更新 |
| Media2 | GetProfiles Type=All；GetStreamUri Protocol=RTSP；按物理源+Profile明确绑定；不把每个Profile当不同摄像头 |
| Core 7 发现 | 指定接口；响应关联、过期丢弃、去重、数量限制；支持旧WS-Discovery命名空间；实际组播及固定报文验证 |
| HTTPS | 默认系统信任验证，可按设备显式固定叶证书SHA-256；真实TLS正反测试；不全局跳过证书检查 |
| URI/网络安全 | CIDR检查、DNS固定、同设备服务/媒体地址限制；禁止HTTP/RTSP重定向；实际旧FFprobe可跨目标、修补版不跨目标的对照测试 |
| Streaming 会话 | 固定FFmpeg负责RTSP认证/SETUP/PLAY/keep-alive/RTP/退出；真实媒体矩阵和断线/丢包验证。ONVIF首期仅RTSP-over-TCP；普通RTSP仍保留原TCP/UDP选项 |
| 运行恢复 | 每次连接重新取得URI；探测可能消耗URI则再取一次；健康媒体不因周期URI刷新或控制服务故障重启；配置代次拦截迟到结果 |

不包含 PTZ、事件订阅、设备SD卡补录、组播媒体、任意公网穿透、自动跨视频源切换或完整Profile符合性。

只读参考：`third_party/reference/onvif_simple_server`，roleoroleo/onvif_simple_server 提交 `d0ca1a78fefeb47aeb0207b68ac0f56adf92bc13`。对照摘要、Media1/2结构和发现时序；GPL项目不链接、不拷入生产运行。全部许可证/版本见 `onvif-service/THIRD_PARTY.md`。

## 媒体和资源约束

H.264/H.265 视频仅复制；AAC复制；G.711 A-law/μ-law、G.726/G.726LE 转AAC。无音轨正常；不支持音频、音频失败或配额满时保留视频并明确原因。视频无CPU解码/编码回退。普通RTSP复用相同媒体实现，旧配置音频默认保持关闭；ONVIF新输入默认自动音频。

拉流上限默认4、可配置至32；音频转换默认2、范围0–8。连接线程2、等待容量4，队列满显示等待而不是制造失败和指数退避。探测结束后重新起算媒体进度超时。退出回收子进程、线程与音频名额。

控制服务绑定回环8150，服务鉴权经Web后端；独立系统账号，MemoryMax192M、TasksMax64、CPUQuota100%。设备凭据在参数库加密，普通API无密码；媒体地址用匿名内存文件传递，不进入进程参数或普通日志。程序/依赖/参数在系统盘；录像/历史仍使用现有存储策略。系统日志沿用既有有界日志管理；测试输出不进入生产缓存。

备份导入保留ONVIF绑定，但不导出凭据、不自动启用；重新启用必须取得受控媒体地址。不存在的原设备不阻断设备列表，用户可以重新选择。重复绑定拒绝，导入写入保持事务原子性。

## 验收结果（2026-10-26）

测试代码在 `test/onvif/`；原始日志、失败报告、音视频和私有测试配置在被忽略的 `test/results/onvif-20261026/`。不提交凭据和媒体大文件；复现说明见 `test/onvif/README.md`。

| 验收 | 结果与限制 |
|---|---|
| Go协议/安全 | `go test -race ./...`通过，包括真实TLS、认证挑战、地址边界、XML限制、发现、媒体身份、短有效期 |
| 后端 | 59项通过，含独立真实PostgreSQL加密/CAS/重启及导入恢复；前端专项4项及通道回归36项通过；Python拉流18项通过；前后端编译通过 |
| 编码矩阵 | H264/H265 × AAC/PCMA/PCMU/G726/G726LE/无音频，12/12通过；Media1/Media2、WSSE/Digest交叉验证；AAC44.1k/48k立体声另测通过 |
| 音频降级 | Opus保留视频并报告不支持；三路G711争用两名额时第三路保留视频并报告配额，停止后名额归零 |
| 丢包/延迟 | 私有TUN/namespace实际TCP/IP丢包1/3/5/10%及抖动，持续有帧；不改物理网卡、防火墙、生产SRS |
| 独立SRS重启 | 四路测试在19.445秒恢复，父FD6→6；仅重启隔离测试容器 |
| 断网/相机重启 | H264/G711恢复19.027/19.227秒；H265/G726恢复11.617/14.225秒，均小于60秒；控制服务停止不重启健康媒体 |
| 复制容量 | 320×240、10fps、AAC：4/16/32路均通过；就绪16.436/37.555/47.971秒；峰值聚合RSS约47.2/125.1/236.1MiB。不是32路高码率或AI处理承诺 |
| 四路持续 | 600秒，120个资源点；聚合RSS48,824,320→49,610,752字节，FD固定46，父FD6→6，无音频名额泄漏。不是全天老化验收 |
| 录像/同步 | 现有录像链路产出AAC文件；正常IP帧矩阵音画目标≤200ms；AAC48k复制约107ms。500ms人工偏移正控能检出500/499ms |
| B帧辅助样本 | 该样本直接从独立RTSP取流已偏373.033ms，经AINVR为390.8ms，额外约17.767ms且无漂移；原始绝对200ms门槛未过，保留失败，不能以此声称所有来源同步均通过 |
| 生产UI | 实际创建、编辑、监看、录像、清理及恢复原配置；新增输入无AI叠加；已有AI输出布防链未替换 |
| 发布回滚 | 原版本回滚及重部署已实际演练；增量迁移保留历史，不重启SRS/AI/录像服务 |

有限帧率/码率的模拟结果只用于验证链路和资源边界。真机NVR多源、厂商Digest变体、长GOP/B帧时钟、高码率32路、24小时老化及物理拔盘仍需按具体设备记录，不伪称完成。

## 构建、部署与回滚

这是既有S100P AINVR基础安装上的协调增量发布包，不是通用Jetson旧安装器或新的整机出厂镜像。前置条件：既有Node24、Python虚拟环境/依赖、参数库、后端环境和SRS均就绪；准备Go工具链与固定FFmpeg构建。生产运行不需要Go、MediaMTX或Git子模块。

1. `deploy-package/build-media-bridge.sh`：按固定源SHA构建带禁止RTSP重定向补丁的音频/复制FFmpeg。发布包附许可证、补丁、构建信息和相对校验值；分发二进制时保留对应源码获取/重建方式。
2. `python3 deploy-package/build-onvif-release.py`：输出新 `out/onvif-release-<时间>`，隔离编译前后端、Go，打包媒体/共享Python/服务观测模块/安装器和许可证；不改线上dist。构建期间源码变化则拒绝完成。
3. 首次迁移前，应在修改旧ingest源码前捕获 `ingest-service/main.py` 的tar与SHA-256；首次安装显式传 `--baseline-ingest <tar> --baseline-ingest-sha256 <main.py的SHA>`。已有 `70-onvif.conf` 的后续更新无需重复提供。禁止用已改写源码冒充旧版本。
4. `sudo python3 deploy-package/deploy_onvif_release.py --apply out/onvif-release-<时间> --check-source`。开发工作区加 `--check-source`；部署已校验的独立候选包可省略该参数。要求安装根目录下out路径，必要时设置 `AINVR_INSTALL_ROOT`、`AINVR_NODE`。所有产物先验SHA；保留至少1GiB系统盘余量。
5. 回滚：`sudo python3 deploy-package/deploy_onvif_release.py --rollback .Codex-trash/onvif-deploy-<时间>`。每个备份只回滚一次；恢复可执行文件、配置归属、原启用状态、不可变ingest及前后端。增量PG迁移/历史数据保留，不删除通道数据。

安装器位于版本库 `deploy-package/`，不依赖被Git忽略的测试目录。新Go服务运行并不等于已启用摄像头接入；全局开关保持原值。已有网页资源有24小时/64MiB保留上限，防止升级时正在打开的页面立刻缺失代码块。
