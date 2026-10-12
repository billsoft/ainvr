# LocateAnything-3B：Jetson TensorRT 编译与验证指南

本文依据 2026-10-10 在 Jetson Orin NX 16GB 上完成的试验编写，说明从原始权重、环境准备、分块编译到整图推理和业务恢复的完整过程。命令在开发板 Bash 中执行。

## 1. 目标、适用范围与结论

目标是在不升级现有生产 CUDA、TensorRT 和 PyTorch 的前提下，验证 LocateAnything-3B 能否通过本板 TensorRT 推理。

已验证可行：视觉网络、36 个语言解码层及输出层可在 TensorRT 10.3 上执行；主要矩阵计算使用 FP16，归一化和部分归约保留 FP32。真实录像截图完成了文本引导的目标定位，得到有效坐标和正常结束符。

本指南对应**独立试验原型**，尚未接入 AI 微服务的模型适配器，也不是官方工具生成的 `.bundle`。现有 YOLO/人脸模型与生产服务未被此原型替换。固定单图片 448×448、单请求、慢速自回归生成，本轮未实现 MTP、多图片、批处理或动态图片尺寸。

实测一次图片计算约 10.19 秒，不能作为 15 FPS 实时识别模型直接替代。分层同步、检查和引擎调度仍有开销，这个数值也不代表最终优化上限。

## 2. 环境与目录

### 2.1 已验证环境

| 项目 | 实机版本或范围 | 注意事项 |
| --- | --- | --- |
| 硬件 | Jetson Orin NX 16GB | 内存由 CPU/GPU 共享，不能只看显存计数 |
| 系统 | Ubuntu 22.04，L4T 36.4.3，ARM64 | 不套用桌面 x86 的安装包 |
| 系统 CUDA 工具链 | 12.6，nvcc 12.6.68 | 来自 `/usr/local/cuda` |
| PyTorch | 2.3.0，`torch.version.cuda == 12.4` | 这是 PyTorch 构建标记，与系统 nvcc 分开记录；本次组合已实测可用 |
| TensorRT | 10.3.0 | 本板原有版本，不在试验中升级 |
| Python | 3.10 | 虚拟环境共享系统包 |
| ONNX | 1.17.0 | 已有环境提供 |
| transformers | 4.51.3 | 仅安装到试验虚拟环境 |
| safetensors | 0.5.3 | 同上 |
| huggingface-hub | 0.30.2 | 同上 |
| tokenizers | 0.21.1 | 同上 |

编译出的引擎只在本机软件组合与 Orin 上验证过。更换 TensorRT、GPU 或模型版本时，需要重新编译和验收，不能仅复制旧 `.engine` 后假定兼容。

### 2.2 已有试验目录

```text
/home/sunrise/ainvr/
├── ai-service/models/                    原始权重，不修改
│   ├── model-00001-of-00002.safetensors
│   └── model-00002-of-00002.safetensors
├── docs/locateanything-jetson-tensorrt-build-guide.md
└── out/locateanything-trt-20261010-icivac/
    ├── venv/                             隔离的 Python 环境
    ├── model/                            配置、分词器、自定义模型代码、权重链接
    ├── artifacts/                        引擎、词嵌入、数值对照、结果图片
    ├── trt_probe.py                       导出、构建、对照、整图推理
    ├── run_build.py                       顺序构建 36 个解码层
    ├── probe_fp16_head.py                 构建并检查推荐 FP16 输出层
    ├── test_*.py                          回归和原模型数学对照测试
    ├── collect_report.py                  汇总试验结果
    ├── services-before.txt                停服前运行服务清单
    ├── containers-before.txt              停服前运行容器清单
    ├── resources.log                      资源采样
    └── production-restored.json           上次业务恢复验收记录
```

原模型的配置和自定义代码来源目录为 `/home/sunrise/LocateAnything3B`。

**复现材料边界：**试验脚本当前保留在 `out/`，该目录属于忽略产物，干净 Git 检出并不自动包含这些脚本或权重。搬到新板前，需要另外复制已验证的试验脚本、测试及模型配套文件；只复制这篇文档不构成完整构建工具包。现有离线业务安装包也不因本试验自动获得 LocateAnything 推理功能。

## 3. 为什么要这样编译

### 3.1 拆成视觉、解码、输出三部分

```text
图片 → 缩放/归一化 → vision.engine → 256 个视觉 token
提示文字 → 分词 → embedding.npy → 与视觉特征合并
    → decoder-00.engine … decoder-35.engine
    → head-aligned.engine → 选择下一个 token
    → 更新 KV 缓存，重复生成 → 文本与目标框
```

| 部分 | 本次结构 | 目的 |
| --- | --- | --- |
| 视觉 | MoonViT，27 层，含特征投影 | 把图片转成语言解码器能使用的特征 |
| 解码 | 36 个独立引擎，隐藏维度 2048 | 单层构建限制峰值内存，先验证可运行性 |
| 输出 | 推荐 `head-aligned.engine` | 把隐藏状态投影到词表，生成文字和坐标 token |
| 词嵌入 | `embedding.npy` | 把输入/生成 token 转成隐藏向量；不是另一个 TensorRT 引擎 |

推荐运行需要 **38 个引擎**：1 个视觉、36 个解码层、1 个对齐输出层。另保留 FP32 的 `head.engine` 用于诊断和对照，共 39 个有效引擎产物。

原权重为 BF16。导出时转为 FP32 张量构建 ONNX，再由 TensorRT 按精度约束选择 FP16/FP32 算子。这里的“FP16 推理”表示主要计算使用 FP16，**不表示所有算子、输入输出和 KV 缓存均为 FP16**。

