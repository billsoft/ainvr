# 阅读入口（2026-10-13）

PC GPU 环境部署、四模型最终编译步骤及问题解决，请先阅读 [完整手册](S100P-HBM-PC-GPU.md)。最终入口在 `test/model_conversion/final/`。下文保留实测与研发历史；已完成状态以 `S100P-MODEL-READINESS.md` 为准。

# AINVR S100P HBM 编译、验证与加速约定

更新：2026-10-12。适用开发板：RDK S100P，Nash-M，当前板端一个 BPU 核。

## 已验证的 GPEN256 加速结果

使用同一个已量化 BC，只改变最终 HBM 编译优化等级。板上以同一组 128 张独立 CelebA 验证输入、相同官方 HBM runtime、BPU core 0 串行推理测试；预热 10 次，推理计时不包含解码、预处理和文件读写。

| 项目 | O0 | O2 |
| --- | ---: | ---: |
| 纯 BPU 推理吞吐 | 16.344 FPS | 92.749 FPS |
| HBM 文件大小 | 75,291,608 字节 | 67,226,560 字节 |
| 128 张输出逐元素比较 | 基准 | 全部完全相同，最大绝对差 0 |
| 同一截图归档实验的热身吞吐 | 15.544 张/秒 | 75.247 张/秒 |

纯推理提升约 **5.67 倍**，截图归档实验提升约 **4.84 倍**。这是实测结果，不能外推为其他模型必然有同样收益。

归档实验运行实际 SnapshotStore、GPEN HBM、GLES 前后处理、JPU JPEG 和真实 MongoDB；先热身 12 张，再计时保存 24 张，共保存 36 张。使用 96×96 RGBA 输入及测试注入的人脸框，GPEN 输入为 256×256。该实验不包含真实人脸检测、整路 4K 解码和 ERP 投影的成本，不代表实际摄像头全链路吞吐。初次冷启动的 4.6 张/秒包含初始化，不能当成稳态性能。

O2 复用了 O0 的量化结果，未重新校准，也未改量化精度。当前 GPEN 的 INT8 输出与原始 FP32 的严格数值质量门槛未通过，用户已明确目测接受其实际效果；O2 的接受依据是 128 张输出与该已接受版本完全相同。保留此事实，不能将编译优化描述为修复了量化精度。

## 后续 HBM 默认开发流程

1. 使用正确的模型输入规范，准备有代表性的校准集和独立验证集。YOLO COCO 使用 COCO 场景，人脸与 GPEN 使用 CelebA；GPEN 使用人脸裁剪及自身归一化。
2. 先用 O0 尽快得到可验证的 HBM，保存校准 ONNX、量化 ONNX、量化 BC、配置、编译日志和哈希到 SSD。O0 是验证阶段，不是默认最终发布配置。
3. 审计 placement/advice，检查算子实际执行位置。神经网络运算不得回退 CPU。允许的检测结果整数索引逻辑必须单独记录，不得把它计成全模型 BPU 执行。
4. 在真实 S100P 上测试输出规范、独立验证集质量和速度。坐标、置信度、类别 ID 必须分别正确；类别 ID 必须为整数，禁止靠静默取整掩盖量化错误。
5. 模型功能正确后，**优先复用同一量化 BC 编译 O2**，避免重复校准。变更输入、图结构、量化策略或校准数据时，旧 BC 不可直接沿用。
6. 在同一板、同一输入、同一预热和计时规则下比较 O0/O2；比较全部输出。O2 只有在正确性验证通过、实际速度提升后才替换生产 HBM。部署保留旧模型和服务二进制备份。
7. 运行实际业务链路测试，分别报告纯推理、热身后的归档吞吐和真实视频通道吞吐。禁止将一个指标替代另外两个。

用户已授权功能正确且超过 5 FPS 的模型直接接线；速度达标而质量失败的检测模型不能据此部署。GPEN 的人工接受只适用于已检查版本及经独立验证输出一致的优化版本。

## 编译环境与可复用命令

本次环境：官方 OE 3.7.0 x86_64 GPU 镜像 `ai_toolchain_ubuntu_22_s100_s600_gpu:v3.7.0`，hb_compile 3.5.3、HMCT 2.6.5、HBDK 4.7.5，目标 `nash-m`。板端实际 hobot-dnn 3.13.6、HBRT 4.7.5，必须按实际库检查兼容性，不能只看 `/etc/version`。

以下命令在官方 x86_64 工具链容器执行。脚本在仓库 `test/model_conversion/compile_saved_bc.py`；先复制进容器，路径示例中的 `/work/ainvr-gpu-gpen` 是本次容器工作目录。每次输出目录必须全新。

```sh
python3 /work/ainvr-gpu-gpen/compile_saved_bc.py \
  --bc /work/ainvr-gpu-gpen/compiled-static-gpen-v7/gpen256/model_output/gpen256_int8_quantized_model.bc \
  --expected-sha256 be14153d0b926c2f828b9e6c6bd7ee9c63bca94440c8a72d3da3d6fc1f6409d5 \
  --output /work/ainvr-gpu-gpen/compiled-static-gpen-o2-v8 \
  --opt 2 --jobs 1 --cache-mode enable
```

