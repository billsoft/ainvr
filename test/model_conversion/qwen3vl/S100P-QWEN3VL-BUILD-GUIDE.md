# 新手手册：把 Qwen3-VL 编译成 S100P BPU 模型（照着做 + 为什么这样做）

> 本手册配合同目录的 [S100P-QWEN3VL-ALARM-REVIEW-BPU.md](S100P-QWEN3VL-ALARM-REVIEW-BPU.md)（结果与脚本目录）使用。
> 目标读者：会用命令行和 Python、但没做过端侧量化部署的人。读完应能独立重编 Qwen3-VL-4B，并能判断换一个模型要改什么。
> 预计总耗时：准备半天；O0 编译约 1 天（无人值守）；O2 约半天；板测约 1 小时。

---

## 第一部分：先懂这些概念（每条都写了"为什么"）

### 1. BPU、HBM、ION
- **BPU**：S100P 上的 AI 加速器（nash-m 架构）。项目规定神经网络计算只能在 BPU 上跑，不能退回 CPU（见仓库 AGENTS.md）。
- **HBM**：BPU 能加载的模型文件，是编译工具链的最终产物。一个 HBM 里可以有多个"程序"，比如本项目的 s1 和 s256 两档。
- **ION 内存池**：BPU 能用的专用内存，约 8 GB，板上所有模型共用。**换模型前先算 HBM 总大小能不能放进去**，这是可行性的第一道门。本模型 HBM 约 5.3 GB，运行峰值 5.72 GB。

### 2. 为什么一定要量化（W8A16）
- 芯片的矩阵乘、全连接只接受 int8/int16 输入，**没有 FP16 这条路**，查 SDK 算子约束表 `hbir_op_J6E_constraint` 就能确认。
- **W8A16**：权重 8 位整数，激活（中间结果）16 位整数。权重常驻内存，压到 8 位能省一半带宽和内存；激活里经常有很大的离群值，8 位装不下，所以留 16 位。
- **逐行对称量化**：权重矩阵每一行一个缩放系数 `scale = 该行最大绝对值 / 127`，整数码取值范围 ±127。

### 3. 伪量化与校准
- 官方 `leap_llm` 的写法是：模型还是用 PyTorch 搭，但在每个算子前后插入"伪量化节点"（`ConstFakeQuant`）。它记录这个张量的取值范围（absmax），编译时据此决定 int16 的缩放系数。
- **校准**：用一批真实输入跑一遍 PyTorch 前向，让每个伪量化节点记下最大值。**校准数据要像真实使用的数据**，否则范围不对：范围太窄会截断（饱和），太宽会损失精度。
- 坑：`ConstFakeQuant.forward` 只记录范围、不真的量化，所以"PyTorch 伪量化 vs BF16"的误差偏乐观，**真实误差要看编译器参考**（见第 5 条）。

### 4. GPTQ
- 直接四舍五入（RTN）时，每个权重各自取最近的整数。GPTQ 则逐列量化，用校准数据的二阶统计把每一列的舍入误差"补偿"到还没量化的列上，让**这一层的输出**尽量接近原值。
- **格式和 RTN 完全一样**（仍是逐行 ±127），所以编译器和运行时都不用改，只是整数码换了。喂给官方构建器时要把 `absmax_weight` 固定为 `127×scale`，否则构建器会自己重算 scale，GPTQ 的结果就丢了（见 `qwen3vl_bpu_text_v1.gptq_override`）。

### 5. 编译链与"编译器参考"
```
PyTorch(带伪量化) --export--> export.bc --convert--> converted.bc --compile(O0/O2)--> model.hbo --link--> model.hbm
```
- **数值在 convert 这一步就定死了**。converted.bc 里的函数 `f(*inputs)` 可以在 PC 上直接调用，结果叫"编译器参考"，它和板上的输出应当**逐位相同**。
- **O0 / O2**：优化级别，只影响速度，不改变任何一个比特。O0 编得快，用来验证精度；O2 慢但运行快。**同一份 converted.bc 先编 O0 验精度，再编 O2 只验逐位相同**，这样 O2 自动继承 O0 的精度结论。

### 6. 为什么切组，s1 / s256 是什么
- 36 层一起编，编译时间和内存都扛不住，所以切成 4 组、每组 9 层（视觉 24 块也切成 4 组）。
- **s256**：一次输入 256 个 token，用于 prefill（把整段提示词喂进去）。**s1**：一次 1 个 token，用于最后那个决策 token，或以后逐字生成。
- 两档放在同一个 HBM 里，**共享同一份权重**，文件只比单档大一点。