PyTorch 仍负责设备缓冲、位置编码、缓存调度和部分预处理；带学习权重的主要计算由 TensorRT 执行。这不是纯 C++ TensorRT 产品运行时。

### 3.2 固定缓存与位置编码

- 图片固定 448×448：14×14 patch，32×32 patch 网格，2×2 合并后得到 256 个视觉 token。
- 文本总容量固定为 384 token；包含提示、视觉占位和生成结果，不能把 384 全部当作输出长度。
- 实测提示为 295 token，最多生成 64 个，满足 `295 + 64 <= 384`。
- 每层 K/V 缓存形状为 `[1, 2, 384, 128]`，本次使用 FP32 缓冲。
- 未使用的缓存槽必须被 attention mask 屏蔽；当前输入必须保持因果关系，不能读未来 token。
- 后续生成位置从已使用的缓存长度继续，不能每轮重新从零计算。
- 视觉的二维复数 RoPE 转成等价的实数旋转；文本使用 Qwen 的半向量旋转。两种排列不同，不能复用错公式。

## 4. 开工前检查与生产停服

### 4.1 先记录，后停服

先查看授权、录像存储、AI 归档积压、进程和容器状态，确认正常停止能排空或保留已接收的归档任务。暂停 SRS/录像会产生真实维护缺口，相机会重新连接；请记录维护起止时间。

本次停过以下 9 个业务服务及 5 个业务容器，它们是**本板当时的运行清单**，不是所有设备通用的停止列表：

```text
ai-service.service                  ainvr-ingest.service
ainvr-license-enforcer.service      ainvr-license.service
ainvr-os-helper.service             ainvr-recorder.service
ainvr-remote-assist.service          ainvr-restart-helper.service
ainvr-srs-observer.service

ainvr-web                ainvr-backend
ainvr-srs                     ainvr-mongo
ainvr-postgres
```

SSH、NetworkManager、Docker 守护进程等基础设施保留运行。**若正在通过远程协助隧道连接，不能停止作为唯一入口的 `ainvr-remote-assist`；先准备直连或现场恢复途径。**本次使用局域网直连 SSH，没有这个依赖。

以下变量用于新一轮独立试验，路径不要指向已有试验目录：

```bash
set -euo pipefail
REPO=/home/sunrise/ainvr
KIT="$REPO/out/locateanything-trt-20261010-icivac"
TASK="$REPO/out/locateanything-trt-$(date +%Y%m%d-%H%M%S)"
cd "$REPO"
pwd -P
git status --short
test -d "$KIT"
test ! -e "$TASK"
mkdir "$TASK"
```

后续所有章节使用同一个 `TASK`。重新连接 SSH 后要恢复这个**已创建的实际路径**，不要再次运行带时间戳的创建命令。sudo 需要时交互输入密码；不要把密码或令牌写入脚本和日志。

记录本次候选列表中实际运行的项目：

```bash
cd "$TASK"
for unit in ai-service ainvr-ingest ainvr-license-enforcer ainvr-license \
    ainvr-os-helper ainvr-recorder ainvr-remote-assist \
    ainvr-restart-helper ainvr-srs-observer; do
  if systemctl is-active --quiet "$unit.service"; then
    printf '%s.service\n' "$unit"
  fi
done > services-before.txt

docker ps --format '{{.Names}}' | grep -E \
  '^(ainvr-web|ainvr-backend|ainvr-srs|ainvr-mongo|ainvr-postgres)$' \
  > containers-before.txt || true
free -h > memory-before.txt
df -h "$TASK" > disk-before.txt
```

确认清单无误、远程入口不依赖待停服务后再操作。先停授权执行器和重启助手，避免业务被自动拉回；再正常停止其他业务，最后停止业务容器。只停清单里的项目：

```bash
cd "$TASK"
for unit in ainvr-license-enforcer.service ainvr-restart-helper.service; do
  if grep -qxF "$unit" services-before.txt; then sudo systemctl stop "$unit"; fi
done
while IFS= read -r unit; do
  case "$unit" in
    ainvr-license-enforcer.service|ainvr-restart-helper.service) continue ;;
  esac
  sudo systemctl stop "$unit"
done < services-before.txt
while IFS= read -r container; do docker stop "$container"; done < containers-before.txt
free -h
df -h "$TASK"
```

如果正常停止未完成或归档落盘失败，应先调查并保住待处理任务，不要为了腾内存直接强杀业务进程。计划构建时预留至少约 10GiB 可用内存、约 30GiB 磁盘余量；这些是本轮规模的准备参考，不能保证所有软件组合都够用。持续观察内存、交换和磁盘空间。

### 4.2 资源采样

```bash
cd "$TASK"
nohup timeout --signal=TERM --kill-after=30 7200 \
  tegrastats --interval 5000 > resources.log 2>&1 < /dev/null &
echo "$!" > resources.pid
```

目的：保留构建和推理峰值证据。不要只根据进程退出码判断是否出现内存压力。后续长任务不要重复启动，先核对 PID、日志与产物。

## 5. 准备脚本、模型与虚拟环境

### 5.1 复制已验证工具

```bash
cd "$TASK"
for file in trt_probe.py run_build.py probe_fp16_head.py collect_report.py \
    test_probe.py test_reference.py test_prompt.py test_vision_math.py test_head.py; do
  cp "$KIT/$file" "$TASK/$file"
done
mkdir model artifacts
```

这些脚本必须取已完成实机验证的版本。随意改权重读取、位置编码、mask 或模板后，需要重跑相应对照测试。

### 5.2 模型配套文件