底层调用为 `hbdk4.compiler.compile(..., march='nash-m', opt=2, jobs=1, debug=False, cache_mode='enable')`。本次 O2 编译约 **43 分 29 秒**，仍主要是主机编译器工作；GPU 主要加速校准和离线验证，不代表最终 HBM 代码生成都由 GPU 完成。增加 jobs 需要检查内存和实际收益，不盲目开满容器或并发任务。

GPEN 原图包含动态调制卷积，原编译尝试失败。`rewrite_gpen_static_conv.py` 将风格缩放移至输入、解调移至输出，使卷积权重静态化；20 个 Conv/ConvTranspose 节点的改写先通过 128 张 FP32 对照（最大误差约 1.94e-5）。这是 GPEN 的专用图结构修复，不能未经数学等价验证套到其他模型。随后得到的量化 BC 才用于上述 O0/O2 对比。

`max` 校准可跳过耗时的默认模型级算法搜索，是本次快速实验方法，不等于无条件最佳精度。必须依验证结果选择 INT8、敏感节点 INT16 或受支持浮点混合。YOLO 坐标与置信度范围差异大，直接一起量化可能让置信度变成零；编译成功不等于识别可用。

## 当前生产模型与证据

- 生产模型：`ai-service/models/gpen_bfr_256.hbm`，HBM SHA256：`b7885842124c164814c2ced0c50f87a825ed41d7f39ade61bfaf745137909aba`。
- O0 HBM SHA256：`239a8f9f99029133107ad110282da7cd248c859a7b9241e3dd6c390f426884dc`。
- 固定量化 BC SHA256：`be14153d0b926c2f828b9e6c6bd7ee9c63bca94440c8a72d3da3d6fc1f6409d5`。
- O2 候选、真实 SDK 描述、placement 和 128 张输出：`/mnt/ainvr-ssd/model-compile-candidates/gpen-static-o2-v8/`。
- O0 模型备份：`/mnt/ainvr-ssd/migration-backups/gpen-O0-before-O2-20261012/`。
- 推理与输出一致性报告：`test/results/gpen-O2-optimization-20261012.json`。
- O2 实际归档链路报告：`test/results/gpen-archive-20261012-O2-pipeline.json`。
- O0 热身后归档报告：`test/results/gpen-archive-20261012-pipeline-final.json`。
- GPEN 改图 FP32 等价性：`test/results/gpen-rewrite-parity-128-20261012.json`。
- 原始量化数值质量报告：`test/results/gpen-static-int8-parity-20261012.json`。
- 流水线回归测试：`test/results/gpen-pipeline-regression-20261012/summary.json`。
- 服务部署记录：`test/results/gpen-pipeline-deployment-20261012.json`。

所有大型源模型、编译中间文件、验证张量和备份存 SSD；`ai-service/models` 只放部署的 HBM 和配套 manifest。

## 官方依据

