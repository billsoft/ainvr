# S100P 模型交付与加速状态

工作目录：`/home/sunrise/ainvr`。此文记录当前实际部署；编译流程与复验要求见 `S100P-HBM-COMPILATION.md`。


## 最新生产状态：归档流水线优化交付（2026-10-13 下午）

四模型文件/契约未改。最新部署、实流性能和回归证据以 [S100P-NV12-SHARED-CROP.md](S100P-NV12-SHARED-CROP.md) 为准：NV12 直读、共享 GPU 裁剪执行器、JPEG 分段计时及真实归档等待计时已上线。两源帧上限保留，未降低截图数量、尺寸或质量。最终同配置实流约 21.30 FPS/174.03 目标每秒，峰值 RSS 约 624MiB；未宣称全程零拷贝或 BPU 已满载。最新二进制 SHA `d2b138594b8ca7bf36c6e8060abda0165cb774d07e1ec7710b31e302691c21a5`。最后预热后三分钟发布区间未新增 SEI 迟到，原有冷启动/旧观察中迟到事实保留。

## 历史生产状态：裁剪资源复用（2026-10-13 13:08）

该阶段生产 SHA-256：`ec9df2d20ab90ac869edb5903e2511fe1a1d2bc9286ed83dcae7d09adff7951d`。相同 ERP 配置短时实流从 17.72 到 18.56 FPS，BPU 53.68% 到 57.32%，平均归档延迟 122 到 112 ms；峰值 RSS 增约 162 MiB，最近 P95 未改善。22 项 GPU、11 项硬件归档、62 项业务回归通过，最终三分钟无归档丢弃/SEI 迟到/发布丢帧。细节和共享上传实验限制见 [裁剪资源复用](S100P-CROP-RESOURCE-REUSE.md)。HBM、模型阈值及截图保留策略未改，不代表性能已达极限。

## 较早生产状态：ERP 截图与系统体检（2026-10-13 12:22）

该阶段部署 SHA-256：`493cfdce4848c87ee24c3ffaa68918966df4f030382ea11374d41172f2777557`。截图设置为 `erp_equirect`，GLES 执行 ERP 到普通视角的目标截图，BPU 推理、JPU 编码。五分钟实流 17.55 FPS、144.23 目标/秒、BPU 51.67%；归档无丢弃或写库错误，检查窗口录像文件/索引正常。启动前五秒仍有一次 SEI 迟到，之后未增加，不能称所有边界问题已解决。系统盘恢复约 13 GB 可用，录像索引已迁 SSD。完整限制、回退与验收见 [系统体检](S100P-RUNTIME-HEALTH.md)。

## 较早生产状态：普通截图归档流水线（2026-10-13，已被上节替代）

该轮主通道开启普通截图，HBM 未变；使用 4 个归档线程的优化版。
三分钟实流：19.56 FPS、159.91 个目标/秒入库、BPU 平均 56.14%，峰值 RSS 约 1.32 GiB。
6 线程反而降到 18.31 FPS、内存约 1.71 GiB，已撤销。后台图像所有权、GPU/JPU 流水线、避免重复编码及容量唤醒修正见 [截图归档优化](S100P-ARCHIVE-PIPELINE.md)。
该轮二进制 SHA-256：`755755ab5e065b4f5f14d70b1c78740e4a59ecf42b932983fc26e967e0d332a3`。
主要证据：`test/results/archive-pipeline-selection-20261013.json`。归档没有丢弃/故障，但三分钟含 6 次 SEI 迟到，排除前 30 秒后 2 次；发布器没有重连，不能宣称 SEI 零迟到。
下文约 30 FPS 的生产记录是**关闭截图时的历史基准**，不代表当前开启截图的完整链路。

## 当前已部署四个模型，原生服务和网页接线已验收（2026-10-13）

当前以本节及文末交付验收为准；下文编译 PID、失败候选和“未接入”段落是研发历史，不是仍在等待的任务。YOLOE 使用原生 BPU 文本编码及完整检测路径，可在网页改描述而不重新编译。使用方法和复现入口见 `S100P-YOLOE-DYNAMIC.md`。

| 模型 | 实际文件 | 原始 BPU 推理速度 | 质量依据 | 实际接线 |
| --- | --- | ---: | --- | --- |
| YOLO26x COCO80 | `ai-service/models/derived/s100p/yolo26x.hbm` | 35.8293 FPS（O2） | O0 的 128 张 FP32 对比 precision 96.93%、recall 96.41%、IoU 98.39%；子集 AP50 0.744677；O2 的 128 个输出与已验收 O0 完全相同 | 已替换 O2，原 4K 通道恢复，SEI 继续运行；当前截图已开启，归档性能见上节 |
| YOLO26x-face | `ai-service/models/derived/s100p/yolo26x-face.hbm` | 35.6082 FPS（O2） | O0 的 128 张 FP32 对比 precision 99.29%、recall 98.59%、IoU 99.36%；O2 的 128 个输出与已验收 O0 完全相同 | O2 人脸检测、GPEN、JPU/MongoDB 实流及原图/增强图网页查看已通过 `three-model-final-audit-20261012.json`；当前主通道保持 COCO |
| GPEN256 | `ai-service/models/gpen_bfr_256.hbm` | 92.7491 FPS（O2） | 原 O0 的数值 FP32 对比未过门槛，用户已明确视觉验收；O2 与已验收 O0 的 128 个原始输出数组完全相同 | 人脸归档流水线实际使用，原图和增强图可查看 |
| YOLOE-26x 动态描述 | `ai-service/models/derived/s100p/yoloe-26x.hbm`（另有文字/RepRTA HBM） | 检测张量 39.48 FPS（O2，生产并行）；流水线优化后真实 4K 单通道 29.76 FPS（30 FPS 源，截图关闭） | 新独立 128 图完整 BPU 文字→RepRTA→检测与原 FP32 的 precision 95.95%、recall 95.15%、IoU 98.05%；四个预定自由描述案例全部最终框通过。原逐网格误差检查仍失败，原模型漏检仍保留 | 网页正常向导保存、`person`→`an airplane` 运行时改词、真实 SEI 回读通过；原生生产 Worker/Store 在独立历史集合验证 20 条 GLES/JPU/Mongo 归档 |