只有两个权重分片不能完成推理，还需要配置、索引、分词器和同版本的自定义代码。下面复制已验证试验的配套文件，排除权重与缓存，再链接原始权重：

```bash
cd "$TASK"
find "$KIT/model" -maxdepth 1 -type f \
  \( -name '*.json' -o -name '*.py' -o -name 'vocab.json' -o -name 'merges.txt' \) \
  -exec cp -t "$TASK/model" -- {} +
ln -s "$REPO/ai-service/models/model-00001-of-00002.safetensors" model/
ln -s "$REPO/ai-service/models/model-00002-of-00002.safetensors" model/
```

新板没有 `KIT` 时，需先从已验证板复制工具包及配套文件；原始来源是 `/home/sunrise/LocateAnything3B`。重点检查：

- `config.json`、`model.safetensors.index.json`；
- `tokenizer_config.json`、`special_tokens_map.json`、`added_tokens.json`、`vocab.json`、`merges.txt`；
- `configuration_qwen2.py`、`modeling_qwen2.py`、`modeling_vit.py`、`processing_locateanything.py` 及它们的本地依赖；
- 相关处理器配置与模板文件。

自定义 Python 模型代码会被导入执行，只使用与已核验模型配套的可信文件。不要把不同版本的配置、词表和权重拼起来。

### 5.3 环境隔离

```bash
cd "$TASK"
python3 -m venv --system-site-packages venv
venv/bin/python -m pip install --no-deps \
  transformers==4.51.3 safetensors==0.5.3 \
  huggingface-hub==0.30.2 tokenizers==0.21.1
venv/bin/python -c 'import torch,tensorrt,onnx; print(torch.__version__,torch.version.cuda,tensorrt.__version__,onnx.__version__); assert torch.cuda.is_available()'
```

`--system-site-packages` 复用 Jetson 已有的 PyTorch/TensorRT；`--no-deps` 避免依赖解析自动替换它们。没有安装 `torch`、`tensorrt` 或更换系统 CUDA。新增包的底层依赖需要由现有环境提供；如导入失败，应逐个检查，不能直接去掉隔离并全局升级。

离线编译时先准备匹配 Python 3.10/ARM64 的 wheel 与依赖，在安装命令增加 `--no-index --find-links <wheel目录>`；不要使用 x86 wheel。

### 5.4 完整性检查

```bash
cd "$TASK"
sha256sum model/model-*.safetensors | tee model-sha256.txt
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 venv/bin/python -u \
  trt_probe.py --model model --out artifacts --stage check
```

本次正确 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| model-00001-of-00002.safetensors | `923cfc10fed19808067da6df85a9a4220ddc1f9eb91ceee94c0fecd05d0f2d58` |
| model-00002-of-00002.safetensors | `3459ba101f40594f3f62d3312014f1f8378b4ba3da3b1d562480045938fc7d47` |

应出现 `CHECKPOINT_OK 770`。该阶段检查索引、分片归属、张量重复/缺失及文件尾偏移；SHA-256 另用于确认文件与已验证来源完全一致。任一不符就停止，不要继续编译。

## 6. 先验证数学实现，再编译

```bash
cd "$TASK"
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 venv/bin/python -m unittest \
  test_probe.py test_reference.py test_prompt.py test_vision_math.py -v \
  > cpu-tests.log 2>&1
cat cpu-tests.log
```

本次 15 项 CPU 测试通过：基础数学/容量 10 项、实际解码层对照 2 项、提示模板 1 项、视觉数学 2 项。

目的：把“数学转换错误”和“TensorRT 精度/构建问题”分开。实际层 0 与原始 NVIDIA 模型代码分别比较首次输入和缓存生成，测试不能只比较自己复制的两份实现。

特别注意提示模板中 system 消息结束前的换行。本轮曾发现缺少换行，虽然模型可能仍生成文本，但不等同于原模板；修复后才完成最终验证。

`test_head.py` 依赖编译后的输出引擎，此时不要运行，见第 8 节。

## 7. 顺序构建引擎

### 7.1 构建策略与参数意图

| 参数/策略 | 本次取值 | 意图与代价 |
| --- | --- | --- |
| ONNX | opset 17，FP32 导出，常量折叠 | 用本板支持的基础算子表达原模型 |
| 网络 | 显式 batch | 形状与 profile 明确可检查 |
| 工作空间 | 512MiB | 限制算法工作空间；不是进程总内存上限 |
| 构建优化等级 | 1 | 减少试验构建开销，未追求最终最优 tactic |
| 精度 | FP16 + `OBEY_PRECISION_CONSTRAINTS` | 常规计算半精度，敏感运算保留单精度 |
| 归一化/归约/Softmax | 关键节点 FP32 | 减少溢出、NaN 和累积误差 |
| 解码 query profile | min 1 / opt 294 / max 384 | 同时支持首次输入和逐 token 生成；实际提示 295 在范围内 |
| 解码缓存 | 固定 384 槽 | 避免每步调整缓存形状，依靠 mask 屏蔽空槽 |
| 并发 | 一次只构建一个阶段 | 防止 16GB 板上同时加载多份权重造成内存不足 |

本版本 TensorRT 的 `profile.set_shape()` 成功可能返回 `None`，不能用 `if not ...` 判失败；脚本仅以 `is False` 认定失败。

导出后先释放源权重与网络再构建，数值对照时重新加载。解析 ONNX 失败必须报告 parser 错误；构建返回空 plan 必须停止，不能留下看似成功的引擎。运行器保留 logger/runtime/engine 生命周期，绑定连续缓冲并检查输出有限值。

