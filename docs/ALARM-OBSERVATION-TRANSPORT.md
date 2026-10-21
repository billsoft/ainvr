# AI → 告警：统一结果的 SSD 有序传输

> **2026-10-19 最终部署状态更新**：告警服务、AI 观测输出、控制台前后端已在 S100P 上部署。当前结论、测试证据、脚本位置、回滚路径与保留限制统一见 [告警交付与提交检查](./ALARM-DELIVERY-HANDOFF-20261019.md)。下文中“未部署”“待验收”属于较早阶段记录，不代表最新状态。

2026-10-19；已实现源码和隔离集成测试，未部署真实通道。

## 边界

AI 服务只输出原图坐标的统一跟踪结果；不在传输模块判定告警。独立告警服务读取结果后调用现有 durable consumer，同一套租约、检查点和故障重放用于 HTTP 与本地传输。

两端通过部署环境 AINVR_OBSERVATION_SPOOL_ROOT 指向同一个设备 SSD 私有目录。未设置时不启用。目录不能暴露给 Web，不应放系统盘或临时盘。目前尚未在现网配置。

## 文件与协议

- 原生代码：ai-service/src/analytics/observation_journal.hpp；推理工作线程在跟踪后提交统一结果。
- 消费端：alarm-service/src/observation-pump.mjs，由独立服务 runtime 启停。
- 子目录：channel_id 原始 UTF-8 SHA256，权限 0700；原生 writer 用 flock 排他。
- producer.json 保存稳定 producer_id 和下次 offset，重启延续；不能人为删除来重置。
- 记录文件为 20 位 offset 加 .json，顺序消费。先 fsync 临时文件，再原子改名并同步目录；元数据预留 offset，写入失败留下后续可见的序号间隙。
- 每条上限 1 MiB；每通道暂定 64 MiB/10000 条。容量满时原生上报 staging 失败计数。推流继续，但不能宣称分析覆盖完整；同步写入开销仍须实机压测。
- 样本含实际通道、流地址、session、原帧 index/PTS、时间、原尺寸、实际标签目录及跟踪状态。index/PTS/offset 都是十进制字符串，不经 JS Number。

持久化失败保留队首，不跳过处理该通道后续记录；其他通道可继续。仅 durable ack 后删除并同步目录；崩溃后可重放相同 offset。

## 来源绑定和时间

保存监控器时，BFF 从真实 AI 目录建立 source_binding：输入 SRS ID、流地址 SHA256、画面尺寸、标签/几何版本和 not_before。前端不能提供权威绑定；PG 保存版本化副本，告警服务接收快照。

消费核对实际流指纹、尺寸、实际标签目录哈希。绑定时刻之前的历史样本不回填新监控器；规则引擎也检查 not_before，避免发布期间旧帧触发新规则。

没有已应用规则快照时等待；旧监控器缺绑定时保留队首并报告异常，需重新确认保存。已应用快照明确不再监控该来源、标签/尺寸/流不符、绑定之前的样本不参与分析，计入 ignored 及原因。ignored 不代表告警数或丢帧率。

## 状态与验证

/v1/status 的 observation_journal 报告 ready/waiting/degraded/disabled、pending、consumed、ignored、failed 等。failed 是尝试次数；未知延迟仍为 null。仪表盘业务卡不把未连接显示为正常零值。

test/ai_port/observation_journal_test.cpp 验证身份延续、排他 writer、配额失败的 offset 间隙。alarm-service/test/observation-pump.test.mjs 覆盖绑定、顺序重试和原生文件→真实 Mongo。最新全套 53 项通过、无跳过。

尚需 shared worker 并发修改核对、完整构建和真实通道部署、原帧图像证据、停流生命周期和覆盖率。日志只绑定原帧身份，不能把当前截图当作事件原帧。VLM/通知不执行。