纯推理测速均不包含解码、图像转换、截图和数据库时间。GPEN 的小图归档流水线吞吐约 75.25 张/秒，也不是整路 4K 视频帧率。2026-10-13 流水线优化后，生产 COCO 目标已通过正常网页向导从 15 改为 0（跟随源流）；30 FPS 固定采样的两分钟均值为 28.55 FPS，因此该次纯推理验收使用跟随源流模式，截图当时关闭，录像已恢复。旧约 9 FPS 是优化前历史结果；独立真实 4K 实流 COCO 29.98、Face 30.02、YOLOE 29.76 FPS。生产持续观测数据见 `test/results/throughput-production-final-20261013.json`，实现、局限及回退见 [推理流水线优化](S100P-INFERENCE-PIPELINE.md)。本次 HBM 与描述文件共 10 项哈希未变，三个检测模型各 64 次完整输出逐项一致，服务更新至 0.14。

证据：`test/results/coco-channel-deployment-20261012.json`、`face-channel-deployment-20261012.json`、`gpen-O2-optimization-20261012.json`、`ui-hbm-workflow-20261012.json`，以及实际播放截图 `test/results/coco-ai-live-monitor-20261012.png`。每个 HBM 配有校验哈希与实际张量接口的 `.hbm.ainvr.json`。

## O2 编译历史（已完成，见文末最新复验）

- 人脸 O2 使用已通过质量验证的同一 BC `da28efe1b09b396020260f421531734b418d99047ee5003dbf3bd4ec9588795c`。CPU 容器实际编译 PID 3267。原两小时 GNU timeout 包装进程 3266 已单独停止计时，编译仍正常运行，未重新开始；六小时检查期限与 PID 身份记录见 `test/results/face-o2-deadline-extension-20261012.json`。
- COCO O2 使用通过质量检查的新 BC `8453c9764a623ffd4c792f7404ae6c78bd51e35bf6c83f9bd1cba86ebc1e9fb5`，GPU 工具链容器 `compiled-coco-approved-o2-v9`，实际编译 PID 6151，包装进程 6150，四小时期限。GPU 镜像不代表最终编译器所有阶段都由 GPU 执行。
- 完成后必须重新比较输出并板端测速。只有正确且有收益才替换生产版本，不能把旧未通过质量检查的 COCO O2 候选直接部署，也不能将 GPEN 的提升倍数预设为 YOLO 的提升。

## YOLOE 动态路径研发历史（当时尚未接入，已被文末交付取代）

最新目标已改为四个必需模型，包括 YOLOE-26x 的开放词汇能力。当前生产已有前三个，网页新建选择仅开放 COCO80 与人脸检测；GPEN 位于人脸归档增强设置。YOLOE 验证未完成前不开放新选择，不能把固定词表或向量缓存冒充动态自由文字识别。

