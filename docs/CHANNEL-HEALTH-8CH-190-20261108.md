# .190 八路系统体检（2026-11-08）

## 范围与结论

实测约5分钟。8路同源1080p30独立解码、检测和跟踪，目标3.3 FPS；关闭识别历史、新增7路不输出视频，不新增7路录像或规则。原通道录像、告警、大模型、搜索、PG、Mongo、SRS保持运行，另外发起3次固定JPEG审核请求（不写告警）。不是8台独立摄像头、8路全录像和同时告警的容量认证，也不是长期稳定性测试。

系统没有发生服务崩溃或资源耗尽，但仍未达到八路连续跟踪验收要求，且发现当前新增行为事件缺裁剪图，不能笼统称为历史脏数据。

## 实测

| 项目 | 结果 |
|---|---|
| 检测 | 每路3.161–3.186 FPS，按累计次数/墙钟时间计算 |
| BPU | 稳态平均93.375% |
| 跟踪 | 按PTS去重后active占比90.37–92.63%，最长采样间隔2.333秒；不是跟踪准确率 |
| CPU | 全机计算约32.74%，I/O等待14.70%，空闲52.55%（243.8秒系统采样窗口） |
| CPU内存 | 8路系统采样最低841MiB；剔除首分钟的通道探针最低1323MiB；没有交换空间 |
| 温度 | 采样最高57.22℃，没有本轮过热证据 |
| SSD | 读18.91MiB/s、写8.92MiB/s，设备忙78.42%，平均I/O等待6.79ms、平均队列3.42；忙比例不等同于带宽用尽 |
| eMMC | 读5.76MiB/s、写0.08MiB/s，忙1.90%；并非所有系统读取都迁到SSD |
| 磁盘空间 | eMMC剩15GB，SSD剩106GB（压测前） |
| 微服务 | 17个systemd服务采样前后PID不变、NRestarts=0，无意外重启 |
| 内核 | 采样窗口未发现OOM、BPU wait failed、SSD I/O或EXT4错误 |
| 接口 | AI/录像/告警/SRS共25组探测无失败；最长约5.1/103.6/3.1/3.1ms |
| PG | 无锁等待、累计deadlocks=0，临时文件字节0，正常空闲连接 |
| Mongo | 容器healthy、告警读写链路成功；RSS约620MiB |
| 搜索 | 带console凭据/v1/status ready=true；未进行搜索结果质量或全量采集覆盖率验收 |
| 审核 | 三次固定JPEG请求成功，3.39/3.54/3.51秒；只验证性能，不验证准确率 |
| 录像 | 原通道持续录制、最近小时droppedMs=0、写降级0，片段availability=true、Range206可读 |
| 观测消费 | 三次pending均0、failed均0，未见持续积压 |

RSS主要项：AI约750MiB、Mongo620MiB、搜索380MiB、SRS229MiB、LLM190MiB。RSS不可直接相加当整机唯一用量；ION另计。AI约246线程，并不意味着需要再提高并发。

## 值得修改的地方（按优先级）

### 1. 行为事件裁剪证据与识别历史耦合：确定存在

采样期间alarm_evidence pending从9变11，stored保持1847，unavailable保持837。只读Mongo核对发现15:12:44的新事件处于capture_retry，证实并非全是旧事件。日志每分钟受限输出not_saved_or_expired。

代码链：alarm-service/src/evidence-vault.mjs读取exact source crop；evidence-source.mjs经控制台内部接口查询；ai-service/src/output/observation_evidence.hpp只从识别归档Mongo记录寻找精确会话/帧/目标裁剪图，明确retention=ai_history。当前snapshot.enabled=false，因此这条来源不保证存在。独立审核原帧缓存本轮failed/dropped/protected_evicted均0，这两个证据系统不可混为一谈。

建议复用已有持久原帧及冻结目标坐标，按实际行为/告警需求生成精确裁剪图；不得为了补行为证据而重新打开所有识别历史。保留来源身份、帧号、图像尺寸与哈希校验；来源明确禁用应给出准确状态，避免20次注定失败的重试。补“识别历史关闭、行为证据仍完整”的集成测试。这次体检未实现该修复。

### 2. 没有消费者的观测仍落盘再被忽略：确定有无效消费，优化边界需验证

243秒内ignored从7506增至12862（5356条），原因no_active_monitor，约21.9条/秒，与新增7路检测量相当。worker在有journal时仍Stage结果，消费端之后才判断无monitor。系统I/O等待明显，AI短时进程I/O采样写约4.25MiB/s，Mongo读约6.40MiB/s；这些是线索，不能直接把所有SSD开销归为观测日志。

建议沿用现有配置需求登记，按通道的告警、计数器和统计消费者决定是否启动持久观测；纯检测/实时轨迹继续输出，但没有消费者时不做无用途的持久交付。配置保存切换必须携带版本/会话边界，不能漏掉新启用规则的首帧。先精确分摊观测、截图、Mongo和录像的I/O，再考虑有界批量fsync；不能删除真正告警证据的持久化保障。

### 3. 八路轨迹时延保护仍会触发：确定未达标，根因不止一种

BPU平均93%与3.17 FPS掩盖了超过一秒的间隔。大模型调用、磁盘等待和采样/调度都需按同一时间线关联；本次结果不能证明所有间隔都由LLM导致。

候选路线是有限FC时长的模型分段抢占、跨模型有界调度及最老帧等待指标。上一轮SDK优先级128/254没有有效改善，不建议直接启用。维持断帧保护，验收看每路最大/P95/P99间隔和ID连续性，不通过下调资格门槛“修好”曲线。

### 4. 内存与可观测性：不宜盲目加缓存/线程

最低841MiB是有余量但不宽裕，不能直接扩大Mongo缓存、AI并发或增加7路媒体输出。此前8路全部输出已经触及600MiB安全线。应逐项增加输出/录像验证各自增量，而不是一次开启全部。

日志本轮没有刷盘风暴：告警4条约1KB，后端约104KB/4分钟。SRS观察器记录47次1007 disconnect的汇总，输入/输出流仍活动、录像可读；尚未逐条归因客户端，不能直接宣称是推流断线，也不能全部算正常。可补连接角色/流ID分类，保留现有有界汇总。内核未提供/proc/pressure，使用/proc/stat与diskstats交叉验证。

## 恢复和证据

临时7路已删除，原通道目标恢复10 FPS，临时90-stress.conf移除、SDK优先级0，大模型/告警保持开启、无swap、无failed systemd单元。不清理历史数据，不修改业务源码，不提交Git。

板上原始记录：test/results/eight-channel-audit8-20261108/（samples.jsonl、system.jsonl、alarm-0/12/24.json、evidence-recent.json、llm-load.json、services-before/after.json、log-audit.json、postgres.txt、search-ready.json、recording-under-load.json）。本机分析：D:/rdk/eight-channel-20261108/audit8-analysis.json及audit8-system-summary.json。