### 7. KV cache 的排布（本项目约定）
- 每层的 K/V 缓存是一个固定长度 1024 的数组，**历史 token 右对齐**放在末尾。
- 每次调用时，模型先丢掉最前面 q 行、再在末尾接上本次新算出的 q 行，掩码要和这个排布一一对应（`chunk_inputs` / `chunk_call`）。
- 主机侧只负责拼接数组，不做任何神经计算。

### 8. Qwen3-VL 特有的结构
- **q/k RMSNorm**：Qwen3 在做 RoPE 之前，先对每个注意力头的 q、k 做一次 RMSNorm。官方 Omni 构建器里没有这一步，是我们加的。
- **交错 MRoPE**：图像 token 的位置是三维的（t, h, w）。我们在**主机侧**直接算好 cos/sin 表再喂进图，图本身不用改。
- **DeepStack**：视觉第 5、11、17 块的特征，分别加到文字第 0、1、2 层输出的图像 token 位置上。所以只有文字第 0 组需要多 3 个输入。

### 9. 告警复审怎么出结果
- 只看模型**第一个输出 token** 里"是"和"否"两个词的 logit，对这两个值做 softmax 就是概率，不需要逐字生成。
- 所以速度几乎全花在视觉和 prefill 上。决策头也只保留了 22 个词的行，计算量很小。

### 10. 怎么判断"量化得好不好"
- 口径：与原版 BF16 的"是/否"判定一致率（阈值 0.3、0.5、0.7），加上概率偏差 |Δp|。**不是**对人工标注的准确率，标注准确率另外列。
- 数据分三份、互不重叠：**校准集**用来定范围和做 GPTQ，**开发集**用来排查、挑方案，**独立评估集**只在最后跑一次出报告。拿开发集上的好成绩当结论，是最常见的错误。

---

## 第二部分：环境准备（一次性）

### 硬件与磁盘
- PC：NVIDIA GPU（≥16 GB 显存，只用于 BF16 参考、校准和 GPTQ）；内存 ≥32 GB（编一个 9 层文字组峰值约 24 GB）；8 核以上 CPU。
- 磁盘：编译目录**不要放在 C 盘**，因为 Docker 的虚拟磁盘只会变大、不会自动缩小，一定要放到挂载进来的 D 盘或 F 盘。至少预留 150 GB：每个文字组的 O0 产物约 12 GB。
- 板子：`ssh s100p`（root@192.168.100.189，已配免密）；大文件一律放 `/mnt/ainvr-ssd/`，系统盘很小。

### 工具链
- Docker 镜像：`ai_toolchain_ubuntu_22_s100_s600_gpu:v3.7.0`（地平线 OE 3.7.0 GPU 版）。
- **LLM 工具链**：官方 `D-Robotics_LLM_S100_1.0.0_SDK.tar.gz`
  （下载地址 `https://d-robotics-aitoolchain.oss-cn-beijing.aliyuncs.com/llm_s100/1.0.0/D-Robotics_LLM_S100_1.0.0_SDK.tar.gz`，
  sha256 `ecd4eb8c3faed60428dbb45eb833deef1c119acb1c907c7ac157a1b87661256f`）。里面有两样东西要用：
  - `hbdk4_compiler-4.4.8a2…whl`：要**隔离安装**（`pip install --target <目录>`），不能覆盖镜像自带的 4.7.5；
  - `leap_llm-1.0.0` 的源码：解压后作为 `leap-source-overlay` 使用。
  - 现成的一份在 `D:\codex-task-staging\qwen3vl\sdk\`（`sdk448-isolated/`、`leap-source-overlay/`），备份在 `F:\la-container-backup-20261021\locate-oellm-research-v1.tar`。
- 参考依赖：transformers 4.57.1 等，加载 Qwen3-VL 的 BF16 原版用（`sdk/locate-reference-deps/`，代码里通过 `sys.path` 引入，不装进系统）。

### 建容器（PowerShell 或 Git Bash；Git Bash 下先 `export MSYS_NO_PATHCONV=1`，否则路径会被改写）
```bash
docker run -d --name ainvr-qwen3vl-20261020 --gpus all --cpus 8 --memory 28g --shm-size 8g \
  -v D:/models:/models:ro -v D:/codex-task-staging/qwen3vl/work:/qwork -v D:/codex-task-staging/qwen3vl/sdk:/opt/qsdk \
  -w /qwork --entrypoint /bin/sleep ai_toolchain_ubuntu_22_s100_s600_gpu:v3.7.0 infinity
