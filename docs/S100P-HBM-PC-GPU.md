# AINVR：PC GPU 编译环境部署与四种模型 HBM 编译手册

更新：2026-10-13。项目目录 `/home/sunrise/ainvr`，目标板 RDK S100P，编译目标 `nash-m`。这是本项目已验证版本的复现说明，不是“最新软件任意组合”的安装说明。所有工具源码在 `test/model_conversion/`；最终入口在其 `final/` 子目录。

## 1. 先理解这套环境

PC（Windows + WSL2 + Docker + RTX 4090）负责导出、校准、量化和编译；S100P 负责实际 BPU 验证和生产推理。PC 的 CUDA 加速不意味着板上需要 CUDA，也不允许将板端模型改成 CPU/GPU 推理。

流程：原权重 → FP32 ONNX 参考 → 代表性数据校准 → PTQ ONNX → Nash 量化 BC → O0 HBM 验证 → 同一 BC 编译 O2 → 板端比较 → 安装 HBM 与契约 → AI 服务 / WebUI 实流验收。

GPU 主要用于 HMCT 校准、误差补偿和离线参考验证；ONNX 导出及最终 HBM 编译仍含 CPU 阶段。`O2` 优化的是 BPU 执行速度，不代表 GPU 编译开关。不能通过再开几个容器让同一个串行编译阶段自动加速。

四种业务模型共 **6 个 HBM**：COCO80、Face、GPEN256 各一个；YOLOE 有检测器、MobileCLIP2-B 文字编码器、RepRTA 三个。文字编码和 RepRTA 只在载入/改词时执行，逐帧检测复用当次实际 BPU 生成的提示向量。

## 2. 固定版本与资源

| 组件 | 已验证值 |
| --- | --- |
| PC GPU | RTX 4090，24564 MiB；本机驱动 591.55（不是最低版本要求） |
| Docker 平台 | Linux amd64，Windows Docker Desktop WSL2 后端 |
| 官方镜像 | `ai_toolchain_ubuntu_22_s100_s600_gpu:v3.7.0` |
| 镜像 ID | `sha256:59ba4a8a94b7dff36acd07cae0c9db0e731dcaf16963b30ae1d94cee7b7e84b1` |
| Python | 镜像自带 3.10.12；不必强行替换成 3.10.16 |
| horizon-tc-ui / hb_compile | 3.5.3 |
| HMCT GPU | `hmct-gpu==2.6.5+cu126`，模块版本 2.6.5 |
| HBDK4 / HBRT | 4.7.5 |
| ORT GPU / ONNX / NumPy | 1.19.0 / 1.15.0 / 1.23.0 |
| 镜像 Torch | 2.6.0+cu126；不可为导出随意升级此全局环境 |
| 已用 YOLO26 导出环境 | 独立 Torch 2.9.0 + Ultralytics 8.4.142，opset 17 |
| 板端 | `/etc/version` 曾为 4.0.4-Beta，实际 BSP 包 4.0.5；DNN 库 3.13.6、HBRT 4.7.5，以实际库及加载测试为准 |

区分系统包版本、DNN 库版本和工具链版本，不能因名字里都有“4.0.5”或“3.7.0”就认为可互换。

单容器起步：8 CPU、16 GiB RAM、RAM+swap 上限 20 GiB、共享内存 2 GiB。编译 `jobs=1～4`；已验证 COCO O2 jobs=2、Face=4、GPEN=1。优先一次一个大任务。并发前先量测内存，容器限额相加不能超过 Docker VM 实际可用内存。GPU 显存不能靠 `--memory` 增大；`gpu_mem_limit=4 GiB` 只是每个 ORT CUDA arena 的限制，不是整个容器的显存硬上限，多会话和临时 workspace 仍会额外占用。

## 3. Windows PC 部署（PowerShell）

