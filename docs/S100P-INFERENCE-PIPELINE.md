# S100P 推理流水线优化（2026-10-13）

开发与复现目录 `/home/sunrise/ainvr`。本次不重新量化或编译 HBM，不降低输入尺寸、阈值或识别精度。保留已通过验收的模型及其质量限制；GPEN 的严格 FP32 数值门槛未过、用户视觉验收通过的事实不变。

## 已测得的瓶颈与改动

原先解码交付可能成批到达，单个 latest-frame 槽覆盖了仍可处理的帧；预处理和 BPU 又依次执行，导致 BPU 等待。改为有上限的解码队列，加上图像预处理与上一帧 BPU 推理重叠：

`VPU 解码 → 有界 NV12 队列 → PYM/GLES 预处理 → BPU → 后处理/SEI → 原有异步归档`

- 解码队列最多 8 帧，且不超过按 96 MiB NV12 数据预算计算的帧数；低目标帧率按约 250ms 缓存缩小队列。超过 250ms 的排队帧跳过，避免无限堆积。这不是整个进程的内存上限。
- 最多两个在途 future。BPU 执行与输出读取加锁，仍复用同一模型实例及 SDK 缓冲；并行的是下一帧预处理与上一帧推理，不是重复加载模型抢占 BPU。
- GLES 在原所属线程执行，输入内存由异步任务持有，结果按帧顺序返回；停止时等待异步任务退出再销毁资源。
- 有帧率限制时，未完成的推理不能阻塞越过下一采样时刻；已完成结果及时发布，避免额外延迟。15/30 FPS 单独复验。
- 保留帧序号、generation、SEI 匹配和归档反压逻辑。新增 capture_to_result 指标衡量板端已解码帧到结果的时间，不含上游摄像头和网络延迟。
- `AINVR_BPU_PIPELINE=0` 可用于串行对照。解码队列仍启用；完整旧版本回退需使用备份二进制。

## 单通道真实 3840×1920、30 FPS 输入结果

| 模式 / 模型 | 实测 FPS | 平均 BPU 利用率 |
| --- | ---: | ---: |
| 原 COCO，目标 15 | 9.11 | 25.56% |
| 原 COCO，无限速 | 12.62 | 36.63% |
| 仅有界队列 COCO，无限速 | 24.06 | 66.81% |
| 队列 + 流水线 COCO，无限速 | 29.98 | 81.6% |
| 队列 + 流水线 Face，无限速 | 30.02 | 84.0% |
| 队列 + 流水线 YOLOE，无限速 | 29.76 | 66.59% |

固定采样补测：目标 15 实测 14.92 FPS，目标 30 实测 28.58 FPS。生产同时恢复录像的 120 秒观测中，目标 30 实测 28.55 FPS、BPU 78.44%、SEI 迟到及重连均为 0；未通过预设的 ≥29 FPS 门槛。该失败报告保留在 `test/results/throughput-production-target30-20261013.json`，未降低门槛。最终在正常网页向导中设为 0（跟随源流），重新观测，见最终报告。

上述表格是独立生产 Worker 实流测试，截图关闭，前 8 秒预热，约 27 秒测量。每个模型预热后 SEI 迟到为 0，推流重连为 0，进程峰值 RSS 约 312–322 MiB。实际采样有边界抖动，所以 30.02 不代表超过输入帧率。

相同 8 张真实解码帧各重复到 64 次，串行/流水线完整输出逐项完全一致。COCO 完整图像适配器串行 25.19 → 流水线 35.69 FPS，Face 25.07 → 35.48 FPS。该重复帧实验验证并发正确性与速度，不是新增准确率数据集。

归档功能另以实际 YOLOE Worker + GLES/JPU/MongoDB 验证：25 条记录、50 张 JPEG、CPU JPEG 为 0。它证明本次调度改动不破坏归档，不能据此宣称开启全部截图/GPEN 后仍可保持视频 30 FPS。GPEN 既有 92.7491 FPS 是纯推理历史结果，本轮未重新测速或改变 GPEN 模型。

## 证据与复现

