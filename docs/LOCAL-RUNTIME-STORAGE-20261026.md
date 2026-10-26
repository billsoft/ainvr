# 本地运行与可移除历史存储（2026-10-26）

## 存储契约

板载 eMMC 保存运行代码、可执行文件/动态库、参数库 PostgreSQL、凭据和本地配置、模型与推理依赖、受限的观测/归档重试队列。SSD 保存录像、MongoDB 识别/告警/计数历史、长期图片证据。开发编译树、原始权重、研究候选和备份可保留在 SSD，它们不是生产运行依赖。

缺少 SSD 时，实时接入、监看、目标检测/跟踪、模型推理及配置读取仍可运行；录像与历史读取/保存不可用。依赖 MongoDB 的告警/计数持久化和自动审核队列也不承诺可用，不能把内存观测或临时队列称为已入库事实。历史服务不可用不得拖停实时推理。

## 当前部署

- `/home/sunrise/ainvr/ai-service/models/llm/qwen3vl-4b-review-v3` 是实际目录，未链接到 SSD。完整复制视觉 4 组、文本 4 组、输出头 1 个 HBM，以及 embedding.bf16、tokenizer.json、模板、归一化和位置编码表、ports 与包清单。包 SHA256 仍为 `d8f844ef590b05daaa72917539bfea83285ad9e86cd5c96f4010c4f606a7ab1c`。
- YOLO26x、YOLO26x-face、GPEN256 以及 YOLOE-26x 的 8/32 槽位模型、共享文本/重参数化组件全部位于 models 中；HBM 总计 16 个。配套 sidecar 的路径改为本地。
- YOLOE 分词环境位于 `ai-service/runtime/.venv-yoloe-tokenizer`，其 Python 指向板载 `/usr/bin/python3.10`；ftfy 6.3.1、regex 2026.9.29 导入通过。
- 参数库从 `/mnt/ainvr-ssd/databases/postgres` 停机完整复制到 `deploy/infra/data/postgres`，复制后、重启前递归比较一致；Compose 仅重建 postgres，保留原有账号、配置及通道身份。
- `data/ai` 不再是 SSD bind mount。当前 config_overlay.json 保留，本地观测日志改为 `data/observations`，原 producer/offset 与已积压记录保留；分析重试状态改为 `data/analytics`。
- AI 的有界诊断日志位于 overlay 同级的 diagnostics，去掉写死的 SSD 路径。AI 的 mountpoint 启动前置要求和对旧 LocateAnything 研究服务的 Wants/After 已移除；该研究服务停用，模型发现目录中的旧试验链接已移出。
- 取证缓存检测 SSD 是否实际挂载且可访问。未挂载/不可访问时不创建 SSD 下目录、不初始化该缓存；不因此抛错打断推理。缺盘启动后恢复该缓存需要重启 AI 服务，本次测试结束已完成恢复。

这次没有重新量化或替换模型内容，也没有扩大模型能力声明。Qwen3.5、LocateAnything 等编译/研究材料未加入当前生产模型目录。保留 SSD 上旧包作为迁移回滚材料，不把研究中间产物当运行包。

## 验证

- `python3 deploy-package/verify-local-runtime.py --report test/results/models-local-20261026/verified-assets.json`：逐项校验 Qwen 包文件大小/SHA256、检测/增强 HBM sidecar、YOLOE 编码器和分词资产；确认位于板载文件系统；16 个 HBM，通过。
- 完整 AI 原生编译、LLM 原生编译通过；LLM CTest 3 项、安装预检 2 项、资源完整性检查器 6 项通过。所有新部署 Python 脚本语法和 git diff --check 通过。
- 对 AI、LLM、后端设置临时 systemd `InaccessiblePaths=/mnt/ainvr-ssd` 并重启。用各自进程 mount namespace 实测 sunrise 用户无法读取 SSD。后台参数配置成功加载；AI 通道运行且 5 秒推理数 2375→2423，跟踪 active。
- 同一隔离状态下，Qwen 从本地包加载，实际 JPEG 任务成功，约 4.9 秒；包校验值保持不变。仅验证链路可用，不作为准确率复测或性能基准。
- 额外停止 MongoDB 约 24 秒，4 次采样：AI 健康接口可用、实时通道仍 running、跟踪 active；archive_unavailable_channels=2，business.ready=false，未假称历史正常。MongoDB 恢复后 archive_connected_channels=2、business.ready=true。
- 未物理拔盘或整机断电重启；以上是运行隔离与历史库离线测试，不能标成已经完成物理拔盘、冷启动和长期耐久验收。现场隔离曾复现诊断目录/缓存初始化的启动阻断，修复后重新验证通过。

## 后续安装与回滚

新 YOLOE 安装脚本写入本地 models，并复用同一组已校验文本组件；不再安装 SSD 模型链接。AI 安装器备份使用仓库内 `.Codex-trash`，不要求 SSD。Qwen 服务的默认包路径和图像归一化默认路径均更新到本地目录。

迁移 AI 状态可先运行 `python3 deploy-package/local-runtime-s100p.py` 预检，再显式 `--apply`；先安装并校验本地模型。该脚本只处理指定板上的旧 bind mount、服务要求及队列，不替代 PostgreSQL 停机迁移。新部署时 `prepare.py` 创建本地 PG 数据目录；旧部署不能仅改 Compose 路径指向空目录，必须先停 PG 并复制原目录，再比较后重启。

当前板上回滚材料（不随 Git 提交）：

- `.Codex-trash/local-runtime-20261026-145727/` 保存原 fstab、AI 配置及旧服务要求/模型入口。
- `test/results/models-local-20261026/rollback/` 保存原 Compose、原本地 PG 目录、AI/LLM 二进制。SSD 上迁移前的 PG 和模型包也仍保留。
- 回滚 PG 必须先停止该容器并选择明确的权威副本；上线后的新配置已写入本地 PG，直接切回旧 SSD 副本会丢失这些后续修改，不能盲目回退。
- 临时 SSD 隔离文件已撤销，恢复正常生产服务；未重启现有 SRS。AI 输出在部署/隔离重启期间存在短暂中断，录像/计数连续性不应宣称零中断。

板载分区 45GB，目前约剩 4.4GB；后续升级大模型需要预留原包和新包同时存在的空间。日志和重试队列沿用有界策略，不把整套历史库回退写到系统盘。模型文件/环境不进入 Git，发布时需作为独立模型/运行包交付。