### 7.2 视觉引擎

```bash
cd "$TASK"
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 timeout --signal=TERM --kill-after=30 1200 \
  venv/bin/python -u trt_probe.py --model model --out artifacts --stage vision \
  > vision-build.log 2>&1
tail -n 20 vision-build.log
```

应产生 `vision.engine` 和 `vision-parity.json`。该阶段包括视觉网络和特征投影，输出 `[256, 2048]`。本轮视觉构建约 44 秒，含导出、加载、检查的整个阶段约 196 秒，仅供估时。

### 7.3 先构建正确的 FP32 输出层及词嵌入

```bash
cd "$TASK"
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 timeout --signal=TERM --kill-after=30 1200 \
  venv/bin/python -u trt_probe.py --model model --out artifacts --stage head \
  > head-build.log 2>&1
tail -n 20 head-build.log
test -s artifacts/embedding.npy
```

应产生 `head.engine`、`head-parity.json` 和 **`embedding.npy`**。`head.engine` 是 FP32 回退引擎，禁用 TF32 便于对照。即使最终使用 FP16 对齐输出层，这一步也不能省略：`probe_fp16_head.py` 不生成词嵌入文件。

### 7.4 36 个解码层

```bash
cd "$TASK"
nohup env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 \
  timeout --signal=TERM --kill-after=30 3600 venv/bin/python -u run_build.py \
  > decoder-build-driver.log 2>&1 < /dev/null &
echo "$!" > decoder-build-driver.pid
```

查看进度：

```bash
cd "$TASK"
ps -p "$(cat decoder-build-driver.pid)" -o pid,etime,args
tail -n 15 decoder-build-driver.log
```

`run_build.py` **只处理 decoder 0～35**，不会构建视觉或输出层。每个子阶段有 1200 秒上限，任一失败立即退出；应看到 `BUILD_COMPLETE`，并检查 `decoder-build-summary.json` 中已执行阶段均为退出码 0。

对既有引擎和对应 parity 文件，驱动会跳过部分已验证层；层 0 会再次走阶段检查。脚本不能识别“文件名相同但权重、参数已改变”的情况。**更换模型、脚本或精度配置时使用全新 `TASK/artifacts`，不要拿旧产物跳过验证。**

本轮解码构建与逐层对照合计约 17.5 分钟，36 个解码引擎共 5,573,079,512 字节。

### 7.5 推荐 FP16 输出层

```bash
cd "$TASK"
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 timeout --signal=TERM --kill-after=30 1200 \
  venv/bin/python -u probe_fp16_head.py > head-aligned-build.log 2>&1
tail -n 20 head-aligned-build.log
```

应出现 `FP16_HEAD_OK`，产生 `head-aligned.engine` 和 `head-aligned-parity.json`。该脚本固定读取当前目录的 `model/`、`artifacts/`，必须先进入 `TASK`。

### 7.6 输出层 NaN 的诊断与修复原理

最初直接构建 FP16 输出层，所有 logits 都是 NaN，原始权重与 PyTorch FP32 对照却为有限值。仅让归约、归一化或原输出矩阵使用 FP32 约束仍未修复该融合路径。

正确回退是整个输出层 FP32。进一步采用以下**组合改法**得到了有效 FP16 输出层：

1. 输出矩阵词表维度从 152681 补零到 152688，原始有效行不变；
2. 结果裁回 152681，新增零行不参与 token 选择；
3. 显式输出 `normalized`，形成归一化计算边界；
4. 归一化等敏感操作保留 FP32，矩阵计算允许 FP16；
5. 检查零输入、随机输入、放大 1000 倍输入，全部有限，并与参考比较。

两项结构改法一起应用，本轮没有逐项消融，因此不能断言仅“补齐词表”或仅“多一个输出”就是唯一原因。也不能据此认定硬件损坏或某个已确认的底层缺陷。

FP32 引擎约 1.25GB，对齐 FP16 约 625MB；推荐版本与参考的最大绝对差约 0.006957，余弦相似度约 1。失败计划保留为 `.failed-plan` 供诊断，不能选来推理。

## 8. 引擎验收与真实图片推理

### 8.1 编译成功不是验收完成

验收至少包含四层：数学/模板测试、逐引擎数值对照、有限值回归、整图生成。每个引擎都要有对应 `*-parity.json`；文件存在只代表上次检查有记录，仍需确认它属于当前模型与构建版本。

```bash
cd "$TASK"
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 venv/bin/python -m unittest \
  test_probe.py test_reference.py test_prompt.py test_vision_math.py test_head.py -v \
  > all-tests.log 2>&1
tail -n 25 all-tests.log
```

本轮共 15 项 CPU 测试及 1 项输出层 GPU 回归通过；推荐 FP16 输出层的三组输入检查在其构建脚本中另行执行。36 层分别检查首次输入和带缓存生成，最低余弦相似度为 0.999875。视觉对照余弦相似度约 0.999934，最大绝对差约 0.90247；不能只凭余弦接近 1 宣称模型精度无损。

### 8.2 输入图片

复现实测可复制本次真实录像截图，避免依赖已滚动删除的录像段：

```bash
cd "$TASK"
cp "$KIT/input.jpg" input.jpg
```

也可以使用自己的本地图像。运行器会转换 RGB、缩放 448×448、按本次模型规则归一化；生成坐标按原输入图像宽高映射。固定缩放会改变非正方形图片的比例，本轮验证的是这条试验路径，未证明它等同于官方全部分辨率/切片策略。生产接入前需要单独验证预处理与准确率。

### 8.3 先参考，后推荐版本