- [HBM 编译参数与优化等级](https://doc.oe.horizon.auto/3.8.1/guide/tools_guide/ptq_tools/hb_compile/convert.html)：O0 优先编译速度，O2 优化运行性能，需支付更长编译时间。
- [节点量化精度配置](https://doc.oe.horizon.auto/3.7.1/en/guide/ptq/ptq_tool/hb_compile/quant_config.html)：模型、算子、子图、节点级别的 INT8/INT16/浮点精度配置。

以上为查阅时的官方参考；实际参数可用性以本项目使用的 OE 3.7.0 工具链为准。

## 校准结果复用的补充验证

`test/model_conversion/requantize_saved_calibration.py` 是试验性调优工具。
同一张图结构及前处理不变时，可以保留已完成的 512 张校准阈值，调整量化精度后重新生成 PTQ/BC/HBM；仍需完整独立验证，不能把复用统计当成质量证明。

必须通过 **HMCT ModelBuilder** 初始化 `nash-m`、量化模式和优化环境后调用量化。
最初直接调用底层 `quantize_for_hbdk4` 的试验遗漏了全局环境，导致不匹配的激活 LUT：校准模型的人脸置信度约 0.934，PTQ/HBM 却约 0.004，多个不同输入输出相同。该试验产物均未部署。初始化修正后，YOLO26x-face 的 128 张独立 CelebA 对照通过：匹配精确率 99.29%、召回率 98.59%、平均 IoU 99.36%，O0 板端纯推理 11.118 FPS。

不能盲目把所有节点改为 INT16：模型内部两处 nearest Resize 的原内核要求 INT8。最初全改 INT16 的试验有两处神经运算落到 CPU，已经拒绝部署。当前已部署人脸模型保留这两处 INT8 边界；COCO 的进一步调优将 nearest 2× 改写为 reshape/concat 像素复制，避免缩放边界的精度损失。原始 ONNX Resize 与实际改写子图在 8 项随机输入上逐位相同，端到端单张 FP32 输出也完全相同；COCO 调优版本仍待完整板端质量验证，不能据此宣布通过。

## 真实 4K 人脸业务链路

已通过原生 AI 配置及启动 API 接入用户原有 `大门` 输入与 AI 输出，保留原拉流和推流地址，并启用 GPEN。源为 3840×1920、约 30 FPS 的 H264 流。真实人脸检测、GPEN、JPU JPEG、MongoDB 归档和原画面 SEI 回流已运行，原图和增强图均可通过归档 API 取回；不是测试注入的人脸框。

当前 O0 人脸模型的完整业务识别速度约 **5.4 FPS**，低于纯推理的 11.118 FPS。采样阶段中推理约 101 ms、预处理约 13 ms、截图提交约 39 ms；4K 截图一次下载约 29.49 MB RGBA 数据、约 46 ms，同时 GPEN 与检测共享唯一 BPU。该数据解释了为什么不能把 75.247 张/秒的固定小图归档试验外推到真实 4K 通道。后续 O2 和减少完整 RGBA 下载的优化须分别实测。

证据：`test/results/face-channel-deployment-20261012.json`、`test/results/yolo26x-face-hbm-validation-20261012.json`、`test/results/yolo-calibration-reuse-investigation-20261012.json`、`test/results/yolo-nearest-repeat-proof-20261012.json`。
## COCO80 通过与实际网页接线（2026-10-12）

- 最终通过的 O0 HBM：`e6b79c83c20dd75f2d1a89b93218483ad5d9595abafbf96ca5d7b45506fd0eff`，71,818,624 字节；生产路径 `ai-service/models/derived/s100p/yolo26x.hbm`。
- 修正三处 Softmax 减最大值后校准范围：旧 INT8 阈值 5.644179821014404 在重定量到 INT16 时仍然截断负值；改为 16 后，128 张独立样本的 FP32 检测一致性 precision 0.969278、recall 0.964095、匹配 IoU 0.983933，通过既定检查。类别输出全部严格为整数，未通过取整掩盖误差。
- 用户带标签的 128 张、68 类子集 AP50 为 0.744677；FP32 参考约 0.7510。这不是官方 COCO 全集 mAP，也不等于不存在量化误差。
- 实际板端顺序纯 BPU 推理 11.0816 FPS，预加载 640×640 输入，10 次预热、128 次测量；不含 4K 解码、预处理、截图和数据库。601 个 BPU 操作，6 个 CPU 整数索引操作，无神经网络 CPU 回退。
- 已通过正常网页 AI 通道向导选择 COCO80、保留原输入 `live/xm` 与既有输出 `live/ai-n2q08c` 并保存成功。真实 3840×1920 流配置 5 FPS、实测 5 FPS，SEI 注入正常，COCO 目标截图进入 MongoDB；报告 `test/results/coco-channel-deployment-20261012.json`。
- 网页实际验证：两个可选模型、现有输出通道保存成功、人脸 GPEN 增强历史、COCO 原图归档和 SSD 容量。浏览器曾保留旧版向导；重新加载带版本查询参数的页面后恢复新版。没有关闭认证，没有保存登录密码。
- 继续使用同一已验证 BC `8453c9764a623ffd4c792f7404ae6c78bd51e35bf6c83f9bd1cba86ebc1e9fb5` 编译 O2，不重复校准；候选 `/work/ainvr-gpu-gpen/compiled-coco-approved-o2-v9`，`jobs=2`，完成后必须做输出与速度复验。旧高精度但未通过一致性检查的 BC 的 O2 仅用于速度诊断，不能直接部署。

## 两个 YOLO 的 O2 实测完成（2026-10-12）

同一已验收量化 BC、同一 128 张独立验证输入、S100P BPU core 0，10 次预热后交替比较 O0/O2。两模型原始输出均逐位相同，类别值严格为整数；质量依据继承上述 O0 验证，不声称 O2 提高准确率。

| 模型 | 同次 O0 FPS | O2 FPS | 提升 | 编译配置 |
| --- | ---: | ---: | ---: | --- |
| YOLO26x COCO80 | 11.0755 | 35.8293 | 3.2350 倍 | GPU 镜像，O2，jobs=2 |
| YOLO26x-face | 11.1217 | 35.6082 | 3.2017 倍 | 新 GPU 容器，O2，jobs=4，复用旧缓存 |

这只是预加载 640×640 张量的推理吞吐，不是解码/截图/MongoDB 全链路 FPS。两文件已替换生产路径，旧模型与 manifest 备份 SSD；COCO 通道实际重启后推理和 SEI 计数恢复。人脸文件已安装，当前主通道仍是 COCO，后续可另验证 O2 人脸实流。报告见 `test/results/{coco,face}-O2-optimization-20261012.json` 和对应部署记录。

线程配置只影响可并行阶段，不能强迫串行优化使用多核，也不是 GPU 代码生成开关。新任务先用 jobs=4 和内存保护；既有 COCO 任务保持 jobs=2 并完成，避免为了改线程重编。文本编码器拆词表已能编译和执行，但 128 条真实词的量化准确性失败，不能因为 84.6 FPS 就应用；先诊断敏感浮点层，再编译通过的候选。保留全部失败证据，禁止用速度替代质量门槛。

