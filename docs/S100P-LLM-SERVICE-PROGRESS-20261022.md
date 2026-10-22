# 大模型微服务开发进度与硬件事故记录

## 当前状态

最终修复版本已于 21:42 发布，21:44 页面图片复审成功，模型常驻就绪（配置 v9）。前面的阻断项和第二轮小节是历史记录；当前准入方案及验收结果以本文末尾最新小节为准。不启用自动告警复核。

实现目录：`llm-service/`。构建目录：SSD `/mnt/ainvr-ssd/llm-build/ainvr`。模型包：`/mnt/ainvr-ssd/llm-packages/qwen3vl-4b-review-v3`。本期按设计 v1.0 提供固定告警图片复审；不支持自由 chat 或流式生成。

## 已验证（不代表全部验收通过）

- 20 张开发样本，同输入张量下 22 个决策 logits 与 Python 基准逐位相等。证据 `test/results/llm-service-development/numerical-gate.json`。
- 157 条开发模板 tokenizer 输入 ID 一致。
- 4 个尺寸的 Mali 缩放、归一化、patchify 与本机 Pillow 参考逐位一致；该机器 Pillow 为 9.0.1，尚须完成设计指定版本及真实 JPEG 独立集验收。
- 5 次真实 JPEG 任务与兼容接口测试通过，热请求约 2.9 秒。证据 `http-inference.json`。没有证明比原 Python 2.83 秒更快。
- 前后端类型检查通过。新增配置、代理、状态卡仍属开发代码。
- 已有实验报告保留；当前测试脚本变更后，不能把历史通过当作新版本通过。

## 2026-10-22 内核事故

读取 `/sys/kernel/debug/ion/heaps/cma_reserved` 的诊断命令（head/tail）触发板子内核崩溃和自动重启。pstore 显示 `Comm: head`，调用栈为 `ion_heap_show → ion_debug_heap_show → traverse.part.0 → seq_lseek → full_proxy_llseek`，随后 `Kernel panic - not syncing: Oops: Fatal exception`。这是本次诊断引起的现网中断，不是无影响实验；不能据此断言模型推理崩溃，也不能断言普通顺序读取安全。

证据已保存：`test/results/llm-service-development/kernel-incident-20261022/`。本机内核版本存在该风险，停止在本任务中读取 live ION debugfs；不得为了复现重复触发。官方文档列出该节点用于诊断，并不等于当前内核已验证安全。

重启同时暴露告警生产 release 的 node_modules 链接指向已不存在旧目录，报缺 mongodb。已确认源目录与 release 的 package-lock SHA256 相等，将相同依赖复制至当前 release 的实体目录，保留原坏链接作诊断，重启告警服务后 readyz=true。

恢复证据：`test/results/production-final-20261022/llm-incident-recovered-probe.json`。AI、录像、接入、Web、后端及告警 systemd active；后门 AI running，xm/8k/8kai 发布正常；大门配置 manually_stopped=true，保持手动停止，不擅自启动。

## 必须先解决的阻断项

1. 替换并验证安全的 ION 余量采集来源。不能用普通 MemAvailable/CmaFree 代替专用 heap 余量；该板 `/proc/meminfo` CmaTotal=0。当前加载预留器在无新鲜遥测时拒绝加载，不绕过安全条件。
2. 实验脚本不再读取内核 ION debugfs；要求外部验证过的遥测 JSON，保留原时间戳并在停止服务前检查新鲜性。临时目录在进程及采样线程结束后清理。
3. 完成 LocateAnything 与新服务共享预留，配置热应用/回滚、取消/断连、指标、服务单元、日志和安装脚本。
4. 完成独立集 JPEG 端到端质量复验、实际 OpenAI SDK 扩展接口、异常恢复、1 小时稳定性与 30 分钟共存测试。
5. 配置页和仪表盘浏览器验收，再按设计部署门槛确认发布。不得把当前开发版标记为 validated=true。

本轮不提交、不推送。遗留未上传的本地 task_time_observer/配额补丁位于 `D:/codex-task-staging/ainvr-llm-implementation`，须审阅、同步和编译验证后才能作为远程实现。


## 第二轮产品化补强（2026-10-22）

本轮没有停止生产、没有部署新服务，没有再次读取 ION debugfs。