先安装/启用 WSL2、Docker Desktop 的 WSL2 后端及支持 WSL 的 NVIDIA Windows 驱动。运行 `wsl --update`、`wsl --status`、`docker version` 检查状态。不要在本任务中重装已有驱动、停止矿工或随意重启其他项目容器。Windows GPU 直通要求参见 [Docker 官方说明](https://docs.docker.com/desktop/features/gpu/)。Linux PC 则需按 [NVIDIA Container Toolkit 官方安装说明](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)配置 Docker runtime。

将本项目的一份源码快照下载到 PC；权重/数据单独存 PC 大容量 SSD。示例 `D:\AINVR\source`、`D:\AINVR\data` 不要求等于本次历史缓存路径。正式开发仍在板端仓库。

```powershell
# 在下载到 PC 的项目快照中执行
cd D:\AINVR\source
.\test\model_conversion\final\Get-OeGpu.ps1 -Directory D:\AINVR\toolchains -Load
.\test\model_conversion\final\Start-OeGpu.ps1 -Repository D:\AINVR\source -Data D:\AINVR\data
```

下载脚本使用已使用的官方 OSS 地址，支持 `.partial` 续传，完成后检查 SHA256 再导入镜像。固定归档 SHA256：`6e75dedd862f5826d01f7b9bfc86868d243fe42fa8e4cd32543fff629ef9ae7a`。这是本次已核对归档的身份，不是厂商数字签名。归档较大，需另留解包镜像、数据、BC 和缓存空间；不要下载到开发板 eMMC。

官方镜像地址：`https://d-robotics-aitoolchain.oss-cn-beijing.aliyuncs.com/oe/3.7.0/ai_toolchain_ubuntu_22_s100_s600_gpu_v3.7.0.tar`。工具链资料入口：[D-Robotics OpenExplorer](https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/toolchain_development/overview)。地址失效时从官方入口查同版本包，不静默改为最新版。

启动脚本固定镜像 ID，显式覆盖入口为 `/bin/bash`，避免之前出现的镜像默认启动命令退出 126；不需要 privileged、宿主网络或挂载 Docker socket。目录如下：

| 容器目录 | 内容 / 权限 |
| --- | --- |
| `/repo` | 项目快照，只读 |
| `/data` | 原权重、校准数据、已验收 BC，只读 |
| `/work` | 独立 Docker named volume，可写，校准/编译/日志/缓存 |

容器删除不等于 volume 删除，但必须在清理 Docker 数据盘/volume 前导出产物。避免长期把几百 GB 的编译中间文件只放在临时容器可写层。

`Start-OeGpu.ps1 -PrintOnly ...` 只打印配置。实际启动后自动执行环境检查：

```powershell
docker exec ainvr-oe370-final python3 /repo/test/model_conversion/final/check_environment.py
docker exec ainvr-oe370-final nvidia-smi
```

检查环境成功只证明版本、设备及 provider 可用。要证明模型确实使用 PC CUDA，运行 `probe_gpu_calibration_runtime.py --model ... --inputs ... --output ...`，其 ORT profiling 会检查实际 CUDA 节点事件；不能只凭 `CUDAExecutionProvider` 出现在列表中就宣称加速成功。

不要在 OE 系统 Python 中更新 Torch/ONNX/NumPy。YOLO 原权重导出使用单独环境（已有 `export_yolo26x.py` 硬性检查 Torch 2.9.0、Ultralytics 8.4.142）。该导出脚本原为 SSD 工作流，要求输出位于独立挂载 `/mnt/ainvr-ssd`；在 PC 独立导出容器中把专用工作 volume 挂到此路径即可，不要伪造目录绕过检查。它是离线 CPU 参考导出，不表示生产 CPU 推理。GPEN 本项目已验证转换起点为现有 `gpen256.onnx`；没有验证一套任意 PTH 一键导出器，不应假定任意 GPEN PTH 都与该图兼容。

## 4. 优先复用成功 BC：最快、风险最低的复编路径

`final/approved-recipes.json` 固定 6 个组件的 BC 哈希、O0/O2、jobs、输出文件名及生产 HBM 哈希。不同图/校准/精度不得借用这些已验收标记。新编 HBM 即使同 BC，也要复验；文件二进制哈希可能因工具链/编译元数据而不同，不可只凭文件名验收。

本次已额外备份六份成功 BC（约 309 MiB）到板端 SSD `/mnt/ainvr-ssd/model-compile-candidates/approved-bc-20261013/`，校验文件为其中 `manifest.json`。新 PC 可直接用 scp 下载到 `D:\AINVR\data\approved-bc`，不必依赖旧容器。

本机历史编译容器仍在时，也可自行导出已成功 BC：

```powershell
.\test\model_conversion\final\Export-ApprovedCheckpoints.ps1 -Directory D:\AINVR\data\approved-bc
# 六项逐一校验 SHA256；不启动任何编译任务，不修改源容器
```

此导出脚本仅用于恢复**本次已知容器**。新 PC 上需从已导出的 `approved-bc` 备份复制；缺失时按后文从原始资料准备，不能伪造 BC。历史容器和原路径记录在锁定文件中，不应作为长期唯一备份。

```powershell
# 默认只检查输入并打印命令，不编译
docker exec ainvr-oe370-final python3 /repo/test/model_conversion/final/run_approved_recipe.py coco80 --checkpoints /data/approved-bc --output /work/coco-release-001
# 确认资源后执行；新输出目录必须不存在
docker exec ainvr-oe370-final python3 /repo/test/model_conversion/final/run_approved_recipe.py coco80 --checkpoints /data/approved-bc --output /work/coco-release-001 --execute
```

其他选择：`face`、`gpen256`、`yoloe-detector`、`yoloe-text`、`yoloe-reprta`。前四项为 O2，后两项维持已验收 O0。统一入口复用已有 `compile_saved_bc.py`，不另写一套编译器逻辑、不重新校准、不自动部署。Ctrl+C/超时后先检查容器进程和 `status.json`，不能盲目重跑。可以用 `docker exec -d ...` 后检查记录文件；人工检查间隔建议 5 分钟。

编译缓存只在 BC 哈希、march、opt 匹配时通过 `compile_saved_bc.py --cache-source` 复制；不保证从原百分比续跑。不要恢复已过期 timeout wrapper；历史暂停 wrapper 只是一次进度保护处置，不是日常部署方法。

## 5. 原权重到最终 BC：数据与四条实际流程

### 5.1 校准输入

COCO 图像使用用户 `D:\code\yolovt\data\coco1920x3840\images\train2014`，还必须提供对应 YOLO 格式标签目录。`prepare_coco_calibration.py --images ... --labels ... --output ...` 默认固定 seed、512 校准 + 128 验证，校验源图哈希隔离与类别覆盖。不能用当前直播几十张替代该集合。

人脸使用 `E:\数据集下载\dataset\CelebA`，包括 `Img/img_celeba`、`Anno/list_bbox_celeba.txt`、`Eval/list_eval_partition.txt`。`prepare_celeba_calibration.py --root ... --output ...` 从官方 train/validation 分区分别选 512/128；生成 Face 与 GPEN 两种不同输入。

| 模型 | 模型输入 / 预处理 |
| --- | --- |
| COCO80 / Face | RGB FP32 NCHW `[1,3,640,640]`、除以 255、letterbox 填色 114 |
| GPEN256 | 标注人脸方形裁剪及退化尺寸，RGB FP32 NCHW `[1,3,256,256]`、`x/127.5-1` |
| YOLOE detector | 同样 640 图像 + `prompt_embeddings [1,8,512]`；文字与图像数据成对准备 |
| YOLOE text | 精确 token ID，最终 INT32 `[1,77]`，词表 49408；不可量化 token 数值 |
| RepRTA | 与当前 MobileCLIP2 对应的提示向量，8 个槽；不能换别的 CLIP 编码器 |

`run_dataset_int8_compile.py` 的 workspace 目录约定为 `models/`、`coco/calibration`、`coco/manifest.json`、`celeba/{face,gpen256}/calibration`、`celeba/manifest.json`。文件名为 `yolo26x.onnx`、`yolo26x-face-op17.onnx`、`gpen256.onnx`。manifest 记录张量 SHA256，脚本逐个校验 512 张，不只是检查目录存在。

### 5.2 COCO80：最后成功策略

1. `export_yolo26x.py --task coco80 --source ... --output ... --image-f32 ...` 导出固定端到端检测 ONNX，`[1,300,6]` 为 xyxy/score/class，完整检测集合做一一匹配，类别严格为整数。
2. `run_dataset_int8_compile.py --workspace ... --models yolo26x --output-name coco-max --calibration-method max --compiler-jobs 2`。保留 calibrated/optimized float ONNX、PTQ、BC 和日志。
3. `requantize_saved_calibration.py --calibrated ... --expected-sha256 ... --original-float ... --output ... --prefix yolo26x_requant --weight-type int8 --resize-implementation bpu_repeat_int16 --softmax-sub-range 16`。复用已保存统计，激活主要 INT16、权重 INT8，输出浮点边界保持分数/坐标/整数类别正确；不是全 INT8 模型。
4. 独立质量验收后得到成功 BC `8453c976...e9fb5`（完整值见 lock），用统一入口编 O2、板端 128 张逐位对比，再发布。

问题与解决：坐标范围远大于概率，直接一起量化使分数接近零；输出头边界保留浮点。INT16 nearest Resize 无合适 BPU 内核，会落 CPU；将精确 nearest 2× 改为 reshape/concat 复制，先验证数学等价。三处 Softmax 减最大值的校准范围仍继承旧 INT8 阈值 5.644，INT16 重量化照样截断；最终阈值 16 通过独立验证，不能把“升到 INT16”当自动正确。

### 5.3 Face：最后成功策略

1. 同一导出脚本 `--task face`，1 类人脸检测，固定官方权重哈希；不是人脸身份识别。
2. CelebA 512 校准与独立 128 验证；初始 INT8 `max` 路线同上。
3. `requantize_saved_calibration.py ... --prefix yolo26x_face_requant --weight-type int8 --resize-implementation native_int8`。保持两处 nearest Resize 的 4 个 INT8 边界，其余敏感激活提升，输出浮点边界不变。
4. 验证成功 BC `da28efe1...8795c`，O2 jobs=4；旧缓存可核对后复用。

问题与解决：直接调用底层量化函数缺少 HMCT 全局环境，浮点置信度约 0.934 在 PTQ/HBM 变成约 0.004，甚至不同输入结果相同。改为通过 **ModelBuilder** 初始化 `nash-m`、量化模式和优化环境再 `builder.quantize(model)`。曾全改 INT16 造成 Resize 神经网络 CPU 回退，拒绝该版本，恢复已验证 INT8 边界。不能通过静默取整类别或降低阈值掩盖坏量化。

### 5.4 GPEN256：最后成功策略

1. 已验证原始 ONNX SHA256 `bf7c7ced8e5f69fca6a3a226023a65f8f0689ae9c7d2e095b29c8c78dc3c6bb5`。
2. `rewrite_gpen_static_conv.py` 把动态调制卷积的风格缩放移到输入、解调移到输出，让 Conv/ConvTranspose 权重静态化；随后 `validate_gpen_rewrite.py` 在独立 128 图比较原/改图 FP32。20 个节点改写，最大误差约 1.94e-5。
3. `run_dataset_int8_compile.py --workspace ... --models gpen256 --output-name gpen-static --calibration-method max --compiler-jobs 1 --gpen-model-path ... --gpen-parity-report ...`。必须提供匹配改图哈希的 128 张报告。
4. 用通过人工视觉验收的量化 BC `be14153d...09d5` 编 O2，复验输出完全相同后使用。

问题与解决：动态卷积原始图不能直接编，修复的是数学等价图结构。默认自动校准搜索很慢，`max` 去掉多算法搜索，但仍需数据与质量验证。O0 16.344 → O2 92.749 FPS（约 5.67 倍）；该次 O2 编译约 43 分 29 秒。**严格 FP32 数值质量未过，用户明确视觉接受；不能写成数值精度达标。** O2 128 个输出与该接受版本完全相同，未重新量化。

### 5.5 YOLOE：动态词汇最后成功策略

导出与数据：`probe_yoloe_runtime_prompts.py` 是保留的最终双输入导出实现；名称带 probe 但并非可删除的旧实验。配合 `check_yoloe_text_prompt_semantics.py`、`export_mobileclip2_text_onnx.py`、`prepare_yoloe_runtime_calibration.py` 和 `make_text_encoder_validation.py`，准备真实词、512 校准短语、独立 128 文字、64 组 RepRTA 校准及图像。所有精确 CLI 参数见 `final/SCRIPT-INDEX.md`。

标准“先 set_classes 再导出”会固定词表。这里保持 detector 的 `prompt_embeddings` 为运行时输入；文字由匹配 MobileCLIP2-B → RepRTA 生成。检测输出 `[1,12,8400]`，前 4 个值 xywh、后 8 个值概率，执行生产 NMS；与 COCO 的 end2end 输出不能混用。空槽必须在 RepRTA 后清零，因 RepRTA(0) 有偏置。

文字最终链：

1. `compile_mobileclip2_text_candidate.py --model ... --calibration ... --output ...` 产生并保存统计。其原始单表 Gather placement 会拒绝 CPU 回退，这是预期的中间诊断失败；**不能安装它**。保存文件是后续修复输入。
2. `split_mobileclip_token_lookup.py --saved ... --samples ... --output ... --jobs 4` 将 49408×512 查表拆为 32768 + 16640 两表，clamp + Gather + Where 等价拼接；INT32 token、EOT 精确索引，独立验证分界值。脚本锁定本次保存统计哈希，换权重/统计时应建立新实验及门槛，不删掉校验绕过。
3. 用 `probe_text_sensitive_precision.py --candidate <split-v4> --references <128文字参考> --output <新目录> --jobs 1 --sensitive-dtype float32 --fp32-center-via-add --variant float_layernorm_softmax --attention-float-mask --bounded-integer-softmax --attention-input-ec --final-float-norm --float-softmax-tail` 得到成功 v18。它固定检查原 baseline 身份；保留 baseline 状态作为来源记录，不表示 baseline 获准生产。
4. 文字 v18 保留 O0。`Sub` 某些浮点 lowering 不支持，等价改为 `Add(x,Mul(mean,-1))`；因果 mask -10000 若与普通分数一起量化会吞掉差异，保持 mask 路径浮点；修复 Softmax 尾部、最终归一化并补偿 24 个动态 MatMul 输入。旧 v12→O2 v13 虽快但完整检测不合格，不能替换成功 v18。

RepRTA 最终链：先 `compile_yoloe_component.py --kind reprta --prepared ... --research ... --output <baseline>` 保存统计；再同脚本加 `--reuse-calibration <baseline> --rewrite-float-clip --reprta-weight-ec --reprta-activation-headroom 4 --jobs 1` 得 v5。浮点 Clip 用受支持的等价 Min/Max 改写，保留归一化，补偿权重并扩大量化激活范围。v5 保留 O0。

Detector 最终链：先同脚本 `--kind detector --prepared ... --research ... --images <512图> --output <baseline>`；随后 `--reuse-calibration <baseline> --detector-float-prompt-norm --rewrite-float-clip` 得 v2 BC。提示归一化量化误差会放大匹配误差，保留浮点边界后独立验证，再用该 BC 编 O2 v3。更晚编号的 matching-ec v6 不是生产版本；版本数字大不等于更好。

YOLOE 不能只比较文字余弦或一个 MatMul 小模型就宣布完成。必须做完整 BPU 文字→RepRTA→检测→全部最终框。新独立 128 图 P/R/IoU=0.959528/0.951505/0.980507；原逐网格最大误差门槛仍失败，最终框验收是另一个明确检查，不改写失败结论。任意英文描述可运行，不保证任何词/任何图均准确，最多 8 槽、77 token。

## 6. 内存、卡住、失败与加速经验

| 现象 | 处理 |
| --- | --- |
| 镜像启动退出 126 | 使用最终启动脚本明确 `/bin/bash`；检查容器日志，不重复创建同名任务 |
| 编译退出 137 | 核对 `docker inspect` 的 OOMKilled 和 VM/容器内存；不是所有 137 都是 OOM。降低并发/jobs，保留 BC、PTQ、cache |
| 有 4090 仍慢 | 区分 GPU 校准与 CPU 图优化/代码生成；查看真实 provider profiling 与阶段日志，不凭 GPU 镜像名判断 |
| 默认校准反复遍历 512 张 | 对照使用 `max`；必须独立验证质量。固定 batch=1 的文字 reshape 不支持自动 batch8，退回 batch1，不因静默再次重启 |
| 最终编译长时间停在 20% | 查看进程 CPU/内存/输出 mtime，百分比不是时间进度；保留中间产物，不能仅据日志静默判断卡死 |
| 全 FP16 无法全 BPU | Nash 支持部分浮点算子，但全卷积 FP16 会触发不支持内核/CPU fallback；最终采用经验证的整数＋敏感浮点混合 |
| 容器加内存未变快 | 容量解决 OOM，不自动增加算力；Docker VM 总限额、容器限额及 GPU 显存要分别检查 |
| O2 编译慢 | 先 O0 质量验收，再同 BC O2；GPEN 的 5.67 倍收益不能照搬给其他模型 |

保留 `guard_docker_compile_memory.py` 作为内存保护工具，参数见索引。它只管理显式指定且核对身份的自有容器；VM 可用 <6 GiB、容器余量 <3 GiB 或显存余量 <2 GiB 时暂停，暂停不释放分配，持续危急时按脚本策略停止该任务保留文件。不要停止矿工或不在本任务中的服务。阈值是本机实验策略，不是所有机器的最低要求。

### 6.1 大模型（多包 HBM）编译经验（Qwen3-VL-4B，2026-10-20～22）

详细配方与脚本见 `test/model_conversion/qwen3vl/S100P-QWEN3VL-ALARM-REVIEW-BPU.md` 与新手手册 `S100P-QWEN3VL-BUILD-GUIDE.md`。

| 现象 | 原因 / 处理 |
| --- | --- |
| 视觉末段误差放大几十倍 | 官方 GELU 查表在输入达到数百时失效；改为量化域分段 `gelu(sat8(x)) + relu(x−8)` |
| 编译通过但板上变慢、精度不对 | 浮点 `clip/exp/sub` 等被静默降到 CPU（`hbtl.call: native::*`）；全部留在 16 位伪量化域，用固定范围饱和伪量化。**每个包都用 `hbrt4-disas --json` 断言全部为 `DEVICE_CATEGORY_BPU`** |
| 注意力分数精度损失大 | 掩码 −512 把 int16 分数范围撑宽 4 倍；改为 −96。官方 softmax 约 2.3% 概率误差，改为量化域分解 softmax |
| 整组误差看着很小，末 token 却错 | 首 token 的大激活行稀释了整组 rel_l2；**必须单独检查最后一个 token** |
| 编译机 OOM（WSL 32 GB 曾连续被杀 3 次） | 单个 9 层文字组的编译器参考仿真约 24 GB、O2 约 19 GB；**严格串行**，加内存守护；数据盘满会导致 ConstantWriter I/O 错误，开工前留足空间 |
| O2 是否要重新验精度 | 同一 converted.bc 只改编译选项（O2、balance）时，板上输出与编译器参考**逐位相同**即可，不必重跑精度评估 |
| O2 后还想提速 | 本次编译用的 `max_l2m_size=0`（未用片上缓存），未试；`max_time_per_fc` 可让其他模型在大模型调用中插入（降低检测抖动），未试。都需同 BC 重编并做逐位比对 |
| 编译后 BPU 耗时口径 | 用 `hrt_model_exec perf --model_file X --model_name N --frame_count 20 --core_id 1` 测纯 BPU；与 Python `hbm_runtime` 调用对比可拆出主机开销（Qwen3-VL 实测仅约 7 ms/次） |

## 7. 板端验收及安装

1. 将候选上传 SSD `model-compile-candidates/`，核对 SHA；不直接覆盖生产 `ai-service/models`。
2. `audit_hbm_placement.py` 加真实 SDK 描述检查，无神经网络 CPU fallback；允许的精确整数索引单独登记。
3. `validate_hbm_dataset.py`、`compare_hbm_reference.py`、`evaluate_coco_subset.py` 检查独立数据。YOLOE 使用文字/RepRTA/完整 detector 比较脚本，见索引。类别必须为整数，输出有限，尺寸和阈值契约正确。
4. `compare_hbm_optimization.py` / `compare_yoloe_component_optimization.py` 做同输入 O0/O2 的完整输出及真实 BPU 性能比较。10 次预热、128 次测量，纯推理不含视频链路。
5. 只有通过验证才生成 `.hbm.ainvr.json`。已有安装入口 `deploy_verified_hbm_optimization.py`、`deploy-package/install-yoloe-s100p.py`；使用前核对其 CLI、报告格式及备份路径。原生服务用 `deploy-package/install-ai-s100p.py`。这次文档整理没有重新部署模型。
6. 通过正常网页向导配置输入/AI 输出，实际验证 SEI、截图/JPU/MongoDB 与播放。CPU 参考只用于 PC/测试，不是生产 fallback。

| 模型 | 已验收纯 BPU FPS | 验证说明 |
| --- | ---: | --- |
| COCO80 O2 | 35.829 | 128 张 O0/O2 输出完全一致；O0 对 FP32 P/R/IoU 96.93%/96.41%/98.39% |
| Face O2 | 35.608 | 同上，99.29%/98.59%/99.36% |
| GPEN O2 | 92.749 | 同已视觉接受 O0 输出完全一致；严格 FP32 数值例外保留 |
| YOLOE detector O2 | 约 39.48 | 文字 v18 + RepRTA v5 完整链路另行验收 |

128 图一致性不是官方 COCO 全集 mAP。真实流优化后的约 30 FPS 是另一项结果，见 [推理流水线文档](S100P-INFERENCE-PIPELINE.md)。当前模型部署状态以 [readiness](S100P-MODEL-READINESS.md) 为准；旧 PID 和旧静态状态不代表仍在编译。

### 7.1 板端 BPU 内存（ION）与共存

> ⚠️ **禁止读取 `/sys/kernel/debug/ion/` 下任何文件**（`cat`/`head`/`tail`/脚本顺序读、单次或轮询都不行）。2026-10-22 读取 `heaps/cma_reserved` 使本板内核崩溃并自动重启（`ion_heap_show → seq_lseek` Oops）。生产服务单元加 `InaccessiblePaths=/sys/kernel/debug`。`test/` 下读取该目录的旧实验脚本一律不得运行，见 `test/ION-DEBUGFS-FORBIDDEN.md`。

| 事项 | 做法 / 实测 |
| --- | --- |
| 池容量 | ION 池 7.5 GiB（8053063680 B），开机固定，已接近单个内存段上限；物理内存 24 GiB 中 Linux 只用 15.5 GiB。用官方 `hb_mem_get_heap_size` 读总量 |
| 剩余量 | **没有安全的实时剩余量来源**：官方库只给总量；`MemAvailable`/`CmaFree` 与 ION 池无关；内核未开 DMA-BUF sysfs 统计。不要设计依赖“剩余量”的加载判断 |
| 进程占用（只用于展示） | 读 `/proc/<pid>/fdinfo/<fd>`：链接目标为 `/dmabuf:`、`exp_name: ion` 的条目按 `ino` 去重累加 `size`。这是**下限**（不含驱动内部分配），不得用“总量 − 占用”推算剩余 |
| 已测占用 | Qwen3-VL-4B 约 5.5 GB；LocateAnything 首个请求懒加载后约 5.19 GB；两者不能同时常驻。新模型上线前必须在独占条件下实测并写入其 `.hbm.ainvr.json` / 包清单 |
| 大模型加载判断 | 共同锁 `/run/ainvr/bpu-reservation.lock` + 登记表互斥 → 静态预算（总量 − ai-service 预算 − 余量 ≥ 需求）→ 锁内加载，失败干净释放 → 加载后用 `hbUCPMallocCached` 试分配“余量”大小并立即释放，失败则卸载。详见 `docs/S100P-LLM-SERVICE-DESIGN.md` §7 |
| 启用前验证 | 正常加载一次；再做“绕过登记表强制冲突加载”，确认干净失败、无句柄泄漏、其他服务健康不变 |
| BPU 时间争用 | 本板只有 1 个 BPU 核；实测 hbUCP 任务优先级（0～255）对抢占/插队无效：大模型一次调用期间，检测类短任务多等约 230 ms。共存靠调用方的提交时间配额与调用粒度，不靠优先级 |
| 扩大 ION | 需改设备树并重启。`/boot/hobot/rdk-s100p-v1p0.dtb.bak` 是 1 GiB 的原始设置，**`hb_switch_ion.sh default` 会恢复它，导致现有模型全部加载失败，不得执行** |

## 8. 脚本整理范围

保留最终转换、必要数据准备、量化修复、验证和部署脚本，每个用途及 CLI 在 `test/model_conversion/final/SCRIPT-INDEX.md`，文件身份在 `script-manifest.json`。实验脚本若承载最终导出或修复逻辑则保留，通过固定命令选择成功分支；不为了名字整齐重写已验证实现。

失效纯浮点/小算子探针、旧 CPU 下载入口、SCRFD 非交付路线、被最终策略替代的单步探针移出活动目录，原文件以清单记录并可恢复归档。历史失败结果、模型、大型数据和 BC 不删除。恢复位置见 `cleanup-manifest.json`；此清单使旧文档的历史文件名仍可追溯。没有修改子模块或其他项目。