[Ultralytics 官方说明](https://docs.ultralytics.com/models/yoloe/)指出，标准 ONNX 等静态导出会将设定类别写入权重，不能在加载后的导出模型上随时更换文本描述。预先设词导出是固定词表部署，不满足当前 UI 的动态描述语义。动态 BPU 方案需要单独处理文本编码、文本特征输入、模型接口与验证；当前生产适配器只完成 YOLO26/YOLO-face/SCRFD 的接口检查，`yoloe_bpu` 尚不能执行，亦无已验证的动态词汇 HBM。

这仅说明标准静态导出及当前生产适配器的限制，不意味着必须放弃。新证据如下：

1. 原始 YOLOE-26x 权重（SHA `d08d390a08f98195f7c87807839fe4ff93a5491645fef1bc3bf0700efafdd639`）已经导出完整双输入 ONNX：图像 `[1,3,640,640]`，提示向量 `[1,8,512]`，检测输出 `[1,12,8400]`。同一 ONNX 更换两组向量后输出分数发生变化，与原始 PyTorch 前向对齐。MatMul 等价改写最大误差约 `7.92e-9`；ONNX 与 PyTorch 最大绝对误差约 `0.003006`（检查同时使用相对误差，不能声称所有值绝对误差都小于 0.002）。见 `test/results/yoloe26x-runtime-prompts-onnx-20261012.json`。
2. 双运行时输入 MatMul 小模型已编译成 Nash-m HBM，实际 S100P BPU 上加载同一文件、不重编译，替换向量后输出变化。两组与浮点参考的余弦约 `0.999938`、RMSE 约 `0.0028`，算子 placement 全部 BPU。该实验仅验证动态输入和匹配算子，使用合成数据，不是完整 YOLOE 的识别质量验证。即使请求全 INT16，实际 MatMul 输入 lowering 仍是 `si16/si8` 混合。见 `test/results/yoloe-runtime-prompt-bpu-matmul-script-20261012.json`。
3. 固定输入形状不等于固定词汇内容：例如一次最多 8 个词，可以更换这 8 个向量。需要维护有效词数量、忽略空槽、同步类别名称与提示版本；超过槽数要分组处理或另编容量版本。一次最大数量是接口约束，不是固定 8 个单词。
4. 任意新文字还需匹配的 MobileCLIP2-B 文本编码器及 RepRTA/归一化。只保存一批向量供板上切换是向量缓存，不能冒充任意自由文本。按照当前 BPU-only 约定，板端神经网络文本编码也须验证 BPU 路径；字符串分词等逻辑可用 CPU。仅替换成另一个 CLIP 编码器，不能保证语义空间相容。
5. 剩余工作：完整双输入 YOLOE 校准/编译/placement、真实文本和独立图像准确率、文本编码器 BPU、微服务多输入接口、原始框/类别分数后处理、提示缓存及版本同步，最后再开放 UI。小算子 HBM 不能安装成生产 YOLOE，也不能把 ONNX 的通过标记为完整 HBM 通过。

复现脚本在 `test/model_conversion/probe_yoloe_runtime_prompts.py`、`probe_bpu_dynamic_prompt_matmul.py`、`validate_runtime_prompt_matmul.py`。大产物存放 SSD `/mnt/ainvr-ssd/model-compile-candidates/yoloe-dynamic-research-20261012`，本机只作已授权的编译缓存。原始权重只读，现有生产链路不受试验改写。

来源：[官方动态输入提案及其它 NPU 的验证](https://github.com/ultralytics/ultralytics/issues/25530)；[最终合入的静态向量保存/加载功能](https://github.com/ultralytics/ultralytics/pull/25572)。前者的双输入参考实现没有作为此 PR 的动态运行接口合入；不要把 issue 关闭或 PR merged 解释为官方标准导出已支持动态词汇。

### 真实文字与文本编码器的后续验证

- 使用原始 `mobileclip2_b.ts`（SHA `35d7f213e4d75f38514e4656ad3cb91158bd33e3805d8ac349f23b186f66982f`），官方 CLIP BPE 分词器以及对应 YOLOE 权重的 RepRTA/归一化，生成“person/bus”和“dog/car”两组向量。同一双输入 ONNX、同一图片可更换词汇。两张独立用户 COCO 图片、四次组合与原始 PyTorch 对比：最大框坐标误差约 0.0168 像素，最大概率误差约 3.48e-5。
- 公交车样本的 bus 置信度 0.89317；另一词表 dog/car 在同图概率很低。狗样本的 dog 概率 0.243745，未达到 0.25，原始 PyTorch 也如此；未降低阈值来把该样本标为成功。报告 `test/results/yoloe26x-real-text-switch-20261012.json` 保留此失败，这不是整体准确率验收。原始 blanket allclose 在近零坐标上失败，也保留了事实；后来采用明示的 0.05 像素及 1e-4 概率上限，未修改既有 BPU 量化模型的验收门槛。
- MobileCLIP2 文本编码器已导出固定 `[1,77]` token 输入、`[1,512]` 输出 ONNX，四个真实单词与原始 TorchScript 的最大误差 2.6822e-7。导出修复仅包括固定 packed-QKV reshape 的 rank 信息，以及 token ID 的 EOT ArgMax 前精确 FP32 cast（合法 ID 0..49407）；源权重未改动。参考输出通过，不代表 BPU 编译或准确率通过。报告 `test/results/mobileclip2-text-onnx-20261012.json`。
- 文本编码器 HBM 候选正在独立编译：CPU 容器 `ainvr-int8-datasets-20261012`，`/work/ainvr-int8/mobileclip2-text-int16-v1`，原始 wrapper PID 3545、实际 Python PID 3546，2 小时期限。512 条真实类别名及短语，64 个类别×8 种表达；排除 person/bus/dog/car 四个对比词。因模型 batch 固定为 1，工具链自动 batch=8 试跑出现 reshape 不匹配后退为 batch=1；保留日志，只有最终终态与有效产物才能计成功。
- 编译前将 12 个因果注意力掩码常量中的负无穷换为 -10000；四个保留单词与未改写 ONNX 的输出差为 0，源模型保留不改。明确拒绝文本嵌入查表、LayerNorm、注意力等神经网络 CPU 回退，只可能允许精确 EOT token 索引逻辑的 CPU 操作。此候选尚不包含 RepRTA，后续还须把对应 RepRTA 放入 BPU 路径；不能在板端用 CPU 神经网络补齐。
- 新复现脚本：`test/model_conversion/check_yoloe_text_prompt_semantics.py`、`export_mobileclip2_text_onnx.py`、`compile_mobileclip2_text_candidate.py`。检测器和文本编码器 ONNX 大文件已校验存入 SSD 研究目录；生产 `ai-service/models` 没有安装这些未验证候选。

### 最新 GPU 迁移状态（优先于上面的历史 PID）

- 用户明确要求关闭 CPU 镜像编译并启动两个 GPU 容器。已停止 `ainvr-int8-datasets-20261012`（原 face PID 3267、text PID 3546 均不再运行），以及只用于失败质量 COCO 诊断的旧 `ainvr-oe370-gpu-face-20261012`；保留容器文件系统。不要依据它们静态状态文件中的 compiling/converting 重启旧任务。
- 校验并保存 face BC、4372 个缓存目录条目，以及文本 512 短语校准后的 PTQ（SHA `49d20509db2ed4bd746a87150ad3054de0e126452329cef824fd7d3b0b4457eb`）；迁移不必重新校准。缓存可尝试复用，不保证从旧百分比续跑。
- 新 `ainvr-gpu-face-o2-20261012`：GPU 镜像、RTX 4090 可用，8 CPU、16 GiB RAM、20 GiB RAM+swap；`/work/face-o2-gpu-v2`，timeout PID 52 / Python 53，`jobs=4,opt=2`，同一已验证 BC 并导入旧缓存。6 小时期限。COCO 的既有主 GPU O2 任务继续运行。
- 新 `ainvr-gpu-yoloe-20261012`：GPU 镜像、RTX 4090 可用，8 CPU、14 GiB RAM、18 GiB RAM+swap。`text-hbm-gpu-o2-v2` 从保存 PTQ 继续，已终止于明确的接口检查，没有生成 HBM：`hbir.index` 单次表长上限 32768，而原词表 49408 行，导致 `/Gather` 神经网络查表回退 CPU，因此拒绝。词表将尝试等价拆分；INT64 token 输入和 EOT 索引精度也须修正并验证，不能放开 CPU 查表绕过检查。
- 本机内存监控 PID 102580，状态 `gpu-migration-20261012/memory-guard-status.json`。同时检查 Docker VM 可用内存、两新容器的限额余量和显存；VM 余量低于 6 GiB、容器限额余量低于 3 GiB或显存余量低于 2 GiB 时暂停新任务。暂停不会释放已有分配；持续危急或暂停 10 分钟后停止对应任务释放内存，保留中间产物。恢复要求 VM 余量超过 10 GiB、显存超过 3 GiB、容器限额余量超过 3 GiB。现有 COCO 和挖矿程序不属于此监控的操作范围。
- 后续新模型仍遵守 O0 验证后同一 BC 编译 O2、板端复验，再接线。GPU 可用不代表所有编译阶段都使用 GPU，也不保证线程数增加时成比例提速。

### 最新复验和部署（2026-10-12 约 22:24，优先于历史进程记录）

- COCO O2 完成，原 PID 6151/6150 已结束。HBM SHA `65e2cd362771a616c39a5d55b5fd520cb8a0f78112bd389a284179effd75948d`。128 张板端原始输出与已验收 O0 逐位相同，类别严格整数；同次测速 O0 11.0755 FPS、O2 35.8293 FPS，3.2350 倍。已安装并恢复原通道，15 秒实际观察推理及 SEI 计数增加。报告 `test/results/coco-O2-optimization-20261012.json`、`coco-O2-deployment-20261012.json`。
- Face 新 GPU O2 完成，PID 53/52 已结束。HBM SHA `e0dd6c95cddc25e01e5e482da968fc82688e1410362e92e78e13417d8379b0d7`。128 张与 O0 逐位相同；同次测速 O0 11.1217 FPS、O2 35.6082 FPS，3.2017 倍。已安装模型，主通道保持 COCO。首次安装脚本遇到旧人脸 manifest 没有 validation 字段，已自动回滚；修正兼容字段后再次安装成功，失败记录保留。报告 `face-O2-optimization-20261012.json`、`face-O2-deployment-v2-20261012.json`。不能把主通道 COCO 的计数当 O2 人脸实流证明。
- 两个优化版本的 O0 与 manifest 均备份 SSD `/mnt/ainvr-ssd/migration-backups/`；没有重新校准。新复验与安装脚本 `test/model_conversion/compare_hbm_optimization.py`、`deploy_verified_hbm_optimization.py` 可复用。
- 文本 split lookup O0 已生成 HBM（SHA `3c743e8e215cd3058490a9b980cffe336f332e8d23c1fc245491b2167bb6d03f`，BC `d35e839cf551d0921269bc5c0dd5cd5d1cd8ee39585d9ba3b2e3ddf58f3c5191`）。实际 SDK 输入 INT32 `[1,77]`、输出 FP32 `[1,512]`；只有三项整数索引 CPU 操作，神经网络没有 CPU 回退。但 **128 条独立词/短语准确性失败**：平均余弦 0.20466，最低 -0.22649，最大相对 L2 1.566；约 84.62 FPS 是生产同时运行的测速，不能凭此接入。报告 `test/results/mobileclip2-text-hbm-128-20261012.json`。原 FP32 改写仍准确，PTQ 单词 person 离线余弦约 0.013，确认量化模拟已经失真，不只板端执行问题。
- 文本下一候选 `ainvr-gpu-yoloe-20261012:/work/text-sensitive-float-v5`，timeout PID 1910（6 小时），实际 Python PID 需从当前进程核对。脚本 `probe_text_sensitive_precision.py` 复用 512 条校准统计，依次诊断浮点 LayerNorm/Softmax 等敏感运算；保持既定每条余弦 >=0.995、相对 L2 <=0.1 的 128 条独立检查，未通过不编译，神经网络落 CPU 则拒绝。仍仅文本编码器，不含 RepRTA 或完整 YOLOE。不得继续优化/部署失败的 v4 BC，也不得降低门槛冒充通过。
- 内存监控继续运行。约 22:19 Docker VM 可用 29.28 GiB、显存空闲 17822 MiB，新任务无暂停/停止事件；编译完成释放内存。仍保留 6 GiB VM / 3 GiB 容器余量的暂停阈值，持续危险则停止对应新任务；不触及挖矿。

#### 文本敏感精度诊断的最新进展（约 22:27）

`text-sensitive-float-v5` 已结束：把 LayerNorm 保留 FP32 后，128 条离线独立短语达到最低余弦 0.997496、最大相对 L2 0.07077，既定门槛通过。但 25 项 LayerNorm 的 FP32 Sub 被工具链放到 external_cpu，因此按 BPU-only 要求拒绝，未生成新 HBM、未部署。记录 `test/results/mobileclip2-text-float-layernorm-placement-failed-20261012.json`。这是量化敏感性定位证据，不是 BPU 通过。

下一任务为 `ainvr-gpu-yoloe-20261012:/work/text-sensitive-fp16-v6`，timeout PID 1996，6 小时限制，`jobs=4,opt=0`；实际子进程及终态须重新核对。用相同脚本 `--sensitive-dtype float16`，保留同一 512 校准统计、128 独立门槛和神经 CPU 回退拒绝规则。不要重新运行 v4/v5 失败候选，不得把离线通过作为板端通过。成功后需实际文本 HBM 128 条复验，再同 BC O2。

约 22:26 主通道 `yolo26x` 实际 8.99 FPS、state running，截图开关为 false，保留当前配置；健康接口 business.ready=true。不要依据旧报告擅自恢复 5 FPS 或打开截图，也不要把这次保存的 COCO 通道运行状态当作 O2 人脸实流验收。

### 三模型交付优先级与最终接线验收（2026-10-12，优先于上面历史状态）

用户最新要求先彻底完成 COCO80、人脸检测、GPEN256 的服务与前后端，YOLOE 放到最后，不阻塞三模型交付。文本 v6 全 FP16 的独立精度检查失败；v7 混合精度通过 128 条离线检查（最低余弦 0.997347、最大相对 L2 0.072833），仍有 LayerNorm Sub 神经运算 CPU 回退，拒绝。两任务已终止，保留文件，不盲目重启、不部署；当前没有需等待的 YOLOE 编译。

- 人脸 O2 通过正常网页向导选择，保留 `live/xm` 和既有 `live/ai-n2q08c` 输出记录，保存成功；真实 3840×1920 H264 源与 SEI 输出运行。开启归档后 GPEN O2、GLES、JPU、MongoDB 连续运行，整链路约 7.03 FPS（目标 15，不能将 35.6/92.7 的纯推理 FPS 作为整链路 FPS）。实际记录 `test/results/face-O2-gpen-live-archive-final-20261012.json`。
- 发现真实小目标的宽仅 15/16 像素，原 JPU 17 像素可见尺寸限制使 23 项归档隔离。修复在 `snapshot_processing.cpp` 进入 JPEG 之前用 `EnsureSnapshotJpuCanvas` 做 GLES 边缘补齐，原有像素逐位保持，原图与处理图都使用正确编码尺寸。JPU 本身的尺寸检查继续保留，没有 CPU 图像处理回退。
- 新原生服务 SHA `9e7b8b10babea3e8d0cf23d40b793327ca197dc8ffac1b5be599ee7017e2b7a6`，用事务安装器部署 `ainvr_s100p_control_service`，已重启且业务就绪；没有使用含 ONNX CPU 运行库的参考可执行程序。版本仍为 0.12，精确身份以 SHA 为准。记录 `three-model-final-ai-deploy-v2-20261012.log`。
- 小图 JPU 12 项通过；完整归档回归 8 项、原业务 62 项、GPU 裁剪质量 19 项通过，实际服务用户 sunrise，使用独立测试库和 SSD。证据 `hardware-archive-20261012-225521-2006851/summary.json` 与 `three-model-final-snapshot_jpu_test-20261012.log`。测试报告明确说明图像夹具不包含用户模型推理，不能将它单独作为全链路证明。
- 23 个旧隔离文件先逐个校验和备份至 SSD `migration-backups/tiny-quarantine-before-replay-20261012`，再交给原生产 pending 恢复与删除意图逻辑处理，没有直接向数据库注入记录。新服务复验：pending=0、bad=0、quarantined_bytes=0、faults=[]，增强与保存持续增加。保留清单和复现脚本 `test/ai_port/recover_tiny_quarantine.py`、`test/results/tiny-quarantine-{inventory,replay}-20261012.json`。
- 前端保留原业务接口，新增大图“原图／增强图”切换；原图请求已有 `variant=original`，旧记录没有原图时显示明示缺失，不用增强图冒充原图。真实网页同一记录的原图 62×62 和增强图 256×256 都加载成功，截图 `test/results/face-original-ui.jpg`、`face-enhanced-ui.jpg`。
- 编辑向导原先只在新建模式刷新在线列表，未查询的空列表会被显示为“离线”。现改为打开/选通道时刷新，避免周期状态更新反复初始化；将加载中、未知/失败、离线分开表示。主动刷新已证实同页 `live/xm` 与 AI 输出都在线，后端接口本身正确，没有替换成熟 SRS 业务实现。
- 原始用户配置备份在 SSD `migration-backups/three-model-ui-audit-20261012/channel-before.json`。已通过正常网页向导及归档开关恢复 COCO80、15 FPS、snapshot=false；API 将整个配置对象与备份逐字段比较完全相同。验收阶段的人脸/归档设置是临时测试，已有记录保留并遵守原滚动额度。
- 最终前端 74 项相关测试及生产构建通过。打开编辑向导无需手动刷新，两条流自动显示在线；最终监看原流和 AI 输出均 3840×1920、video.readyState=4，时间从约 108/107 秒推进至 169/168 秒，AI 识别框控制处于开启。证据 `test/results/monitor-browser-state.json`、`three-model-live-monitor-ui.jpg`。
- 三模型要求逐项审计见 `test/results/three-model-final-audit-20261012.json`：first_three_delivery_verified=true、full_four_model_goal_complete=false。COCO 在新服务上也有真实归档新记录及 SEI 输出，详见 `coco-O2-live-archive-final-20261012.json`。前三已可交付，YOLOE 后置研究，不把前三交付声明为四模型全部完成。

### 2026-10-13 三模型运行复核与后置 YOLOE 状态（优先于旧进程记录）

- 三个生产 HBM 和原生服务的 SHA 与最终交付审计一致。`ainvr-ai` active，`127.0.0.1:8000/health` ready=true、license valid、仅 BPU provider。实际 `/api/v1/channels` 中大门 running、COCO80/目标 15 FPS/snapshot=false，推流与 SEI 正常，实测约 9.21 FPS；源约 30.02 FPS。没有更换用户模型或开启截图。
- 后置研究的完整双输入 YOLOE 检测器 O0 候选已经编译完成：`ainvr-gpu-face-o2-20261012:/work/yoloe-detector-int16-v1`，原 PID 30453/30452 已为历史身份。HBM SHA `388368ada021a6d23af434e3d25201f2e7c3eb857cbdddc16ca913f3fd3514e4`，BC `c58207fadb28675bf84de4cd6647612aad1c2c4c202fdc01427da9a90b10da06`。512 张真实 COCO 图片搭配变化的八槽提示向量校准，advice 无 external_cpu。**尚未完成板端 128 张独立检测质量验证，不批准生产，不开放 UI。**
- 匹配 RepRTA 的 `floatnorm-maxmin-v3` 候选同样已终态完成，原 PID 32694/32693 已为历史身份。将浮点 Clip 等价改为 Max/Min，保留神经运算全 BPU；HBM SHA `1b8ae9745c991e824c28d0aafa23266ca9407a91d17d56eda693b397a0e159ed`。在板上以原始 FP32 编码器的 128 个保留向量验证：最低余弦 0.998953、最大相对 L2 0.045750，既定门槛通过；约 402.75 批/秒，每批八槽，生产同时运行。报告 `test/results/yoloe-reprta-floatnorm-maxmin-v3-heldout-20261013.json`。这只验证 RepRTA，不能代表 BPU 文本编码器或完整动态词汇链路通过。
- 文本编码器 v9/v10 均已结束并生成 HBM，但实际 BPU 准确性未通过，不部署、不编 O2。v9 的 128 条调试集最低余弦 0.991482、最大 L2 0.130517；另一 128 条保留集最低余弦 0.993526、最大 L2 0.113786，约 49.93 次/秒。v10 FP32 Add/Mul 等价居中候选调试集最低余弦 0.988064、最大 L2 0.154498，约 47.66 次/秒。三项整数 token 索引逻辑允许 CPU，神经运算没有 CPU 回退，但速度与 placement 不能代替准确性。v9 保留集已观测，不应再作为未触碰的最终独立集。
- 新检测器和 RepRTA 候选校验存放 SSD `model-compile-candidates/yoloe-dynamic-research-20261012/{detector-int16-v1,reprta-floatnorm-maxmin-v3}`，没有装进生产 models。GPU 镜像上的校准和最终编译任务目前均已终态；不要根据旧 PID 或静态 compiling 启动重复任务。下一步是检测器板端接口/独立质量验证、文本注意力精度定位，再完成双输入适配、真实自由文字与 UI。
- 内存守护最后状态仍 monitoring、无暂停或停止事件；Docker VM 可用约 29.29 GiB、显存空闲约 21 GiB。守护有六小时期限，下一长任务前须检查存活与剩余期限；原生产、录像和矿工不在操作范围。

### YOLOE 后置进展：完整检测与真实文字 BPU（2026-10-13 约 00:58）

- 原检测器 v1 已实际测试 128 张，分类分数全部为零；量化模拟也同样失败。根因是空词槽的 L2 epsilon 产生约 1e12 的倒数，INT16 倒数统计把正常词槽的倒数约 1 量化成零，并非服务或 UI 故障。失败报告 `test/results/yoloe-detector-int16-v1-parity-20261013.json` 保留。
- `detector-float-prompt-norm-v2` 复用原 512 图校准，把词归一化中间结果保留浮点 VPU，Clip 等价改为 Max/Min，最终向量仍供整数 BPU MatMul。HBM SHA `826217554dc56afd39a1553246a2c854b827b5267bfe7e8398b47afd3e11cd1b`，BC `6fe8f2842ff511569a8b7e9af95d8bee2f8d6b44e9c08ac779da708cc00418f8`。**完整检测器 128 图 FP32 对比通过**：624 个参考检测、625 个量化检测，precision 0.9712、recall 0.972756、匹配 IoU 0.980457；10.80 纯推理 FPS，生产同时运行。`test/results/yoloe-detector-float-prompt-norm-v2-parity-20261013.json`。这一步仍输入 FP32 oracle 词向量，不是全 BPU 文本链路验收。
- 文本 v11 将掩码/Softmax 全浮点后 128 离线通过，但 Exp 和后续 MatMul 神经运算 CPU 回退，已明确拒绝。v12 保留浮点 LayerNorm 与 mask 加法/最大值，把稳定 Softmax 的差值限制在 [-16,0] 的 INT16 精度并使用原生整数 Exp/MatMul；不改变输入词、权重、置信度门槛，不重做校准。v12 HBM SHA `07361a88ee6c629086020389b078ca53410fcbacbef8cd935fc7266c489b1f50`，BC `84c7648b3531d095542c1667653c2e2baff8d30d97565ff6a810bb200684db4a`，神经网络无 CPU 回退，仅三项整数 token 索引逻辑。
- v12 实际 BPU 调试 128 短语通过（min cos 0.997251、max L2 0.074142）；另一个预先确定、无校准或旧验证词句重叠的 128 条最终保留短语也通过（min cos 0.997376、max L2 0.072437、约 43.50 次/秒）。新保留短语包括叉车、消防员、安全帽、输送带等非 COCO 自由描述。报告 `mobileclip2-text-bounded-softmax-v12-{tuning,final-heldout}-20261013.json`。不能把编码向量准确性当作这些目标都已在真实图片中被正确识别。
- 生产适配源码已补上**按名称传入辅助浮点张量**，不假定图像在第零输入；验证形状、SDK 字节步长、缺失/未知/重复名字、有限数及内存边界。原单图/NV12 路径保留。`bpu_image_input_test` 10 项通过，原生控制服务与 image probe 完整编译通过。`test/ai_port/yoloe_bpu_tensor_probe.cpp` 用真实完整 HBM、同图换两组向量，原生输出与 Python 官方 runtime 逐位相同，分数变化约 0.7614。此代码尚未安装替换生产服务，生产仍为前三模型已验收的 SHA 9e7b8b10...。证据 `test/results/yoloe-{multi-input-tests,native-named-inputs}-20261013.json`。
- 分词逻辑使用不含 Torch 依赖的 OpenAI CLIP MIT 原始实现，与前述原始文字参考的 128 组 token 逐位一致；ftfy 6.3.1、regex 2026.9.29 与 host oracle 版本相同，SSD 独立环境，无神经网络库。原 Ultralytics 参考文件及其 AGPL 许可证保留；没有将其来源错误标为 AINVR。MIT 来源/文件哈希在 SSD `clip-tokenizer-mit/provenance.json`。分词及 token 索引是 CPU 逻辑，所有神经网络均 HBM/BPU。
- **全三段 BPU 组合尚未达到检测质量门槛**：实际生成 80 个词向量，经 BPU RepRTA、完整 BPU 检测器，128 图与原始 FP32 对比 precision 0.967159、recall 0.943910、IoU 0.980868；recall 未达 0.95。报告 `test/results/yoloe-full-bpu-text-detector-v12-parity-20261013.json` 明确 failed。缓存仅复用本次由 BPU 实际计算的同词，不是固定向量库。不要据组件各自通过开放生产 YOLOE 或宣布任意自由文字已交付。空槽须在 learned RepRTA **之后**置零，因为其偏置使 RepRTA(0) 不为零。
- 当前真正运行：GPU face 容器 `/work/yoloe-detector-approved-o2-v3`，actual Python PID 34900/timeout 34899，6 小时；同一通过单检测器质量的 BC 6fe8...，jobs=4/O2。GPU yoloe 容器 `/work/text-approved-o2-v13`，actual PID 9581/timeout 9580，6 小时；同一通过两组 128 文本质量的 BC 84c7...，jobs=4/O2。二者仅优化已验证组件，不能解决或掩盖组合召回率失败；终态后需按同输入板端比较，不能因静默重启。
- 新精度候选 `/work/yoloe-reprta-weight-ec-v4` 在 GPU face 容器，actual PID 43375/timeout 43374，30 分钟，jobs=1/O0。调用当前 HMCT 官方 CompensateWeight，将两处 learned linear 的权重拆成高/低 INT8 分支（近似更高有效精度），保持既有 64 批/512 短语统计和浮点归一化。BC `9aebcdb7ad94824629dce019d56ee0d2234f5030c2aae08216ce27b15e377592`，placement 无神经 CPU 回退；尚须 128 RepRTA 及全链路复验，未批准生产。
- 内存守护已续期为 PID **91408**，8 小时，状态 `gpu-migration-20261012/memory-guard-status-20261013.json`；旧监控 102580 已核对身份后替换，非编译任务。最近 VM 余量约 24.97 GiB、显存空闲 21 GiB、两容器余量分别约 12.3/12.9 GiB，无暂停/停止事件。只保护既定两个 GPU 容器，不触碰矿工或生产。前三模型与用户通道配置保持已交付状态。

### 原生接线核心与全 BPU 组合首次通过（2026-10-13 约 02:35）

- 原生 `DecodeYoloeRaw` 已加入现有检测解码库：运行时类别、忽略空槽、按类别 NMS、稳定排序、letterbox 坐标恢复、异常数据检查。沿用成熟 NMS/坐标函数；7 项检测解码测试通过，包含原 SCRFD/end-to-end 回归。`test/results/yoloe-raw-decode-tests-20261013.json`。
- `ai-service/tools/clip_tokenize.py` 是有长度限制的 JSON 分词辅助程序，不含 Torch 或神经网络。128 条原始 token 逐位相同，8 类无效请求拒绝，shell 符号作为普通文字编码。`test/ai_port/validate_yoloe_tokenizer.py`、`test/results/yoloe-tokenizer-helper-20261013.json`。
- 原生 `BpuPromptEngine` 已实现：隔离环境的 posix_spawn/有界 IPC 分词、77 个 INT32 token SDK 布局、BPU 文本 HBM、BPU RepRTA、最后清零空槽。使用无 SIGPIPE 的 socket 写入、5 秒期限、只清理自身子进程，不继承服务敏感环境或解码/GPU/socket 描述符。三个实际文字组与官方 Python runtime 的最终向量逐位一致，含 person/bus、dog/car、forklift/安全背心描述；4 个错误案例有界返回。`test/results/yoloe-native-{text-inference,prompt-chain,prompt-errors}-20261013.json`。已加入 CMake，原生控制服务完整构建通过；生产二进制仍未更换。**还需要 BpuChannelAdapter 的 YOLOE/组件契约/参数绑定和 UI 接线，不能把独立探针当服务已交付。**
- RepRTA v4 权重 EC 无足够改善，全链路 recall 0.945513，仍失败。v5 在 EC 基础上给 INT16 非权重激活增加 4 倍表示范围，修复保留向量超出旧统计范围的截断；HBM `9c83212eadae6ecfe788bd2c7bc1d3c9f72c4a0565fcf0feffb842be4189fdd9`，BC `8d8f0d5033989cb52c96b02ce8a97e72f41b7b1ac5a45c2d75ebd36473f608c4`。128 原始向量的最低余弦 0.999999681、最大 L2 0.000799251，通过；v12 文字组合仍 recall 0.945513。不能单凭这个组件通过部署。
- 文本 v14 的 24 个动态注意力 MatMul 用官方激活 EC，最终 L2 保留浮点；HBM `7e05ba982d7fc320941ec4b291d17432004d3e11c4983fe904a597db747b8b75`。两组 128 文本板端通过，但配 v5 RepRTA 的检测 recall 0.934295 未过。检测器 v6 对三处匹配 MatMul 再做 EC，HBM `279cc1b70a3e8f7f64f821b2e63860fd0ac074e5c84b51acfbad16ae066a2bfe`，全链路仍相同 recall 0.934295，保留失败，不部署。
- 文本 v15 因把已合并 QKV 的线性数量误认作 73 而在检查阶段失败；真实图为 49 个线性算子。已修正并保留失败记录。v16 的全部 49 个线性权重 EC 虽离线通过、神经全 BPU，实际板端 128 文本失败（最低余弦 0.976752、最大 L2 0.215628），明确排除。v17 继承这一失败配置，已精确终止自身 timeout 60147，未停止任何其它编译或业务任务。
- 80 类原始文字/向量逐项诊断确认 person/car 误差最大，RepRTA 会放大方向误差。全浮点校准图与原始 FP32 四词余弦均为 1，差异来自量化/实际执行；`test/results/yoloe-coco80-text-vector-diagnostic-20261013.json`。另外独立 FP32 Softmax 小算子被当前 nash-m 转换器放到 CPU（hbir.softmax 的 f32 输入不支持，只接受 si8/si16），明确拒绝。小算子失败证据不等于所有架构浮点能力都不存在。
- **文字 v18 保留整数 Exp，Softmax 的 ReduceSum/Reciprocal 保留浮点，最终概率仍进入整数 MatMul；排除了失败的 49 权重 EC。** HBM `0bd2f438e56b77f97699385966de3e7264ac7061ab35a44b9b58d6958a5d5440`，BC `2e6f845dcc295d816e255838bfebfdba583722447986f48a0067efe835d02312`。128 调试文本通过（min cos 0.998422、max L2 0.056171），之前已观测保留集的 128 条回归也通过（min cos 0.998231、max L2 0.059487、约 37.7 次/秒）。后者不能再冒充未触碰的新最终集。
- **完整 BPU 文本 v18 → RepRTA v5 → 检测器 v2 的同一 128 图终于通过既定门槛**：参考 624、实际 615，precision 0.973984、recall 0.959936、IoU 0.980616，置信度仍 0.25、NMS 0.45，未降低门槛。真实编码 80 个词，未使用固定 FP32 向量缓存替代文本网络。检测器张量推理约 11.96 FPS（不含 4K 解码/预处理/归档及每次新词计算）。报告 `test/results/yoloe-full-text-float-tail-v18-reprta-v5-parity-20261013.json`。这组图片已用于前述诊断/调优：部署前还需新的独立图像、非 COCO 自由描述的语义与原始 FP32 对比，以及服务/UI 真正接线，不宣称四模型目标完成。
- 两个组件 O2 均完成且原 PID 已终态：检测器 v3 HBM `9085fb79005892dcf9def5ca9d9043167c32373df05bff582a7e3f9489ed2ebd`，同 BC 6fe8...，128 双输入输出与 v2 O0 逐位相同，11.81→22.79 FPS（1.93 倍）；文字 v13 HBM `6ca1928a6a51fcce6ff18c651c0c1aa942e3c986fdec0548c16ed2516cda2d64`，同 BC 84c7...，128 INT32 token 输出与 v12 逐位相同，44.76→53.41 次/秒（1.19 倍）。复现 `compare_yoloe_component_optimization.py`，报告 `yoloe-{detector-O2-v3,text-O2-v13}-20261013.json`。O2 文字是旧 v12，不能当作通过组合精度的 v18 自动替代。
- 当前本轮所有候选均已编译/验证终态，无需等待旧 PID 或因静默重启。下一步优先采用已通过组合的 v18/v5 与已验证相同输出的检测器 O2，准备预先确定的新独立图片及自由描述验收、完成受契约保护的原生适配器和网页；之后只对成功 v18 的同一 BC 做 O2。仍保护前三模型和原用户通道，不更改模型/截图开关，不触碰矿工。内存守护 91408 仍负责已定两容器、8 小时限期；最近 VM 约 26 GiB 可用，显存约 21 GiB 空闲，无事件。

### 交付优先级复核与独立 YOLOE 验证（2026-10-13 约 03:06）

- 用户再次要求前三模型及服务、前后端优先，YOLOE 后置。本轮重新校验三个生产 HBM 的 SHA，均匹配原已验收产物；生产服务 ready、仅 BPU provider、COCO 通道运行且无 last_error，AI 输出及 SEI 正常。网页显示 7/7 核心服务正常，原始和 AI 输出视频均实际播放 3840×1920；向导仅有 COCO80/人脸检测，现有 AI 输出通道正确选中，GPEN256 在人脸归档设置中。未保存或修改用户配置，仍 COCO/目标 15 FPS/截图关闭。当前实流识别约 9 FPS，不把模型纯推理 FPS 当整链路 FPS。新审计 `test/results/three-model-priority-recheck-20261013.json`；前三交付通过，四模型整体仍未完成。GPEN 严格 FP32 数值失败及用户视觉验收事实均保留。
- 新的 128 张 YOLOE 最终图片在推理前确定，与旧校准/调优 640 张的文件名和内容 SHA 均不重叠，覆盖全部 80 类。manifest SHA `2dfbdd9dfc46dc94b59b8d4a6a70972b7886a2d42efe82b22bd1738893be124b`。完整 BPU 文字 v18 → RepRTA v5 → 检测器 O2 v3 与原始 FP32 对比通过：参考 598 框、实际 593 框，precision 0.959528、recall 0.951505、匹配 IoU 0.980507，仍置信度 0.25/NMS 0.45。报告 `test/results/yoloe-final-unseen-parity-20261013.json`。这是 FP32 检测结果一致性，不是官方 COCO mAP；标注虽已保存，尚未计算真实标注 AP。该次张量推理约 39.48 FPS，也不能当 4K 服务链路速度。
- `BpuChannelAdapter` 的 YOLOE 分支已实现并完成原生控制服务构建，但尚未部署：最多 8 个运行时文字，BPU 文字编码和 RepRTA、按名字传辅助向量、原始头解码/NMS、类别及 query 元数据；模型及文字组件 SHA、完整质量门槛保护。新配置先校验分词，配置变更时真实 BPU 计算向量，逐帧复用这些向量。生产仍原已交付二进制 SHA `9e7b8b10babea3e8d0cf23d40b793327ca197dc8ffac1b5be599ee7017e2b7a6`。独立探针、源码构建通过不等于服务/UI 接线验收通过。
- 四个预先确定的自由描述案例已通过原生分词 → BPU 文字/RepRTA → BPU 检测器运行。公交车描述最高置信度 FP32 0.649989/BPU 0.670268，框 IoU 0.989799；同图改为飞机/叉车后均低于 0.25，动态切换有效。原始模型对狗图的 domestic-animal 描述本身低于 0.25，继续保留漏检，未降阈值。但是新增的逐网格最大概率误差 0.15 检查在公交车案例失败（0.394093），`test/results/yoloe-free-text-semantic-final-20261013.json` 明确未通过、未批准生产；不能只取最高框宣布整体成功。
- 下一步先用生产 NMS 比较四案例的全部最终框、类别、漏检和误检，判定逐网格差异是否影响实际输出，保留原失败报告；若实际输出失败则继续修复，不能降低门槛冒充通过。`yoloe_decode_output_probe.cpp` 首次链接整个核心静态库缺失 GStreamer 依赖而失败，日志已保留，尚无可运行探针；应按实际依赖修复，不重复启动长编译。之后才进行真实适配器和前后端接线。当前没有等待中的模型编译任务，勿依据历史 PID 重启。

### 四模型实际交付验收（2026-10-13，优先于以上历史状态）

- 最终框自由描述检查完成：四案例的全部生产 NMS 输出无相对 FP32 多检/漏检，两个匹配框 IoU 0.989799/0.994828，置信度误差 0.020279/0.006769。运行时改词有效。独立测试 `yoloe-free-text-visible-20261013.json` 通过；原 `yoloe-free-text-semantic-final-20261013.json` 逐网格 gate 仍 failed，不改写、不降阈值，也不宣称任意词汇整体准确率。
- 真正 `BpuChannelAdapter` 处理了两组文字、12 帧 3840×1920 真实流，`pym+gles-color`、BPU 推理与原 NMS 正常。首次测试发现虚拟环境 Python 的 symlink 被 canonical 化，已修复；随后通过。资源 SHA、图像/提示形状、QA、超槽/超 token 等 10 个真实解析/校验案例全部通过。原生探针均已注册 CMake 并实际构建，未把空参数或仅接口存在当成功。
- 已安装检测 O2 v3、文字 v18、RepRTA v5 到 SSD，项目模型目录是 HBM 和契约链接。文字/RepRTA 神经网络全 BPU，CPU 仅分词和精确整数 token 索引。文字 v18、RepRTA v5 当前 O0，仅载入/修改文字时运行；旧 v12 文字 O2 不能替换已验证组合。产物、分词 MIT 许可和来源哈希保留，安装脚本可复用且不把研究目录装入模型目录。
- 正常网页向导选择已有输入/输出并保存 YOLOE，`person` 检测到真实行人，返回中文标签与稳定 label_id/query_description；改为 `an airplane` 后同一 HBM、同一流返回空检测并继续运行，未重编译。实际通道约 6.5–8.8 FPS（目标 10，截图关闭）。真实检测 SEI 经原发布器和 SRS 回读 3 帧，未生成伪测试检测；`yoloe-live-{person,airplane}-service-20261013.json`、`yoloe-actual-sei-output-20261013.json` 和网页截图保留。
- 真正生产 ReusedChannelWorker/SnapshotStore 在独立历史集合中完成 20 条检测→GLES/JPU→Mongo 归档，模型、文字、标签与 JPEG 查询正确；accepted=committed=20、outstanding=quarantined=0，JPU=40、CPU JPEG=0。失败 v1 数据库范围、v2 停止连接后查询的探针错误均保留，v3 修正后通过；未改变用户已有历史。`yoloe-production-worker-archive-v3-20261013.json`。
- 前端相关 99 测试通过并生产构建成功；原生 43 回归及 raw-head 元数据修正后的 Worker 19 项通过。网页保留 COCO80、人脸检测和 GPEN，增加已接入的 YOLOE，仍不开放旧 LocateAnything。YOLOE 结果明确 `end2end=false`，原闭集模型行为保留。Face manifest 的旧 O0 顶层优化/速度字段已改为真实 O2/35.608 FPS，旧值保存在 baseline 字段及 SSD 备份，HBM 字节未改变。
- 生产最终版本 `ainvr-s100p-reused-control-0.13`，二进制 SHA `a5cc2df2ca4bee11050809940466a8c79fd753fe6c31e74036cdac5a2d409159`，事务部署已验证并保留回滚。原用户通道完整配置与变更前 JSON 相等：COCO/15 FPS/snapshot=false、原输入 `live/xm` 和既有输出 `live/ai-n2q08c`；两路网页视频均 readyState=4、3840×1920。核心服务正常，录像服务未重启，GPEN 原数值失败与视觉接受例外继续保留。
- 具体部署与复现入口见 `docs/S100P-YOLOE-DYNAMIC.md`；最终逐项审计 `test/results/four-model-delivery-final-20261013.json`。本目标的四模型 HBM/BPU/原生服务/Web UI 已交付，不把进一步可选的辅助模型优化列为未完成必需编译。