- 配置确认改为状态驱动，模型加载失败不再报告 applied；配置失败保留旧应用版本，过期完成不能确认新版本。禁用时取消排队/活动任务；有在途任务时禁止管理接口卸载。
- 增加 SIGTERM/SIGINT 的正常停止流程、有限 HTTP 工作线程池、独立调用方完成统计、最近 256 个任务端到端延迟分位、模型包 SHA256。
- 任务文本长度和保留标记在入队前校验；拒绝不支持的生成参数与未知模型。执行和排队超时返回 504。
- 采集助手、仪表盘名称和日志来源接入代码已补充，模型未加载不会显示真正就绪。尚未部署。
- 控制台代理等待时间跟随配置上限，修复固定 135 秒提前超时；模型展示文案按产品样式处理。
- 增加 `llm-service/README.md`，说明调用方责任、有限 OpenAI 兼容范围、request_id 非幂等键、当前 validated=false。

新增验证：C++ 2 项；采集助手 7 项；HTTP 隔离 8 项；配置中心模拟往返通过；后端 6 项；前端文案 2 项；前后端类型检查通过；10 万条确定性完整模板 token id 与 HF 对照全部一致（215.44 秒，不加载 BPU）。证据 `test/results/llm-service-development/tokenizer-corpus.json`、`config-roundtrip.json`、`http-control.json`。

运行 git diff --check 通过，但这只说明格式无问题，**仍不能按第一阶段整体完成提交或部署**。尚缺安全内存遥测、LocateAnything 双向加载协调、独立集硬件质量验收、真实 SDK 推理/断连取消、长时间稳定性、完整安装发布流程与浏览器验收。没有任何新硬件或生产验收通过的暗示。

前文“本地配额补丁尚未上传”为上一轮历史状态；当前远程已有该实现并编译通过，仍待真实 BPU 负载测试。

## 生产控制面部署（2026-10-22 18:25）

已安装并启用独立 `ainvr-llm.service`，仅监听 127.0.0.1:8300；系统配置新增大模型配置页，仪表盘新增监视项。配置中心 v7 已应用，独立管理与 console-try 密钥加密存储。前后端候选已构建并部署，浏览器已验证配置入口和版本回显。安装过程 AI、录像、推流、告警服务 PID 未变化。

**模型保持禁用、未加载，推理仍不可用；不是模型生产验收通过。** 安全 ION 遥测未解决，不读取危险 debugfs，服务单元进一步禁止访问该目录。不接管生产告警。仍需补齐前述硬件验收；不得声明整批开发已可提交。

部署证据：`test/results/llm-service-development/production-install.json`。可复用首次安装脚本：`deploy-package/install-llm-console-s100p.py`、`provision-llm.mjs`。已存在安装拒绝直接覆盖；更新需核对现有配置。控制台备份 `dist.llm-before-*` 和本地服务发布目录已忽略。


## 第三轮：驻留互斥与真实图片验收（进行中）

本节取代前面“必须实现实时余量文件才能加载”的方案。生产不读取 ION debugfs，不再依赖 ion-status.json；官方接口仅查询 HEAP_2_RESERVED 总量（8053063680 字节），结合静态预算、全生命周期 flock 和加载后余量试分配。后者不是未来可用内存保证。

- C++ 与实际使用的 LocateAnything v14 Python 执行器共享锁，持锁直到全部硬件资源释放；坏登记、活进程但无锁、SDK 清理失败均保守拒绝。跨语言双向排斥、正常卸载、进程崩溃后恢复测试通过。
- 五张 JPEG、兼容 HTTP、卸载后重载、重载结果逐位一致已通过：`residency-hardware.json`。559 张独立集正在运行，不能把进行中当作通过。
- 失败后禁用及重试路径已修，配置状态回归在独立集结束后串行执行。新 C++ 三项测试通过，后端全量 60 文件/383 项通过，另 12 文件/55 项跳过；跳过不计通过。新增仪表盘状态三项和文案两项通过。
- 前后端候选 `/mnt/ainvr-ssd/ainvr-llm-web-admission-v2` 构建通过。尚未替换生产版本；更新脚本 `deploy-package/update-llm-s100p.py` 保留配置和凭据，并保存可回滚发布。
- 验收入口 `llm-service/tests/run_admission_acceptance.py`：独立集结束后运行控制协议/加载冲突恢复，再运行 Python/Node SDK、断连后恢复、有界并发和一小时稳定性。稳定性期间不停止 AI、录像、流媒体或 LocateAnything，只有模型服务使用隔离配置。
- 当前 SRS 没有输入视频流，不能认定“两路检测共存”通过。已请用户恢复视频源；不修改原通道或手动停止状态。
- 断连目前采用有上限的完成/清理，不宣称立即取消底层硬件任务。告警自动复核仍未启用，业务阈值仍需独立验证。