```bash
cd "$TASK"
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 timeout --signal=TERM --kill-after=30 300 \
  venv/bin/python -u trt_probe.py --model model --out artifacts \
  --stage generate --image input.jpg --label person --tokens 64 --head-engine head \
  > inference-head32.log 2>&1
cp artifacts/inference-result.json artifacts/inference-result-head32.json
cp artifacts/inference-result.jpg artifacts/inference-result-head32.jpg

OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 timeout --signal=TERM --kill-after=30 300 \
  venv/bin/python -u trt_probe.py --model model --out artifacts \
  --stage generate --image input.jpg --label person --tokens 64 --head-engine head-aligned \
  > inference-head16.log 2>&1
```

推荐头只有存在对应 parity 记录才允许使用。检查生成 token、文本、结束符、框的合法范围，并打开带框图片确认位置。token 数达到上限但没有完整结束，不能当作正常完成。

本次图片生成 40 个 token、6 个有效框，两种输出头的 token、完整文本和坐标全部相同。这里只做了一张真实图片一致性验证，不是检测召回率、人脸准确率或多场景产品验收。

### 8.4 计时和内存如何解读

| 指标 | FP32 输出头 | 推荐 FP16 对齐输出头 |
| --- | ---: | ---: |
| 视觉计算 | 217.8ms | 216.9ms |
| 首次文本计算（prefill） | 670.6ms | 615.5ms |
| 完整生成 | 10.450s | 9.972s |
| 图片计算：视觉 + 完整生成 | 10.668s | 10.189s |
| 函数入口至结果（含首次加载） | 32.191s | 27.864s |

prefill 已包含在完整生成时间里，不要重复相加。首次加载计时不包括解释器启动和顶层模块导入。约 4 token/s 不是视频帧率；整图约 0.098 张/秒。

构建及推理整机 RAM 采样峰值 11673MiB（约 11.4GiB），包括系统与试验任务。PyTorch 记录的 CUDA 分配峰值约 36.7MB 只覆盖它管理的缓冲，不包含 TensorRT 权重/上下文；不能说整个模型仅用几十 MB 显存。

```bash
cd "$TASK"
venv/bin/python collect_report.py > report-summary.log 2>&1
```

该脚本依赖 `model-sha256.txt`、`resources.log` 和构建结果；它列出 39 个有效引擎（包含 FP32 备用头）。报告中的 `cuda` 字段来自 `torch.version.cuda`，系统 nvcc 版本需要单独记录。

## 9. 恢复生产与验收

先确认试验推理/构建进程已结束，停止资源采样。根据 PID 文件查看命令行，确认属于本次任务后再停止对应进程；不要使用宽泛的 `pkill python` 或 `pkill tegrastats`。`timeout` 的 PID 可能是父进程，取消构建时还需检查其子进程是否退出，不能只杀父进程便立即启动另一轮。

按依赖恢复，**只恢复停服前清单里的服务/容器**。下列辅助函数只判断清单，不执行自动 enable：

```bash
cd "$TASK"
start_unit() {
  if grep -qxF "$1" services-before.txt; then sudo systemctl start "$1"; fi
}
start_container() {
  if grep -qxF "$1" containers-before.txt; then docker start "$1"; fi
}

start_unit ainvr-license.service
start_container ainvr-postgres
start_container ainvr-mongo
start_container ainvr-srs
```

等待数据库与授权可用，再继续。PG 可以这样检查：

```bash
cd "$TASK"
if grep -qxF ainvr-postgres containers-before.txt; then
  docker exec ainvr-postgres pg_isready
fi
```

确认返回接受连接，授权服务已就绪，MongoDB/SRS 正常后：

```bash
cd "$TASK"
start_container ainvr-backend
start_container ainvr-web
for unit in ainvr-os-helper ainvr-restart-helper ainvr-srs-observer \
    ainvr-remote-assist ainvr-ingest ainvr-recorder ai-service; do
  start_unit "$unit.service"
done
start_unit ainvr-license-enforcer.service
```

授权执行器最后启动。确认 `/health` 与日志显示授权就绪、允许业务，再观察流恢复；不要仅凭 `systemctl start` 成功就结束维护。

### 9.1 健康检查

```bash
systemctl --failed --no-pager
cd "$TASK"
while IFS= read -r unit; do
  systemctl show "$unit" -p ActiveState -p SubState -p NRestarts
done < services-before.txt
while IFS= read -r container; do
  docker inspect --format '{{.Name}} running={{.State.Running}} oom={{.State.OOMKilled}}' "$container"
done < containers-before.txt

curl --noproxy '*' -fsS http://127.0.0.1:8000/health
curl --noproxy '*' -fsS http://127.0.0.1:8100/v1/recorder/health
curl --noproxy '*' -fsS http://127.0.0.1/api/health
curl --noproxy '*' -fsS http://127.0.0.1:1985/api/v1/streams/
```

本机检查要绕过代理：Python `urllib` 默认会继承代理环境，可使用 `ProxyHandler({})`；curl 用 `--noproxy '*'`。本轮一度收到代理产生的 502，不是本机健康接口本身故障。

验收清单：

- 原运行服务和容器全部恢复，无新增 OOM、失败单元或异常重启；
- AI 授权就绪、允许运行，预期通道运行，归档连接正常；
- 录像存储健康，实际产生新录像文件，段大小及时间持续增长；
- SRS 发布方活跃，源流和 AI 输出流帧数持续增长，而不仅是连接记录存在；
- 控制台与页面返回成功；
- AI 应用日志与录像日志没有新的持续错误，归档实际写入恢复；
- 允许相机/AI 自动重连和模型预热时间，对比恢复前后状态。