- `test/results/throughput-baseline-20261013/summary.json`
- `test/results/throughput-buffer-20261013/summary.json`
- `test/results/throughput-pipeline-v2-20261013/summary.json`：三模型完整输出一致性和实流。
- `test/results/throughput-sampling-20261013/summary.json`：有采样限制的调度复验。
- `test/results/throughput-pipeline-archive-20261013.json`：真实归档。
- `test/results/throughput-production-final-20261013.json`：生产恢复后 120 秒观测。

构建目标 `ainvr_throughput_probe`、`ainvr_bpu_pipeline_probe`、`reused_worker_test`。测试源码位于 `test/ai_port/`。`run_throughput_experiment.py <唯一标签>` 自动暂停并最终恢复原先运行的 AI/录像服务，测试临时输出流；`validate_sampling_pipeline.py <唯一标签>` 测 15/30 FPS。不可与生产推理或其他硬件性能测试同时运行。`observe_production_throughput.py` 是只读生产观察，不停服务。脚本当前使用本次已备份的通道作为基线；在其他安装上需先核对根目录、模型及基线文件，不能盲跑。

`validate_pipeline_candidate.py` 对三模型做完整对比；输出目录要求不存在，不覆盖历史报告。首轮探针因为相对/绝对模型路径检查失败，原失败报告仍保留在 `throughput-pipeline-20261013`；修正探针路径后 v2 通过，不能把首次失败当作模型不兼容。

## 部署与回退

生产服务版本为 `ainvr-s100p-reused-control-0.14`。通过 `deploy-package/install-ai-s100p.py --binary out/build/ai-api-compat/ainvr_s100p_control_service --start` 安装，保存旧二进制并校验启动与业务健康。最终二进制哈希见生产报告。

修改前全部模型、描述文件、运行配置和旧二进制备份：`/mnt/ainvr-ssd/migration-backups/inference-throughput-20261013`，校验表 `models-manifest.json`。私有配置不可复制到日志或文档。初始 0.13 可执行回退版本位于 `/mnt/ainvr-ssd/migration-backups/ai-install-20261013-060942-2922707`；使用安装器指定其中备份二进制回退，先核对实际文件名与哈希。通过网页将目标 FPS 改回 15 即可恢复原采样策略，无需改 HBM。

当前结果已接近这一路 30 FPS 输入的上限。它不是“所有场景已优化到绝对极致”的结论：多路并行、每帧多目标截图及 GPEN、长时间热稳定性需要各自负载验证。提高 BPU 利用率是定位工具，不能只为追求 100% 增加重复推理或堆积延迟。

## 最终生产验收

录像恢复后连续 120.29 秒：推理 29.945 FPS，输入 30.037 FPS，BPU 平均 77.64%，AI 进程峰值 RSS 315712 KiB（308.3 MiB）。新增 SEI 3602，迟到 0、重连 0、推理错误 0。配置相比备份仅 inference_fps 由 15 改为 0（跟随源流）；截图仍关闭。原流和 AI 输出网页均实际播放 3840×1920，并看到检测框。

最终二进制 SHA256：`534fa7b2d7267a95b5898401531e70eb7f928c9c0e995c684af40ccf52fb2047`，已核对运行进程与磁盘文件一致。模型源文件及 SSD 备份 10 项均重新校验一致。完整审计 `test/results/throughput-final-audit-20261013.json`。网页“0 FPS”显示改为“跟随源流”，不改变配置语义。

## 截图开启后的后续优化

上述 29.945 FPS 与旧二进制哈希属于截图关闭时的验收。当前已部署截图归档优化版，保留原 HBM 和通道参数；三分钟约 19.56 FPS、159.91 个目标/秒入库。详见 [截图归档流水线](S100P-ARCHIVE-PIPELINE.md) 及 `test/results/archive-pipeline-selection-20261013.json`，包含资源上限、六线程反例和 SEI 迟到边界。


## 2026-11-07：S100 .190 审核证据与检测调度解耦

### 问题与最终路径