## 第三轮验收进展（20:49 更新，仍在运行）

- 559 张独立 JPEG 已全部完成，输入 ID/图片 SHA 与原基准逐项核对；与 BF16 判定一致率 97.67%，达到 97.3% 门槛。408 张有业务标签的准确率 89.22%；保留真告警比例 80.82%，拦截误告警比例 98.94%。这不是通用场景准确率，也不批准自动告警阈值。报告：`residency-final-559.json`、`final-559-quality.json`、`final-559-provenance.json`。
- Python OpenAI SDK 3.36.1 与 Node SDK 7.42.0 的真实图片决策扩展调用通过；断连后清理恢复、12 请求并发中的队列拒绝和超时后恢复通过。拒绝/超时是容量控制的预期结果，不作为成功推理计数。
- 配置失败后重试、禁用，以及带历史已应用配置的进程重启恢复通过。后台全量结果仍为 383 通过、55 跳过，不重复计数。
- 默认分配器的长测在约 12 分钟后主动停止调查：RSS 从约 523 MiB 增长到 590 MiB，文件描述符无持续增长。原报告 `service-endurance-default-allocator.json` 的 Connection error 是中断 SDK 后留下的测试错误，不应解释为模型自行故障。
- 结合进程映射及 [glibc 官方分配器说明](https://sourceware.org/glibc/manual/latest/html_node/Memory-Allocation-Tunables.html)，服务设置 MALLOC_ARENA_MAX=2 后重新执行完整一小时门槛；目前只属于复测中，尚不能宣布最终稳定性通过。设置限制 allocator arena 数量，不限制 BPU 专用内存；RSS 不是模型总内存。
- 用户已恢复一路后门输入（流名 8k，实际 1920×1080），原大门维持手动停止。读数监测不改通道配置。密集大模型请求期间，后门约 8.3–8.9 FPS，目标 10 FPS；SEI/推理一一对应，无连续错误。不能宣称两路共存通过，也不能宣称检测性能不变。该通道截图归档由用户关闭，未覆盖并发归档负载。
- 最新控制台候选为 `/mnt/ainvr-ssd/ainvr-llm-web-admission-v4`；构建完成且源文件一致。生产更新仍等待长测，不能把构建完成当成已发布。


## 2026-10-22 21:45 发布完成（当前结论）

- 候选 `/mnt/ainvr-ssd/ainvr-llm-web-admission-v6` 已发布，二进制 SHA256 `b9e9f7e63a1994246b4a9e64b667d77e94eddf727552a336ea2936617b4bd80d`。
- 生产配置 v9：启用常驻，执行超时 30 秒，提交配额 40%。页面真实 JPEG 调用成功：4.64 秒；9/9 服务正常。
- 一小时稳定性自然完成：526 次请求，稳定性、卸载重载一致性、恢复均通过；使用 MALLOC_ARENA_MAX=2。此前默认分配器中断记录保留，不能混作成功。
- 独立 559 JPEG 与 BF16 决策一致率 97.6744%；408 张带标签样本准确率 89.2157%，两种指标不可混淆。
- 后门单路检测与密集复审共存约 53 分钟：无连续推理错误，检测 FPS 中位 8.7，未维持目标 10 FPS。双路共存、截图归档负载未验证（用户只有一路，且现有归档关闭）。
- 发布时 AI、录像、流媒体、告警进程 PID 保持不变。未更改用户通道配置。
- 本期固定图片复审服务，不含自由对话、流式生成或自动告警复核；业务阈值仍需单独验证。
- 证据：`service-endurance.json`、`final-559-quality.json`、`live-coexistence-summary.json`、`production-admission-update.json`、`production-ready.json`，均位于 `test/results/llm-service-development/`。
- 按用户要求不再扩测、不重复全量测试；最终 diff 空白检查通过。没有自动提交。