```
冒烟检查：容器里能 `from hbdk4.compiler import leap`（`PYTHONPATH=/opt/qsdk/leap-source-overlay:/opt/qsdk/sdk448-isolated/python`），也能加载 Qwen3VL。

---

## 第三部分：分步操作（每步：命令 → 耗时 → 产物 → 怎样算通过）

以下命令都在容器里执行（`docker exec -it ainvr-qwen3vl-20261020 bash`），脚本在 `/qwork/scripts`。

| # | 做什么 | 命令（要点） | 耗时 | 通过标准 |
|---|---|---|---|---|
| 1 | 选数据 | Windows 侧 `python host_select_coco_v1.py`；拷录像后 `extract_camera_frames_v1.py`；`build_items_v2.py` | 30 分钟 | 三份数据互不重叠，有真报也有误报 |
| 2 | BF16 参考 | `reference_bf16_v2.py`（三份全跑） | 约 20 分钟 | 回答"是"的比例别太偏；v1 描述 90% 回答"否"，所以改成了 v2 |
| 3 | PC 仿真 | `sim_text_quant_v1.py rtn …`，再跑 `… gptq … --save-codes` | GPTQ 约 1.5 小时 | 用 `score_yesno_v1.py` 看，开发集一致率应在 99% 左右，否则先别编 |
| 4 | 抓校准状态 | `QDEV=cpu QITEMS=v2 capture_states_v1.py calib 32 0,8,9,17,18,26,27,35 /qwork/cap/text-calib-v2`；开发集抓 3 条；`capture_vision_v1.py calib 24 …`；开发集抓 4 条 | 约 1 小时 | 每条一个目录，里面有 in/out/k/v/cos/sin/deepstack |
| 5 | **先做探针** | `build_text_group_v1.py --first 3 --count 1 …`（单层）；`--first 0 --count 3`（DeepStack）；`build_vision_group_v1.py --first 0 --last 1` | 各约 10 分钟 | 构建成功（BPU-only 断言通过）；上板跑 `board_validate_fixtures_v1.py`，逐位一致 |
| 6 | O0 全量 | 视觉 `run_vision_groups_o0_v3.sh`；文字和决策头 `run_remaining_o0_v3c.sh` | **严格串行**，约 1 天 | 每个包 status=done，上板逐位一致 |
| 7 | O0 上板端到端 | 板上：`board_guard_eval_v2.sh 1800 -- python3 board_run_alarm_v1.py manifest-o0-v3.json items-dev-v2.jsonl out.jsonl` | 约 25 分钟 | `score_board_v1.py dev out.jsonl` 一致率达到你定的门槛 |
| 8 | O2 | `run_o2_v3b.sh`（临时目录放 D 盘） | 视觉每组约 1 小时，文字每组约 1.8 小时 | 上板逐位一致；O2 跑开发集，与 O0 **逐条完全相同** |
| 9 | 独立评估 | 同第 7 步，换成 manifest-o2-v3.json 和 items-final-v2.jsonl | 约 30 分钟 | 出报告；只跑这一次 |

板端评估包用 `prepare_board_items_v1.py` 生成，然后上传到 `/mnt/ainvr-ssd/qwen3vl/run-v1/`。清单文件 `manifest-*.json` 里写明各个 HBM 包的相对路径。

> ⚠️ **禁止读取 `/sys/kernel/debug/ion/`**（2026-10-22 已证实会使本板内核崩溃重启）。测内存只用 `/proc/<pid>/fdinfo` 的 dma-buf 统计（下限），见 `test/ION-DEBUGFS-FORBIDDEN.md`。

**生产保护（必须做）**：板上有生产 AI 在跑，两套模型放不进同一个 ION 内存池。所以端到端板测一律用 `board_guard_eval_v2.sh` 包起来：它会有界暂停 AI 服务，结束时（不管成功失败）自动恢复，并检查确实恢复了。录像和接入不会动。只做逐位校验时，单个包很小，可以在生产运行时直接跑。

---

## 第四部分：排错（症状 → 原因 → 处理）

| 症状 | 原因 | 处理 |
|---|---|---|
| 构建最后报 `neural CPU fallback` | 有浮点算子（clip/gelu/exp/sub）落到了 CPU，convert 日志里会出现 `hbtl.call: native::*` | 让这些算子前后都接 16 位伪量化，clip 用固定范围的饱和伪量化代替 |
| 某组编译器参考误差几十倍，但 torch 正常 | 查表类激活函数（gelu/silu/exp）的输入范围太大（ViT 第 23 块达到 ±412） | 用 taps 脚本逐中间张量比对定位；改成分段计算 |
| 末 token 误差远大于整体误差 | 开头 token 的超大激活掩盖了它 | 单独看 s1 和最后一行 |
| 注意力误差偏大 | mask 太大撑宽了 int16 量化范围，或者是 softmax 本身的误差 | 用 `score_range_v1.py` 量出有效分数范围，再定 mask；softmax 用量化域分解 |
| 构建进程被系统结束、status 停住不动 | 内存不足（OOM）：两个 9 层 s256 编译器仿真同时跑就会超 | 严格串行，配合内存看门狗 |
| `ConstantWriter::addConstant: Input/output error` | 磁盘满了 | 清理作废产物，开磁盘守护 |
| 板上校验找不到形状对应的程序 | 包里混进了非目录文件（比如 status.json） | 只遍历 `s*` 子目录 |
| 构建一启动就失败 | 构建器要求进程是进程组组长 | 用 `setsid -w python3 …` 启动 |

---

## 第五部分：迁移到别的模型（例如 Qwen3-VL-8B）

### 先算账，再动手
1. 从 `config.json` 读出文字部分的 hidden(H)、层数(L)、头数、KV 头数、head_dim、MLP 宽度(I)、词表(V)，以及视觉部分的 depth、hidden、deepstack 层号。
2. 估算 INT8 权重：每层约 `2·H·(头数·hd) + 2·H·(KV头数·hd) + 3·H·I`，乘以层数，再加词表头 `V·H` 和视觉部分。HBM 实际大小约为权重的 1.05 倍，运行时还要加几百 MB。
3. **Qwen3-VL-4B**：文字约 3.63B + 头 0.39B + 视觉约 0.4B，HBM 合计 5.3 GB，**能放下**。
4. **Qwen3-VL-8B**（H=4096、I=12288，以实际 config 为准）：文字约 6.95B + 头 0.62B，约 7.6 GB，再加视觉，**超过约 8 GB 的 ION 内存池，按本方案（W8）放不下**。可选的路：
   - 文字 MLP 改 W4（`FakeQuantLinear` 支持 `w_bits=4`），但 LocateAnything 上 W4 MLP 的质量曾经大幅下降，必须重新评估；
   - 按组分时加载，代价是每次请求都要重新装载，速度会大降；
   - 换更小的模型。

### 要改的地方
| 位置 | 改什么 |
|---|---|
| `qwen3vl_bpu_text_v1.py` 顶部常量 | `HID, HD, NH, NKV`；`text_config()` 里的断言 |
| `qwen3vl_bpu_vision_v1.py` 顶部常量 | `GH, GW`（输入分辨率）、`D, HEADS, FF, OUT`、`DEEPSTACK` 层号；Block/Merger 的权重名 |
| `qwen3vl_host_v1.py` | `H, W`、`THETA`、`SECTION`（mrope_section）、`HID, NKV` |
| 分组 | 层数变了，就改各个 run 脚本里的 `--first/--count` 和视觉组边界；DeepStack 必须落在第 0 组里 |
| `build_head_v1.py` | 决策词表（每个词必须是单 token） |
| 数据与提示词 | `qwen3vl_common_v1.PROMPT`、`build_items_v2.py` |

### 推荐顺序（每一步失败就停，别往下走）
1. 内存账算得过 → 2. PC 上 BF16 跑通，主机侧对齐验证（`verify_host_v1.py`） → 3. PC 仿真 W8 的一致率 → 4. 三类探针（单层、DeepStack 组、单个视觉块）都上板逐位一致，**并 grep 日志确认没有 native 算子** → 5. 全量 O0 → 6. 板上开发集 → 7. O2 → 8. 独立评估。

---

## 附：名词速查
| 名词 | 一句话 |
|---|---|
| BF16 | 原版浮点精度，作为"标准答案" |
| RTN | 直接四舍五入的量化 |
| absmax | 张量的最大绝对值，用来决定量化缩放系数 |
| 饱和 | 实际值超出校准范围，被截断成边界值 |
| taps | 把中间张量也作为输出，逐个比对误差 |
| profile（s1/s256） | 同一个模型的不同输入形状程序 |
| 契约 `.hbm.ainvr.json` | ai-service 加载 HBM 时校验用的说明文件（本模型还没做） |