上次最终恢复 9 个服务、5 个容器，AI 两路运行/归档连接 2/2、SRS 四路活跃并产生新录像。启动初期小门曾离线，随后自行恢复，因此不要把第一个瞬时读数当作最终结论。

AI 应用日志在 `/home/sunrise/ainvr/ai-service/logs/ai_service.log`。私有控制接口需要当前有效凭据，静态配置里的旧 key 可能已失效；不要为体检取消鉴权或把服务环境文件/令牌打印进报告。

## 10. 产物保留、清理与重新编译

### 10.1 必须保留

- 原始两份权重、对应配置/索引/分词器/模型代码及 SHA-256；
- 已验证脚本和测试版本、软件版本、构建配置；
- 38 个推荐引擎、FP32 备用头、`embedding.npy`；
- 每引擎数值对照、测试日志、整图结果与带框图片；
- 停服前清单、资源采样、恢复验收记录与维护时间。

### 10.2 可清理的中间文件

完整验证后，可按清单清理**仅本次任务生成的 ONNX 及外置张量中间文件**，它们能由权重和脚本重新导出。本轮已清理约 14.30GiB，记录在 `cleaned-intermediates.json`。删除前确认规范路径位于本次 `TASK/artifacts`、没有仍在运行的导出/构建任务，不跟随权重符号链接清理原始文件。

不要对 `ai-service/models`、授权状态、数据库、生产备份或整个 `out/` 执行清空。模型文件属于独立交付材料，本试验不要求重新打包现有业务/模型离线包。

### 10.3 复用与重建

相同权重/脚本/软件组合下，可以用已有验证产物重复推理；修改模型结构、mask、提示模板、精度或 TensorRT 版本后，应使用新目录完整重建。当前脚本通过“文件存在”避免重复构建，**不是带内容哈希的构建缓存**，不会自动判断旧引擎是否过时。

正式发布前需要把试验工具整理为可版本追踪的构建工具包，补充引擎与源码/权重哈希绑定、全模型多场景精度验收、长时间稳定性、生命周期和资源释放测试，再开发 AI 微服务适配器。不要仅把原型引擎复制到生产模型目录就当作接入完成。

## 11. 常见失败与处理

| 现象 | 检查与处理 |
| --- | --- |
| 找不到配置/词表/自定义模块 | 两个权重不是完整模型目录；补齐同版本配套文件 |
| `CHECKPOINT_OK` 未出现 | 检查索引、分片 SHA、张量数量和传输完整性，停止构建 |
| 缺少 PyTorch/TensorRT 或 CUDA 不可用 | 检查系统 Jetson 环境与虚拟环境共享设置，不用普通桌面包覆盖 |
| `set_shape` 看似失败 | 本版本成功可返回 `None`，只以明确 `False` 判失败 |
| 输出全 NaN/Inf | 立即判验收失败；先用 FP32 备用头定位，再测试对齐 FP16 方案 |
| `embedding.npy` 不存在 | 尚未运行 `--stage head`，只构建对齐头不够 |
| 有 `.engine` 但没有 parity | 构建不等于验证，补做数值检查，禁止直接使用 |
| 提示容量超限 | 视觉占 256 token，提示与输出合计必须不超过 384；不能只增加 `--tokens` |
| 构建时间长、内存逼近上限 | 确认业务已正常停服、没有重复任务，保持串行构建；不要无限加并发 |
| 当前目录错误 | `run_build.py` 以脚本目录为根，对齐头脚本依赖工作目录；所有命令先进入 `TASK` |
| `/usr/bin/time` 不存在 | 本板未安装；使用脚本已有的单调时钟计时，不把包装命令失败误认模型失败 |
| 本机健康检查 502 | 排除 HTTP 代理影响后再判断服务 |
| 恢复后通道暂时离线 | 检查相机发布、帧数、重连日志、归档及新录像，等待预热后复查 |
| 旧引擎在新环境加载失败 | 在目标板重新构建，不假定跨 GPU/TensorRT 可移植 |

## 12. 最小完成标准

只有同时满足“权重完整 → 数学/模板测试通过 → 各引擎数值有限且对照通过 → 真图正常生成与框有效 → 结果/资源留档 → 原业务恢复并有新产物”，本轮编译试验才算完成。

本轮已满足上述可行性标准；它证明本板 TensorRT FP16 混合精度路线可运行，尚不等于实时产品适配或完整准确率验收。

## 13. 使用方法、输入输出结构与识别描述

本节以当前 `trt_probe.py` 的实际接口为准。它是命令行单图片试验程序，没有 HTTP 请求接口，也没有接入控制台通道配置、视频循环、SEI 或识别历史归档。

### 13.1 已编译后的最小调用

已有全部已验证产物时，不需要重复编译。先安排资源空闲的验证窗口；下面命令会实际加载模型并占用 GPU/内存，不要把它作为生产在线无成本的健康检查。

```bash
cd /home/sunrise/ainvr/out/locateanything-trt-20261010-icivac
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 timeout --signal=TERM --kill-after=30 300 \
  venv/bin/python -u trt_probe.py \
  --model model --out artifacts --stage generate \
  --image input.jpg --label person --tokens 64 --head-engine head-aligned
```

将 `--image` 换成自己的本地图片路径，将 `--label` 换成目标描述即可改变本次定位任务，无需为每个描述重新编译引擎。描述更长会改变 token 数与推理负载；固定缓存容量仍需满足第 3.2 节限制。

