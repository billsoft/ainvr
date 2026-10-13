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