开启审核证据后，BPU 平均利用率不高而目标 10 FPS 实际只有 [7.51, 8.43, 7.95, 8.29]。根因一是 `ReviewFrameCache::Offer` 提交工作后立即 `future.get()`，检测线程每帧等待图片转换、JPEG、目录扫描和 SSD 持久化（原实测约 75–82 ms）；根因二是消费者重复逐文件同步保留标记和逐帧同步删除，提速后形成积压。

最终路径：检测结果 → 有界证据异步提交并取得完成回执 → 继续检测；同一通道观测日志 FIFO writer 等回执 → 持久化 durable/failed 观测 → 原有告警消费者。内部 pending 不发给消费者。模型权重、输入尺寸、审核提示词、阈值和触发规则均未改动。

- 复用原有单个证据 worker，最多 8 个排队任务，活动任务也计入 256 MiB 像素额度。必需证据仅在队列/额度饱和时可取消地等待容量；不因暂时繁忙丢弃。正常关闭排空已接受任务，停机取消的帧不发布为缺证据观测。
- 图片与元数据仍执行文件 fsync、原子 rename、目录 fsync，成功回执只发生在完整持久化之后。观测 FIFO 不允许后帧越过前帧，异常回执只能标记 failed。
- 证据目录约每秒扫描维护一次，写入前保守预占容量，失败后重新扫描。未 ACK 或仍被 pin 的证据不按超时删除。
- 消费者的 pin 使用同目录已 fsync 的不可变 `.pin-anchor` 文件的硬链接，一批链接完成后同步目录，再准备 Mongo pending。每个 pin 的通道所有者和租约代次文件名不变；旧工作者仍不能释放新代次的 pin。SSD 必须支持硬链接（本机为 ext4）；失败时拒绝准备，不退回不可靠保存。
- 消费成功后的日志删除按通道一批（最多 100 条）同步目录。只删除已可靠消费或明确不适用的记录；突然断电若删除回滚，原有 offset/checkpoint 幂等重放，不重复产生告警。目录同步错误仍可见；失败目录进入待同步集合，即使目录已空也继续重试，成功后仅清除对应的同步故障，不覆盖其他来源或消费故障。
- `review_frame_offer` 现在统计提交和饱和背压，不是落盘耗时；完成延迟看 cache `completion_mean_ms` / `completion_max_ms`，并结合 `backpressure_waits`、`failed`、`queue_full_dropped`、`maintenance_scans`。

### 验收与边界

7 个软件缓存场景、4 个异步日志场景通过。独立临时 Mongo 上相关测试 22 通过、0 失败、1 条缺原生夹具测试跳过；覆盖 pending 恢复、租约 fencing、保留标记、失败保护和批量删除重放。JPEG 软件测试用 stub，不代表硬件功能通过。两轮真实观测分别核对 107 和 191 条证据，图片哈希、帧号、会话和尺寸一致，无 failed/pending 外泄。

生产者与消费者均部署后的 5 分钟窗口：按计数差吞吐 9.43 FPS，滚动 FPS 中位数 9.42（范围 8.70–10.00），提交耗时窗口均值的中位数 0.05 ms，保存 2834 帧证据，丢弃/保存失败均为 0。消费积压由 557 条降至 0，随后一分钟 7 次采样均为 0；该一分钟按计数差吞吐 9.43 FPS，仍零证据丢弃/失败。17 个服务运行，健康模块无异常，未观察到新的 OOM/BPU/磁盘错误。

并行审核和存储抖动仍会导致短时 FPS 波动，不宣称锁定 10 FPS，也未认证多路/8K/24 小时容量。先行版本启动时有 15 次队列拒绝，已用可取消背压修复；中间版消费积压也已消化，原始失败/过渡记录保留。维护暂停 LLM 时导致的一条 `review_unavailable` 已经通过现有重试函数、按部署时间范围重入队，未改人工结论或模型分数。

证据：`test/results/bpu-pipeline-20261107/` 中 `baseline.json`、`complete.json`、`consumer-final.json`、`consumer-steady.json`、两轮 `evidence-integrity*.json`、`publication-final.json` 和测试日志。AI 二进制 SHA-256：`f9b390260d68f155471b4801d05f4f29de254b7ef1012ecf2b07143d2acc4e9c`。