输入图片由 Pillow 打开并转换为 RGB，本轮验证格式为 JPEG。其他图片格式取决于本机 Pillow 支持，尚未逐种测试。当前没有直接传入 RTMP/RTSP/SRT/WebRTC 地址的入口；视频需要另行取得帧后调用，连续视频与多请求运行器尚未实现。

### 13.2 外部输入字段

| 命令参数 | 类型 / 默认值 | 实际含义 |
| --- | --- | --- |
| `--stage` | 字符串，必填 | 使用阶段为 `generate`；其他值用于检查或构建 |
| `--model` | 本地目录，必填 | 配套配置、分词器、权重及模型代码所在目录 |
| `--out` | 本地目录，必填 | **既读取引擎/词嵌入，又写入结果**；不能随意改成没有引擎的空目录 |
| `--image` | 本地图片路径 | `generate` 必须提供；当前命令解析器没有提前把它设为必填，漏填会在打开图片时失败 |
| `--label` | 字符串，默认 `person` | 拼入定位提示词的目标描述，名称虽叫 label，但不限于单个类别词 |
| `--tokens` | 整数，默认 `64` | 最大生成 token 数，不是框数或视频帧数；使用正整数，提示 token 数加它不得超过 384 |
| `--head-engine` | `head` / `head-aligned`，默认 `head` | 默认是 FP32 备用头；要用推荐 FP16 头必须显式写 `head-aligned` |

当前没有温度、top-p 或 beam search 参数，每步对 logits 做 `argmax`，属于贪心自回归生成。没有多模型并行或多标签任务队列接口。

### 13.3 “识别标签”与输入提示词的关系

这个模型本轮走的是**图像 + 文本描述 → 定位框**。用户提供想找什么，模型在图像中生成符合描述的实例坐标；不是先输出固定类别清单再按 label 筛选。

`make_prompt(label)` 实际拼装以下模板（示意中把 256 个占位符简写，不能照这个简写串直接送模型）：

```text
<|im_start|>system
You are a helpful assistant.
<|im_end|>
<|im_start|>user
<image 1><img>[连续 256 个 <IMG_CONTEXT>]</img>Locate all the instances that matches the following description: person.<|im_end|>
<|im_start|>assistant
```

其中 `person` 来自 `--label person`，不是写死的类别编号。程序将图片特征放到 256 个 `<IMG_CONTEXT>` 对应位置，再让模型生成回答。保留模板特殊标记和换行，普通目标描述应仅放入 `--label`，不要自行插入 `<|im_end|>`、`<img>` 等协议标记。

| `--label` 示例 | 实际提示词中插入的描述 | 希望查找的对象 | 验证状态 |
| --- | --- | --- | --- |
| `person` | `...description: person.` | 图像中的人 | 本轮实图已验证 |
| `face` | `...description: face.` | 人脸区域 | 调用方法可用，尚未验证本原型的效果；不能等同专用人脸检测器 |
| `a person wearing a red shirt` | `...description: a person wearing a red shirt.` | 穿红色上衣的人 | 属性描述用法示例，需真实图片验证 |
| `the person on the left` | `...description: the person on the left.` | 左侧的人 | 空间关系描述用法示例，需真实图片验证 |

多词描述必须整体加引号，例如：

```bash
cd /home/sunrise/ainvr/out/locateanything-trt-20261010-icivac
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 timeout --signal=TERM --kill-after=30 300 \
  venv/bin/python -u trt_probe.py --model model --out artifacts \
  --stage generate --image input.jpg \
  --label 'a person wearing a red shirt' --tokens 64 --head-engine head-aligned
```

这只是参数与提示词关系示例，不表示红衣属性识别已验收。不同语言、描述长度、指代和属性组合都可能影响效果；当前只有英文 `person` 的实图记录，中文描述效果尚未验证。

不能把 `--label 'person, car, face'` 当作三个独立类别请求：当前程序只把整个字符串插入**一条描述**，没有拆分规则，也没有每类结果分组契约。需要分别查询时，当前可以对同一图片分别调用并在每次结束后保存结果与请求描述；这会重复加载/推理、增加耗时。共享视觉特征或一次多描述调度是后续开发内容。

更换 label 不改变权重，也不会把模型训练成该类别。模型是否理解某个描述、是否能找全，需要单独验收。标签不是人员姓名、身份库匹配结果或跟踪 ID。

### 13.4 输出文件与 JSON 字段

每次成功执行会在 `--out` 指定目录写入：

- `inference-result.json`：原始生成文本、像素框、完成状态和计时；
- `inference-result.jpg`：在**原输入图片**上画绿色矩形的结果图；
- 标准输出中的 `TOKEN` 行与 `INFERENCE_RESULT`：生成进度与最终报告，可重定向到本次日志。

同目录再次执行会覆盖这两个结果文件。对比不同描述或图片时，应在每次完成后复制到独立结果目录；不要为避免覆盖而把 `--out` 改到缺少引擎的目录。

本轮真实输出结构如下，数值按实测记录取舍显示：

```json
{
  "mode": "causal_ar",
  "head_engine": "head-aligned",
  "tensorrt": "10.3.0",
  "prompt_tokens": 295,
  "generated_tokens": 40,
  "vision_ms": 216.85445199545939,
  "prefill_ms": 615.5290549941128,
  "generation_seconds": 9.972267898992868,
  "tokens_per_second": 4.011123688728793,
  "image_compute_seconds": 10.189122350988328,
  "cold_total_seconds": 27.864034295998863,
  "response": "<ref>person</ref><box><123><264><200><592></box><box><228><176><342><654></box><box><377><314><425><559></box><box><412><353><450><524></box><box><582><414><605><516></box><box><931><426><970><529></box><|im_end|>",
  "boxes": [[55,118,90,265],[102,79,153,293],[169,141,190,250],[185,158,202,235],[261,185,271,231],[417,191,435,237]],
  "image": "input.jpg",
  "cuda_max_allocated": 36664832,
  "complete": true
}
```

| 输出字段 | 类型 / 单位 | 含义及边界 |
| --- | --- | --- |
| `mode` | 字符串 | 当前固定 `causal_ar`，不是 MTP |
| `head_engine` / `tensorrt` | 字符串 | 选用输出头与运行库版本 |
| `prompt_tokens` | 整数 | 实际拼装模板分词后的长度，包括视觉占位符 |
| `generated_tokens` | 整数 | 本次生成数量，包括生成的结束 token |
| `response` | 字符串 | 原始带特殊标记的回答，保留给协议与准确性检查 |
| `boxes` | 整数二维数组 | 原输入图片像素坐标，每项 `[x1,y1,x2,y2]`，不是 `[x,y,w,h]` |
| `image` | 字符串 | 调用时传入的图片路径，不是图片内容或唯一 ID |
| `complete` | 布尔值 | 最后生成 token 是否为 tokenizer 的 EOS；不表示检测准确或找全 |
| `vision_ms` | 毫秒 | 视觉阶段计算 |
| `prefill_ms` | 毫秒 | 首次文本/视觉混合序列计算到第一个 token 的耗时，已在生成耗时中 |
| `generation_seconds` | 秒 | prefill 与后续逐 token 生成合计 |
| `tokens_per_second` | token/秒 | 生成数量除以生成耗时，不是图片 FPS |
| `image_compute_seconds` | 秒 | 视觉加完整生成，不含全部首次加载成本 |
| `cold_total_seconds` | 秒 | `generate()` 函数入口至报告构造时的耗时，含加载，不含解释器/顶层导入 |
| `cuda_max_allocated` | 字节 | PyTorch 管理的 CUDA 分配峰值，不含完整 TensorRT 模型内存 |

**目前 JSON 不包含 `label`、完整输入 `prompt`、每个框的类别、置信度、原始图像尺寸、请求 ID、帧时间戳、track ID 或分割掩膜。**需要结果与请求可追溯时，调用方必须另外保存这些输入元数据，不能从文件名或框顺序猜测。

### 13.5 回答协议、标签与坐标转换

实测原始回答：

```text
<ref>person</ref><box><123><264><200><592></box>…<|im_end|>
```

- `<ref>person</ref>` 是模型生成的目标描述文本，本次与请求一致；代码没有强制其总与 `--label` 相同。
- 每个 `<box>` 含四个坐标 token，顺序为 `x1,y1,x2,y2`，数值范围 0～1000。
- 当前 `parse_boxes()` 只抽取匹配格式的框，**不解析或绑定 `<ref>` 与各个框**；如果模型生成多组不同 ref，JSON 的 `boxes` 仍是扁平列表。
- 当前没有置信度分数。不能把 token logits、生成速度或余弦对照值用作目标置信度。
- 本轮没有返回分割掩膜或跨帧身份关联；六个框也不构成六个稳定的跟踪对象 ID。

设原输入图片宽高为 `W,H`，转换使用：

```text
x1_pixel = round(x1_token × W / 1000)
y1_pixel = round(y1_token × H / 1000)
x2_pixel = round(x2_token × W / 1000)
y2_pixel = round(y2_token × H / 1000)
```

例如本次输入 448×448，`<123><264><200><592>` 对应 `[55,118,90,265]`。这不是 448×448 模型空间中固定的输出尺寸；给原尺寸不同的图片时，JSON 按其原宽高映射。

若下游 SEI 或绘图接口需要左上角加宽高，调用方转换为 `x=x1, y=y1, w=x2-x1, h=y2-y1`。若要切出像素区域，注意 token 1000 会映射到 `W/H` 边界；矩形边界、数组切片和离散像素索引应按各自约定处理，不能把 `W` 当成合法最后一列索引。

解析器检查数值范围及顺序，但当前允许零面积框，转换取整也可能使非常小的框变为零宽/高。消费方应检查 `x2 > x1`、`y2 > y1` 并记录异常；不要默默把异常结果当作有效检测。

`boxes: []` 只说明当前文本未提取到匹配的框。必须结合 `complete` 和 `response` 判断：可能确实没有目标，也可能协议格式异常或生成被截断。当前没有为“正常无目标”和“格式解析失败”提供独立状态；在产品适配时需要补齐，不能据此直接认定画面无人。

### 13.6 调用方应保存的上下文与后续产品接入

为了让结果可用于后续回放、关联和跟踪，建议调用方与原始输出一起保留：

| 上下文 | 用途 |
| --- | --- |
| 请求 ID、源通道 ID、原帧序号及时间戳 | 把结果绑定到正确图片/视频帧 |
| 原图宽高、实际缩放/投影参数 | 将模型框映射到原图、全景视图或 SEI 所需坐标空间 |
| 用户目标描述、实际模板/模板版本 | 明确该次查询找什么，避免不同 label 结果混用 |
| 权重与引擎版本/哈希 | 结果回溯、不同版本对照 |
| 原始 response、解析状态与 complete | 区分无目标、协议错误、截断和正常完成 |

以上是接入要求，**当前原型没有自动生成完整上下文封装**。要进入现有 AI NVR，需要新增适配器，完成取帧、请求调度、坐标转换、错误分类、归档及 SEI 契约，再验证实时性能。不能把当前 JSON 原样当作现有 SEI 检测结构写入，也不能因为都叫“标签”就复用固定类别编号逻辑。
