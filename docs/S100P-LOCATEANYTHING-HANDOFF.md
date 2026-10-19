# S100P LocateAnything 量化、编译与运行时交接

## 当前交接入口：2026-10-18 晚（UTC+8，v325）

**先读本节。** 下面"2026-10-18（v295）"那一节写的 v11 已不再是现网，那一节和更早的内容都是历史记录。

### 现网已部署：GPTQ INT8 高精度文字解码（v14 / v320）

- 后端入口：`ai-service/runtime/locateanything_bpu_text_gptq8_o2_eval_executor_v14.py`（SHA 27da9bc4…）
- 契约：`BASE/official-full-family-w8a16-text-gptq8-o2-eval-v320.json`（SHA a4f584ab8e7f8742006bb4345e5ce7307846129534580715e543774401f92381）
- 结构：在 v11（视觉 27 块 O2）的基础上，把 4 个文字解码组换成 GPTQ 校准的逐行 INT8，同 BC O2 编译。
  - 视觉、embedding、词表头和生成逻辑都不变。
  - 仍是 76 个逻辑程序、46 个物理 HBM，只走 BPU。
- 安装记录：`test/results/locateanything-text-gptq8-runtime-upgrade-v323.json`。
  - 安装后已确认真实结果和 SEI 正常，用户配置没变，录像连续。
  - AI + 后端保守内存峰值 6.44GB。
- **一键回滚到 v11**：
  - 只读检查：`python3 test/model_conversion/rollback_locateanything_to_v11_v324.py`（已通过）
  - 执行回滚（root）：`python3 test/model_conversion/rollback_locateanything_to_v11_v324.py --execute`
  - 执行时会恢复安装前保存的 drop-in 和 sidecar 链接，重启 AI 与后端，并等待真实结果和 SEI 恢复。**回滚尚未实际演练过**，只做了只读检查。
- 只读健康检查：`runuser -u sunrise -- python3 test/model_conversion/read_locateanything_prefill_three_groups_health_v216.py --contract-sha a4f584ab8e7f8742006bb4345e5ce7307846129534580715e543774401f92381`
- 大门通道已按用户要求改回 **2 秒一帧**（inference_fps=0.5，2026-10-19 已持久化）。BPU 在 1fps 自适应满载时占用约 77.5%；不要再自行调成满载。

### 质量与速度证据（独立 160 项，全 BPU，与原版 BF16 对比的一致率，不是标注 AP）

| IoU | v11 P/R | GPTQ INT8 P/R | 上限（BPU 视觉 + BF16 文字） |
|---|---|---|---|
| 0.5 | 75.3/79.5 | **87.8/89.0** | 90.6/88.1 |
| 0.75 | 70.6/74.4 | **77.5/78.5** | 80.8/78.5 |
| 0.9 | 59.3/62.6 | **64.9/65.8** | 68.1/66.2 |

- 有效输出 159/160，失败项仍只有用户已接受的 117。
- O2 与 O0 的 160 项生成结果逐项完全一致（token 和 logprob 都相同）。
- 组件验证 v319：4 组各 2736 次比较，逐位一致。AR 提速 1.55–1.86 倍，prefill 提速约 1.95 倍。
- 速度 v323：两次独立的完整 160 运行，条件相同（AI 暂停、私有后端、相同输入），逐例耗时中位比 1.0037，速度与 v11 持平。
  - 两个模型族合起来超出 ION 容量，所以没有做严格的交错 A/B。
- 正式质量发布仍未通过，目前按试用部署。

### 源码与手册（2026-10-19 已备份进项目，待用户提交）

- **完整编译手册**：[S100P-LOCATEANYTHING-GPTQ-INT8-RECIPE.md](S100P-LOCATEANYTHING-GPTQ-INT8-RECIPE.md)，内容包括配方、步骤 0–11、各脚本 SHA、已否决路线和踩过的坑。
- **速度与精度根因分析**：[S100P-LOCATEANYTHING-SPEED-ACCURACY-ANALYSIS.md](S100P-LOCATEANYTHING-SPEED-ACCURACY-ANALYSIS.md)。
- **以前只放在 PC TASK 里的容器脚本，已全部拷入 `test/model_conversion/`**，逐个核对过哈希，换行符为 LF：
  - 编译主线：GPTQ v307、构建 v311/v312（含 `run_gptq8_groups_v312.sh`）、打包 v312 / v318b、O2 编译 v318（含 `run_text_gptq8_o2_v318.sh`）、补链接 v318c、主机侧打包 `host_package_o2_v318d.py`；
  - 实验与评估：视觉配方 v296（探针 / 链接 / 驱动）、O2 视觉构建 v283、评估 v298/v303、计分 v304/v317、仿真 v305/v306、网格探针 v308–v310。
- 运行在板上的脚本（v282–v324，执行器 v11–v14）一直保存在项目中，本次没有改动。
- PC 容器 `/opt` 中的大体积产物（GPTQ 码、各组 BC/HBO）不在项目里。O2 组产物在 D 盘 `o2-v318/`，板上在 `BASE/text-gptq8-group-*-o2-v318-board-package`。

### 配方与版本链（PC 容器 ainvr-locateanything-w4-20261014）

- **GPTQ 码**：`gptq_locateanything_text_row8_v307.py`，输出在容器 `/opt/locate-text-gptq-row8-v307`（252 个 npz）。
  - 方法参考 IST-DASLab：act-order、damping .01、block 128、scale=absmax/127、码值 ±127。
  - 校准集为旧 72 项开发集，与独立 160 项不重叠。
- **O0 构建**：`build_locateanything_official_qwen_group_gptq8_v312.py`，即官方构建器加上 GPTQ 覆盖，absmax 固定为 127×scale。
- **O2 编译**：`compile_text_gptq8_groups_o2_v318.py`（opt2/balance100/max_l2m 0）；`link_text_gptq8_o2_v318c.py` 用于补链接。
  - 产物在 `D:/codex-task-staging/ainvr-locateanything-w4/o2-v318/`，板上在 `BASE/text-gptq8-group-*-o2-v318-board-package`。
- **评估链**：v313/v13/v314/v315（O0）→ v320/v14/v321/v322（O2）→ v323 安装 → v324 回滚。
- **已否决**：
  - 视觉 qk16/sv16：独立 160 项 57.1/62.1，更差。
  - 视觉 W16：单块 190MB，装不下。
  - group32 朴素量化：P 和 R 此消彼长，没有整体提升。
  - FP16：nash-m 的 linear/matmul 只支持 int8/int16（见 SDK 文档 hbir_op_J6E_constraint_v2.mdx）。
- **经验与坑**：
  - 中间产物不要写进 C 盘上的 Docker vhdx。用 `/work` 先写，写完马上移到 D 盘，并加 C 盘余量守护。曾因此把 C 盘写满，Docker 数据盘一度识别为"无文件系统"，已由用户修复。
  - tar 解包不要带根条目 `.`，否则会改掉目标目录的属主，要加 `--no-same-owner`。
  - 契约里的解码组 key 是两位补零的格式（decoder-group-00-08-ar）。

---

## 历史交接入口（已过期，v295）：2026-10-18（UTC+8）

**先读本节。** 下面的"2026-10-17T22:42 交接入口"及更早内容都是历史快照：那里写的 v9、正在编译的任务、PID 均已过期。

### 现网已部署（即目前最优方案）

- 后端为 **v11**（视觉 27 块 O2 + 四组 prefill O2 + 四组 AR O2 + 词表头 O2）。
  - 入口：`ai-service/runtime/locateanything_bpu_vision_o2_executor_v11.py`（SHA d4efa1bd5cca6bbc4b923fa7a467001b84ead18b1a87ebaf3f69f3246cdb1bcf）
  - 契约：`BASE/official-full-family-w8a16-vision-o2-v284.json`（SHA d471046ae84930c385db34841154583e2476a1d0fe210f5985debee31a29fbf2）
  - systemd 覆盖文件 `60-ainvr-runtime-reused-io.conf` 中，ExecStart 和 ExecStartPost 都指向 v11/v284，与实际进程的命令行一致。
- 模型结构不变：完整 36 层 Qwen、27 个视觉块、152681 词表，W8/mixed-A16，原提示、greedy/EOS、KV512；只走 BPU，无 CPU 神经回退。
- 质量：完整 160 项与 v10/v9 逐项一致，失败只保留用户已接受的 117。P/R 仍是试用水平，正式质量发布未通过。
- **"大门"通道采集已由 10 秒改为 1 秒目标、自适应**（inference_fps=1.0，已持久化到配置，配置 SHA c8706ba9…）。实际约 0.57fps，做完一张立即取最新帧。
  - 过载计数会持续上涨，这是自适应跳过过期帧，不是故障。
  - 判断有没有问题，看错误数、归档反压、SEI 迟到这三项。
- 现网实测（v293）：推理 p50 1.64 秒、p95 2.04 秒，BPU 平均 77.5%，0 错误 / 0 归档反压 / 0 SEI 迟到。
- 只读健康检查：
  `runuser -u sunrise -- python3 test/model_conversion/read_locateanything_prefill_three_groups_health_v216.py --contract-sha d471046ae84930c385db34841154583e2476a1d0fe210f5985debee31a29fbf2`
  预期：ok/ready、76 个逻辑程序、46 个物理 HBM 常驻。

### 这一轮的版本链与证据（全部在 test/results，失败记录也保留）

| 步骤 | 文件 | 结果 |
|---|---|---|
| 第四组 prefill O2（自动链） | locateanything-prefill-all-pipeline-v253.json、…-runtime-upgrade-v251.json | v10 已安装，每张再省约 103ms |
| 视觉同 BC O2 编译 | PC `vision_all27_same_bc_o2_build_v283.py`；D 盘 `vision-all27-o2-v283` | opt2，其余为 HBDK 默认，HBM 63c7e861… |
| 视觉组件板验 | vision-all27-o2-v283-board-package-guard-v283.json | 972 段逐字节一致，整链 374→177ms |
| 契约与执行器 | `locateanything_official_vision_o2_v284.py`、executor v11 | 只替换 27 个 vision-block spec |
| 完整 160 | locateanything-vision-o2-full160-guard-v286.json（客户端 v285） | 全一致，失败只有 117，25794 次调用 |
| 整图 A/B | locateanything-vision-o2-full-image-A-B-v287-guard.json | 中位每张省 194ms，短例 1.69→1.48 秒 |
| 事务安装 | locateanything-vision-o2-runtime-upgrade-v288.json | 通过，配置不变，录像连续，峰值 6.45GB |
| 采集间隔试验 | v289（2.5 秒）、v291（2 秒）、v293（1 秒） | 2.5 秒按当时规则因过载计数回退；2 秒为 0.498fps / BPU 65%；1 秒为 0.569fps / BPU 77.5%，保留 1 秒 |
| BPU 满载 / 重叠探针 | v292（视觉）、v294（生成节奏） | 满载约 97%（视觉）；两请求重叠吞吐 0.98–1.0 倍，**没有收益，不再做** |
| 失败记录 | PC `mtp-full160-event-continuation-v228.json` | v225 MTP 研究因容器内存余量不足 6GiB 未能启动；当时视觉编译与它同在一个容器，可能是原因之一。未重试 |

### 后台任务

- 本轮没有遗留的运行中任务。PC 容器里只有 D 盘句柄 holder 672834（hold_locateanything_task_directory_v131.py），不要结束它。
- 第四组编译、v208、v228、视觉编译均已退出；Windows 端 v254 也已结束。

### 速度结论与下一步（详见 D 盘 `speed-analysis-2026-10-17/LOCATEANYTHING-SPEED-ROOT-CAUSE.md`）

- 生成阶段受 DDR 带宽限制：每个 token 约 129ms，其中 BPU 约 100ms。官方同维度 Qwen2.5-Omni-3B 在本板实测 decode 为 83ms/token。
- BPU 占用率读数约 80% 时吞吐已经到顶，再增加并发请求也没有收益（v292/v294）。
- 再提速只能减少每帧的计算量，按风险从低到高：
  1. prefill chunk 从 256 缩小（官方 chunk_size 取值范围为 [128,2048]），需新编 profile 并做完整 160 回归；
  2. 按官方 Omni 的结构把解码合成一张图（36 层 + norm + 头），编译代价大；
  3. W4（官方 1.5B 上 Q4 比 Q8 快 1.46 倍）；之前 W4 MLP 的 P 只有 24%，质量风险最高。
- 派生新版本时照 v283–v288 的套路，只替换版本常量（执行器、加载器、基线 raw、当前契约、报告路径）。
- 远程 heredoc 必须写成 `<<'EOF'`。容器里有大任务时，不要并行编译。

---

## 历史交接入口（已过期，v281）：2026-10-17T22:42:47+08:00（UTC+8）

**先读本节。下方 v7/v8、“第二组仍编译”等段落是历史快照，不是当前状态。**

这次只整理交接，没有启动新实验、编译、部署或改用户配置。本聊天的持续目标已在客户端暂停；**已启动的后台编译、守护和自动续跑不会随聊天暂停而退出，目前仍存活，且后续可能自动执行板验和合格候选部署。** 接手时先查看现有任务，不要再启动一份。历史PID、fd和“100%”日志不代表当前终态。

### 现网已经部署到哪一步

- 当前 **v9 / 三组 prefill O2**，AR 四组均已 O2；prefill 的0..8、9..17、18..26已 O2，27..35仍是原 O0。不是旧v7，也不是已装四组的v10。
- 完整36层Qwen、27视觉块、152681词表，W8/mixed-A16，原提示、greedy/EOS与KV512保持；生产神经计算只走BPU。
- 入口：`/home/sunrise/ainvr/ai-service/runtime/locateanything_bpu_prefill_groups_executor_v9.py`，SHA256 `a5f903f4674a2d0af973b8c36bce591ce279ccdb273b1dc702e67c2474b7487e`。
- 契约：`/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1/official-full-family-w8a16-prefill-g0-g9-g18-v204.json`，SHA256 `5d64ea7d9a7b268e47ccd8f81f18f986a45bd98f43744a642bd1ac31a063032d`。
- 真正安装证据：`test/results/locateanything-prefill-three-groups-runtime-upgrade-v217.json` 与流水线 `locateanything-prefill-three-groups-pipeline-v232.json`，均已终态成功；完整160项/25794 BPU调用，token、概率、终止、JSON与v8一致，原117失败保留，没有新增失败。P59.3074%/R62.5571%是对原生BF16框的一致性，不是标注AP；仍为用户接受的试用，正式质量发布未通过。
- 第三组整图22请求/10配对中位再省108.335ms：固定70token例10.080→9.943秒，短7token例约1.89→1.77秒；这些是prepared-image对照，不是现场所有4K图片都固定此速度。AI+后端保守内存峰6,409,093,120B，口径RSS一次+全部live TID ION，可能重复/漏采，不能称精确去重峰值。
- 当前服务快照：后端2705357/start14391304，原生AI2705642/start14392594；录像2418/start1093、接入2386/start1090持续。用户“大门”/helmet/头盔，`live/xm → live/ai-n2q08c`，4K3840×1920→模型224×448，每10秒采集，AI输出约95秒延后对帧SEI。配置SHA256 `42a17b36cba8e04c1d4ab582240f34413d6fab6b7fae0570fcc320b40a2c3de6`。
- v279实时35次识别/35次SEI、7784个延迟输出访问单元，通道running/无last_error；处理p50约2012ms、p95约2398ms，实测采集周期中位10000.53ms。这些是该窗口快照；“采集实测9.x秒”与“处理p95毫秒”不同。服务刚启动的首张加载会暂时抬高p95。

### 仍在运行的任务（不要重复启动）

现有官方GPU容器 `ainvr-locateanything-w4-20261014`，镜像 `ai_toolchain_ubuntu_22_s100_s600_gpu:v3.7.0`；SDK4.4.8a2隔离路径 `/opt/locate-oellm-research-v1/sdk448-isolated/python`。8CPU/26GiB配额保持；此轮没有调整Docker/WSL/矿工。

| 任务 | 已核实身份与状态 | 当前结果或输出 |
|---|---|---|
| 第四组prefill同BC O2，`compile_locateanything_w8_prefill_g27_v207.py` | worker673373/start20878468，R，CPUticks285100；guard673371/start20877605，S | 仍在编译，无候选终态/板验结论；`official-w8-prefill-g27-o2-v207-guard.json` |
| 原串行续跑v208 | 673254/start20481896，S | 等第四组编译退出；`prefill-serial-continuation-v208.json` |
| PC verified-MTP完整160续跑v228 | 673261/start20556038，S/CPUticks1 | 精确等v208退出后执行v225；尚未运行，不是BPU方案 |
| 电脑端第四组传输/板验续跑v254 | Windows119112，创建epoch1792244423.872，命令为TASK内v254 | 等v228研究资源释放后打包/传输/启动v253；`locateanything-group27-to-board-event-v254.json` |
| D目录holder v131 | 672834/start19235986，S，fd9 | 容器路径 `/proc/672834/fd/9` 指向任务D盘，不要结束这个holder |

第四组输出：Windows `D:\codex-task-staging\ainvr-locateanything-w4\prefill-g27-o2-v207`；容器 `/proc/672834/fd/9/prefill-g27-o2-v207`。原BC `8092057c402bf00bab8e899cf7380d205624a5afd5994be051f39018326eb660`，固定AR HBO `3af3ea3d08359e8d9cd8754f3e3222008f72f4b6c58181d3a816ae501308c2a3`。目前RSS约2.82GB、C余8.27GB、D余116.1GB；这是v280快照，不是承诺后续余量。

人工最多每300秒检查一次，v280观察epoch 1792248167.465，下一次不得早于epoch 1792248467.465。精确pidfd事件续跑不轮询进度。日志静默/进度100不重启；核对PID+start_ticks+argv、终态、最终文件hash。没有总编译时长上限，原内存/磁盘保护与逐请求期限仍有效。

### 自动续跑将做什么、接手者还剩什么

1. 第四组真正结束后，v208保存真实终态；v228占用空出的PC资源跑v225完整160 verified-MTP研究。MTP失败不等于第四组编译失败，二者的报告分开。
2. v254等待v228实际退出和资源释放，再调用v236打包，v238传板SSD，v253进行板验。由于研究排在传输前，编译成功到板验之间可能还有等待；不要另开一份大模型/GPU研究抢内存。
3. v253顺序：v239组件192调用/3648数组 → v243构造完整四组契约 → v246/v247完整160等价 → v249整图A/B → 仅全部通过才v251事务安装v10并验证真实原生识别/SEI/95秒出流、内存和录像连续性。v10代码存在不代表已部署。当前尚无v253/v238报告，符合未启动状态。
4. 若某步失败，读该步raw/guard、核对finally已恢复原服务，再定位原因；失败不自动重试。不要跳过组件或完整160门槛，也不直接手工执行安装脚本。基线3组契约/质量报告/源码均绑定hash，改服务或脚本前要协调已有自动续跑。
5. 四组完成也只完成这轮prefill优化；进一步逐词生成提速仍需证据。连续推理时BPU驱动ratio已实测约82.507%/峰100%，不是“每张只用17%”；DDR实测不证明带宽已饱和，不能承诺简单填满利用率就倍速。

### 哪些研究不要误当成功版本

- **缓存工作区 v268—v273：不部署。** 真实/合成输入逐字节一致，CPU prepare每组少0.6909ms，但真实整图22请求中位只省8.310ms，未过既定50ms收益门槛；长输出只少87.746ms。没有完整160候选准入，原始失败screen与清理证明保留，现网仍v9。
- **直接hybrid/MTP：不部署、不为其编译。** 原BF16 hybrid两配方160项分别93/92无效；verified-MTP七开发例虽然减少forward，但严格token第6/117不同。v164第6点位差5在既有容差10内，v184差18超限，两种事实都保留。下一份v225完整160结果尚未产生，不得宣称通过。
- 失败例外仍只有用户接受的117；原生参考52/105/117无效不授予候选新豁免。不得截断坏输出伪造终止/框；不裁层、不缩词表、不改原提示来冒充同模型提速。
- v256 DDR采样退出0却0数据，明确失败；真正采用v258的45秒451表、v262分析。该窗口是连续私有完整160，不是现网10秒采集窗口，也不是MAC利用率。

### 接手只读检查

在开发板：

```sh
cd /home/sunrise/ainvr
systemctl is-active ainvr-ai ainvr-locateanything-official-bpu ainvr-recorder ainvr-ingest
runuser -u sunrise -- python3 test/model_conversion/read_locateanything_prefill_three_groups_health_v216.py --contract-sha 5d64ea7d9a7b268e47ccd8f81f18f986a45bd98f43744a642bd1ac31a063032d
```

预期76逻辑program、46物理HBM/常驻、slow、BPU且无CPU neural fallback。健康查询不发送新图片、不代替完整验收。若自动v251已成功，应先从sidecar/实际进程读新的四组契约SHA，不能继续强套本节三组hash。

在Windows PC，TASK=`C:\Users\bills\.codex\tmp\ainvr-locateanything-w4\official-llm-v1`。Docker管理接口曾卡住，继续用TASK中的 `locateanything_owned_container_transport_v113.py`；它只适用于已核实的本容器/当前命名空间，不重启Docker/WSL、不另建容器。读取示例（用现有Python）：

```python
import sys
sys.path.insert(0, r'C:\Users\bills\.codex\tmp\ainvr-locateanything-w4\official-llm-v1')
from locateanything_owned_container_transport_v113 import run
r = run(['/usr/bin/python3', '-c', "import json;from pathlib import Path;print(Path('/work/official-llm-v1/official-w8-prefill-g27-o2-v207-guard.json').read_text())"], timeout=30)
print(r.stdout.decode('utf-8'))
```

先核实进程身份，不机械照抄PID；不要读/打印私有密钥、访问密码或API key。认证只用既有系统SSH；板API key仅在进程内存中从私有配置读取。

### 文档、源码与可带走的备份

权威源码只在 `/home/sunrise/ainvr/test/model_conversion` 与 `ai-service/runtime`；TASK是电脑编译挂载/阅读副本。大文件BASE名称含w4，但当前部署是W8路线。最新实验总账v36；本次交接元数据 `test/results/locateanything-current-handoff-v281.json` 绑定v279/v280实时快照。

- D盘原源码快照v152、追加v158/v167/v193/v230/v241保留；v265补齐第四组完整流水线15源码，v276补齐缓存实验7源码。对应 `D:\codex-task-staging\ainvr-locateanything-w4\handoff-v265-addendum` 和 `handoff-v276-addendum`，均已逐文件hash核验。
- 本次交接追加包v281含此入口、就绪/实验记录、实时快照和索引，下载后须再核验hash。它是文档/小源码包，不含权重、BC/HBO/HBM、校准/fixtures、完整SDK、虚拟环境、板端ABI扩展或凭据；删容器前必须另备份这些大文件。
- 原始权重只读：`D:\code\LocateAnything-3B`；板大文件：`/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1`；编译大文件：D盘任务目录及容器 `/opt/locate-*`。
- 刚开始的运行时参考调研只有社区作者仓库 `ruisv/bllm` 固定revision `f2e59b6ecfb2e543e1adaac5c35fd5ef707c0965` 的少量只读源码，位于TASK `references/`；不是地瓜官方运行库，尚未完成源码审计、未执行/安装、没有LocateAnything速度证明，不据此改生产或执行文档中的系统设置。

### 继续工作的边界

开发只改远程AINVR；TecheAI/其他项目/子模块只读。保留当前用户手工SRS输入/输出和历史；SRS通道只在接入管理建立。优先AI+后端<8GB，用户放宽上限10.4GB；目标解码至少5token/s，任何收益必须实际量测。AI测速可有界暂停但finally恢复**测试开始时**的配置与95秒真实SEI，不停录像/接入，不恢复历史默认。保持内存/磁盘余量，不碰矿工、不改密码、不存凭据、不自动提交/推送。正式质量未达标不要称正式发布。

---


更新：2026-10-17。这是接手入口；版本化结果、源文件和 SHA256 清单才是具体实验的证据。编译状态是写入时快照，不能据此重启任务。

## 已部署版本概览（其余旧实验按各自版本阅读）

当前为 v11：视觉27块O2 + 四组prefill O2 + 四组AR O2；完整36/27/152681保持。P/R与用户接受的117例外未变，正式质量验收未通过。大门通道为1秒自适应满载。入口、契约、证据与下一步见文首“当前交接入口：2026-10-18”。

## 文件在哪里

| 位置 | 用途与保留要求 |
|---|---|
| 开发板 `/home/sunrise/ainvr` | 第一方源码的权威位置。现有大量未提交修改，不覆盖、不重置；本次没有提交或推送。 |
| `test/model_conversion/` | 量化、导出、编译、打包、板验、守护、分析脚本。当前目录含大量历史版本；下方精选索引优先。 |
| `ai-service/runtime/` | 已部署/历史 Python 后端和独立虚拟环境；当前入口是 v9；以文首快照和实际systemd覆盖为准。 |
| `ai-service/src/adapters/locateanything_bpu_adapter.hpp` | 原生推理子类与输入尺寸、结果几何、后端契约对接；电脑暂存同名文件已落后，以远程源码为准。 |
| `test/results/` | 版本化验收、失败、内存、速度、部署及恢复报告；不能只留成功报告。 |
| `/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1` | 大文件研究根目录（下文简称 BASE）。名称含 w4 不代表其中所有模型都是 INT4；当前 W8 契约也在这里。保留模型、converted BC、HBO、ports、compiler fixtures、状态、原参数/校准来源。 |
| `C:\Users\bills\.codex\tmp\ainvr-locateanything-w4\official-llm-v1` | PC 任务暂存（简称 TASK），脚本镜像、小结果、日志；不是可随手清空的缓存。容器映射到 `/work/official-llm-v1`。 |
| `D:\codex-task-staging\ainvr-locateanything-w4` | PC 大文件 SSD 暂存，包含新编译输出、原生 hybrid 诊断、旧包迁移记录。 |
| `D:\code\LocateAnything-3B` | 用户原始完整模型，包含两片 safetensors、索引、模型源码和 tokenizer；只读保留。容器 `/model` 与 `/opt/locate-original-weights` 是原始模型入口/已核对副本。 |
| 容器 `/opt/locate-official-qwen-group-*-w8a16-*` | 官方模块重建、校准、converted BC、AR/prefill HBO 与 HBM；不能只备份最终 HBM。 |
| 容器 `/opt/locate-oellm-research-v1` | 隔离 SDK4.4.8a2 和 LEAP overlay；不要和另一个 SDK4.7.5 的 Python/动态库混用。 |
| BASE `/runtime-reuse-io-v108/_locate_reused_io_v1.so` | 板端编译的持久 IO 私有扩展；绑定 aarch64、Python/pybind 和板端 DNN/UCP ABI，不能用 x86 扩展替换。 |

官方 GPU 容器：`ainvr-locateanything-w4-20261014`，镜像 `ai_toolchain_ubuntu_22_s100_s600_gpu:v3.7.0`。现有配额8 CPU、27917287424 B内存。GPU可用于PC量化/原版参考；不等于最终 BPU 链接全过程由 GPU 完成。多个容器不能把一个编译图自动拆成分布式编译。

当前 Docker 管理接口曾卡住，使用 `locateanything_owned_container_transport_v113.py` 进入已存在的容器命名空间。它绑定该容器身份和 cgroup；是故障时的任务专用工具，不是可跨机器直接使用的通用 Docker 替代品。不要为查状态反复重启 Docker/WSL、复制启动编译或改变其他任务配额。

## 现网入口和只读核对

当前入口与契约、只读健康命令见文首当前交接快照。实际systemd覆盖文件是 `/etc/systemd/system/ainvr-locateanything-official-bpu.service.d/60-ainvr-runtime-reused-io.conf`；ExecStart与ExecStartPost必须一致，仅看基础unit会误认旧版本。原生客户端缓存契约SHA，切换不能只重启Python后端。私有持久IO扩展 `_locate_reused_io_v1.so` SHA256仍是 `fc69ef48c28cbc43952b426848846e381f5c46de9059cc50d778a7c2351f106e`。

大门 `live/xm → live/ai-n2q08c`、4K3840×1920→模型224×448、helmet/头盔、10秒采集、95秒SEI对帧延迟保持。页面采集间隔与单张处理p95是不同指标。所有SRS通道统一在接入管理配置；AI只选择已有输入和输出。API密钥只在运行时内存读取，交接包无认证配置/密码/私钥。

## 量化与编译链路如何接手

1. **冻结原版和参考**：原权重、tokenizer、提示、视觉预处理、greedy/EOS、原生模式分别固定；区分开发/校准/独立验收集，保留图像与输入数组 SHA。`reference_locateanything_independent_final_v2.py` 与原版参考验证/评分脚本负责这条证据链。
2. **采集与量化**：`capture_locateanything_original_decoder_calibration_v1.py`、`build_locateanything_official_qwen_group_v3.py` 保留原参数身份，使用官方 Qwen 模块及 W8/A16 路线。按9层分组共享 AR1/prefill256，KV容量512。原生36层的全部组都必须接齐。
3. **先验证 O0**：保留 export/converted BC、量化范围、原始参数来源、ports 与 compiler reference fixtures。反汇编确认神经计算均在 BPU；导出成功或 HBM 文件存在不等于板端可用。
4. **同 BC 编译 O2**：`compile_locateanything_official_qwen_ar2_pref0_v1.py` 历史上只优化 AR，复用 prefill；当前 `compile_locateanything_w8_prefill_g27_v207.py` 则只优化层27..35的 prefill，复用已通过的 AR HBO。O2不重新校准；新量化配方需要单独验收，不能冒用旧成绩。
5. **组件板验**：打包固定来源/hash、先上传SSD，在独立进程比较相同输入下全部输出数组；再测预热时延与内存。当前首组验证192次调用/3648数组逐位一致。不能仅拿一个输出或短样例判断整网。
6. **完整家族与整图复验**：验证36/27/全词表、原KV/RoPE/可见性/原始token选择；完整160项检查生成ID、概率、终止和JSON，保留所有失败。再做同图交替/受控A/B与原生AI+后端内存测量。新模式/新量化不可自动继承旧例外；调优后需要新的独立最终数据。
7. **事务安装**：当前第三组已执行v217事务安装；第四组须由v253完成所有门槛后调用v251。旧v138仅作历史准入/回滚参考，不直接重跑。资格和输入源码全部固定hash、默认准入检查；在修改前重新核对当前配置。版本化脚本写死旧输出路径与期望hash，不是每次直接执行的一键安装器。
8. **真实链路验收**：检查原有8/32槽模型仍可选、现用通道/归档/SEI/95秒延迟输出真实恢复。AI-only测试必须 finally 恢复“测试开始时”的用户配置；不恢复历史默认、不停原录像/接入。服务启动返回成功不等于HTTP已就绪，需有界等待与真实新结果证明。

当前校准范围的来源包含旧候选进入层的状态，builder会重算原BF16条件块参考；不能称为整个原版轨迹上的完全无损校准。官方 W8 模块也不等于直接替换为官方另一款模型；LocateAnything 的结构、词表、视觉网络和输出协议必须保持。

## 历史任务快照：以下旧PID已经过期，当前任务见文首

2026-10-17 本次观察 epoch **1792233808.490098**：

- 第二组 prefill guard PID672931/start_ticks19545538；worker PID672932/start_ticks19545809，状态R/CPUticks189190，正在 `compiling_same_bc_prefill_o2`。最多每300秒人工查一次；后续最早检查 epoch1792234108.490098。进度条100或日志静默都不能当作终态。
- 输出：Windows `D:\codex-task-staging\ainvr-locateanything-w4\prefill-g9-o2-v141`；容器通过 `/proc/672834/fd/9/prefill-g9-o2-v141` 访问。
- D目录holder PID672834/start_ticks19235986，fd9；这是临时进程句柄，重启后会失效。持久文件在Windows D盘。使用前核对 marker `.ainvr-task-owner.json`、PID/start_ticks/argv，不能机械复用本文PID。
- 精确终态观察器：PID673006/start_ticks19630621，`watch_locateanything_prefill_terminal_v145.py`；状态文件 TASK `official-w8-prefill-g9-terminal-v145.json`。它只等待原guard退出并校验产物，不执行板验/部署，不重启编译。
- 量化 BC `a52474d1e5bbe69b72d84e80db57e751f78c5a01688ab9af3898cbafe15b6317`；复用AR HBO `3095ffa0adbeac5c7e9c9c4228cd7aca120bcfecb6f0c3cc3c33f8297095807c`。
- 无总实验/编译时长上限，仍保留请求、内存和磁盘保护。当前脚本将输出/TMP放D盘，但官方链接仍观察到C盘瞬时占用；原因未完全证实。不得因为D盘有空闲就忽略C盘预留。
- hybrid研究guard673009已经终态、worker673010已经退出，不沿用它们启动新任务。结果已复制到项目 `test/results/locateanything-native-hybrid-{guard,raw,freeze}-v146.json`。

下一步是等上述**同BC编译终态**，核对全部产物→准备新的层9..17板包→组件逐位/速度→完整160回归/整图收益/内存→符合准入才切换。历史v130打包器只认识首组，不把它直接用于第二组；新的第二组板验入口仍需实现。当前没有启动层18/27的重复编译。

## 已经验证的经验与明确不采用的路线

| 事实 | 后续用途/限制 |
|---|---|
| 历史 INT8 group32 + 5% INT16，旧集69/78/78，P/R均88.46% | PC逻辑混合量化，视觉/解码/头仍依赖BF16；保留作质量锚点，不能说已经编成完整HBM或与160项直接排名。原报告 `locateanything-calibrated-int8-g32-plus5pct-int16-v1.json`。 |
| 完整 W4 MLP/W8 attention O0：P24.0363%、R48.4018% | 完整160项，未达45%试用底线且新增5项失败；不部署、不为它做O2。不是“INT4一定更快/更差”的通用结论，O0/O2和配方同时不同。报告 `locateanything-complete-mixed-o0-versus-w8-v115.json`。 |
| 常驻46HBM + 持久静态IO已通过全160输出一致性 | 避免每token分配DMA/创建线程的有限收益真实存在；保留缓存clean/invalidate、输出自有内存和未完成DMA隔离，不能为了提速删同步。 |
| 首组 prefill O2组件约2.035倍，整图只省约98.8ms | 组件占比不同；不能宣称整图翻倍。AR输出/性能基本不变。 |
| AR balance=2同BC实测速度比约0.9893，未达1.03收益门槛 | 保存已完成HBO/恢复链接工具，勿再给其他组重复相同编译；官方建议是起点，实测才决定采用。 |
| 运行时阶段11请求/1861调用：submit/wait/release约84.52%，输入copy+clean1.87%，输出invalidate/copy0.40%，KV准备/提交6.54% | wait包含设备执行/调度/释放，不是纯MAC利用率。CPU线程/搬运优化空间不能凭17%均值推断；AR设备路径/轮次更值得研究。报告 `locateanything-runtime-phase-analysis-v144.json`。 |
| 10秒取帧窗口平均BPU约17%；1秒取帧窗口约75% | 空闲间隔解释了很大一部分均值；1秒设置有过载跳帧，不是单图达到1FPS，不能说还有83%算力可直接换速度。 |
| 原版hybrid诊断93/160无效或非终止，6333次forward；旧slow按原代码/长度推导3223次 | 当前样本并未减少总调用，不能为坏输出直接编MTP。后者是推导值，非新做的slow时序A/B；CUDA时间不能当BPU收益。 |
| Linux总内存大仍可能连续DMA/专用池不足 | 记录所有live TID ION，比较分进程顺序装载；旧脚本只看主线程会漏算。不要并排装入两套完整模型再判断单模型内存。 |
| Norm/Softmax/残差/归约精度敏感 | 分清参数精度、激活精度、累加精度、真正算子精度；INT16不等于BF16，文件标注INT4不等于硬件全路径packed INT4。用层级参考与最终生成验证，不能只看一层L2。 |

官方对照 Qwen2.5-Omni-3B Q8 的14.03 token/s /5.5GB来自不同模型和测试口径；板上旧实测约12 token/s不能替代当前模型数据。S100P目标 nash-m，core_num只能1、max_l2m_size只能0；jobs是主机编译并行度，不是BPU核数。不要套用S600参数或论坛机器人答复。

官方参考：

- [S100 LLM工具链](https://developer.d-robotics.cc/rdk_s_doc/Advanced_development/toolchain_development/LLM_Toolchain/s100_LLM_Toolchain)
- [编译参数](https://toolchain.d-robotics.cc/guide/ptq/ptq_tool/hb_compile/convert.html)
- [HBDK API](https://toolchain.d-robotics.cc/en/guide/advanced_content/hbdk_api_reference.html)

实际SDK `apis.py` SHA256 `c69336d1d6e8c96281957a7acf5ca35ecb3fcf68e62765978988557016d3d846`。网页曾直接打开超时，已用官方检索正文和容器实装源码共同核对；参数/版本变化需再次验证。

## 验收报告入口

所有下列文件位于项目 `test/results/`；原始大结果在 BASE 对应目录。哈希清单另附，不靠文件名推断通过。

| 文件 | 读什么 |
|---|---|
| `locateanything-official-root-cause-evidence-v28.json` | 本次交接前的综合证据总账；其中运行中状态是旧快照。 |
| `locateanything-runtime-regression-guard-v111.json` | v6全160输出/终止/JSON一致性、原117失败保留。 |
| `locateanything-prefill-o2-full160-guard-v135.json` | v7首组prefill O2全160，25794次BPU调用。 |
| `locateanything-prefill-full-image-A-B-v136-guard.json` | 22请求/10组完整图A/B，约98.8ms收益。 |
| `locateanything-prefill-runtime-admission-v138.json` | 固定hash准入与拒绝错误资格的负控。 |
| `locateanything-prefill-runtime-upgrade-v138.json` | 实际事务安装、内存、配置/服务恢复。 |
| `locateanything-prefill-steady-postinstall-v139.json` | 独立安装后生产新结果/真实SEI/录像持续。 |
| `locateanything-runtime-phase-profile-v143-guard.json` / `locateanything-runtime-phase-analysis-v144.json` | 原生阶段计时和 finally恢复证据。 |
| `locateanything-native-hybrid-raw-v146.json` / `...-guard-v146.json` / `...-freeze-v146.json` | 新失败研究全部160原始输出、原始输入冻结与终态。 |
| `locateanything-handoff-current-observation-v152.json` | 本文编译快照、原生诊断终态与精确进程身份；不代表后续仍在运行。 |
| `yoloe32-final-delivery-v7.json` / `yoloe32-ui-release-acceptance-v7.json` | 已交付YOLOE32及UI证据，8槽保留；与LocateAnything成绩分开。 |

更早历史见 [实验V4](S100P-LOCATEANYTHING-EXPERIMENTS-V4.md)、[V3](S100P-LOCATEANYTHING-EXPERIMENTS-V3.md)、[V2](S100P-LOCATEANYTHING-EXPERIMENTS-V2.md)、[最初实验](S100P-LOCATEANYTHING-EXPERIMENTS.md)。总体就绪记录见 [MODEL-READINESS](S100P-MODEL-READINESS.md)，UI约定见 [MULTI-LABEL-UI](S100P-MULTI-LABEL-UI.md)。历史日志不能覆盖当前已手工更改的配置。

## 精选脚本清单

下表路径相对 `/home/sunrise/ainvr/`。**每项本次都核对存在与SHA256**，完整hash/大小/分类/来源在 `test/results/locateanything-handoff-script-index-v152.json`。标为历史/研究的脚本保留方法，不表示可直接用于现网。多数版本脚本固定旧hash、任务ID、输出路径并拒绝覆盖，应先读源码与产物身份；不要批量运行，甚至不要为查看参数而import带顶层副作用的旧builder。

| 分类 | 路径 | 用途/注意 |
|---|---|---|
| 现用运行器/依赖 | `ai-service/runtime/locateanything_bpu_prefill_o2_executor_v7.py` | 现网后端入口；首组prefill O2、持久IO |
| 现用运行器/依赖 | `ai-service/runtime/locateanything_bpu_reused_io_executor_v6.py` | 前版运行器；回滚/受控A-B参考 |
| 现用运行器/依赖 | `ai-service/runtime/locateanything_prompt.py` | 原tokenizer/提示及输入契约 |
| 现用运行器/依赖 | `ai-service/runtime/locateanything_persistent_request_worker_v1.py` | 持久请求工作进程；不逐图重载模型 |
| 现用运行器/依赖 | `test/model_conversion/locateanything_reused_io_runtime_v1.cpp` | 板端DNN/UCP静态DMA IO；有限等待、隔离未完成DMA |
| 现用运行器/依赖 | `test/model_conversion/locateanything_reused_io_adapter_v1.py` | 私有持久IO Python适配 |
| 现用运行器/依赖 | `test/model_conversion/locateanything_official_program_executor_reused_io_v1.py` | program路径/hash/shape/dtype与所有权准入 |
| 现用运行器/依赖 | `test/model_conversion/locateanything_official_family_v1.py` | 完整家族与76 program组成 |
| 现用运行器/依赖 | `test/model_conversion/locateanything_official_group_routing_v1.py` | KV对齐、RoPE与可见性路由 |
| 现用运行器/依赖 | `test/model_conversion/locateanything_bpu_generation_v1.py` | 完整BPU生成编排；现网slow |
| 现用运行器/依赖 | `test/model_conversion/locateanything_generation_control_v1.py` | 原始生成状态控制；代码支持不等于现网MTP profile存在 |
| 现用运行器/依赖 | `test/model_conversion/locateanything_sampling_v1.py` | 原生token选择/后处理 |
| 现用运行器/依赖 | `test/model_conversion/locateanything_process_memory_v4.py` | RSS一次+所有live TID ION内存采样 |
| 现用运行器/依赖 | `ai-service/src/adapters/locateanything_bpu_adapter.hpp` | 每模型原生推理子类、输入尺寸、后端/SEI接线 |
| 现用运行器/依赖 | `ai-service/src/adapters/locateanything_result_decode.hpp` | 定位框/点解析与结果几何检查 |
| 量化、导出、编译 | `test/model_conversion/capture_locateanything_original_decoder_calibration_v1.py` | 原始解码层校准采集；检查其历史输入配方 |
| 量化、导出、编译 | `test/model_conversion/build_locateanything_official_qwen_group_v3.py` | 官方W8/A16九层分组导出/校准/双profile O0；有顶层副作用 |
| 量化、导出、编译 | `test/model_conversion/compile_locateanything_official_qwen_ar2_pref0_v1.py` | 历史同BC AR O2、保留prefill O0 |
| 量化、导出、编译 | `test/model_conversion/compile_locateanything_official_qwen_group_o2_v1.py` | 历史首组双profile同BC O2；当前新任务用资源守护版 |
| 量化、导出、编译 | `test/model_conversion/compile_locateanything_official_vision_rest_v1.py` | 完整视觉剩余块编译；核对视觉配方/前置来源 |
| 量化、导出、编译 | `test/model_conversion/prepare_locateanything_official_vision_all27_v1.py` | 27视觉块完整板包与来源 |
| 量化、导出、编译 | `test/model_conversion/prepare_locateanything_all_head_fixtures_v1.py` | 全词表head输入/参考fixture |
| 量化、导出、编译 | `test/model_conversion/prepare_locateanything_official_head_o2_board_v1.py` | 历史head O2板包；非整网质量报告 |
| 量化、导出、编译 | `test/model_conversion/compile_locateanything_w8_prefill_g9_v141.py` | 当前运行：第二组同BC prefill O2、AR HBO复用及资源守护 |
| 量化、导出、编译 | `test/model_conversion/watch_locateanything_prefill_terminal_v145.py` | 精确pidfd终态观察；不执行板验/安装 |
| 量化、导出、编译 | `test/model_conversion/hold_locateanything_task_directory_v131.py` | D盘任务目录fd持有；身份/marker保护 |
| 量化、导出、编译 | `test/model_conversion/locateanything_owned_container_transport_v113.py` | 已有官方容器的任务专用传输；绑定命名空间/cgroup |
| 验证、分析、安装 | `test/model_conversion/reference_locateanything_independent_final_v2.py` | 冻结原版BF16完整参考；不是调优后自动成为新未见集 |
| 验证、分析、安装 | `test/model_conversion/validate_locateanything_independent_native_reference_v2.py` | 参考输入/模式/原token语义核对 |
| 验证、分析、安装 | `test/model_conversion/score_locateanything_independent_final_v2.py` | 固定框/点匹配与完整性计分 |
| 验证、分析、安装 | `test/model_conversion/prepare_locateanything_w8_prefill_board_v130.py` | 历史首组同BC板包；不直接用于第二组 |
| 验证、分析、安装 | `test/model_conversion/transfer_locateanything_w8_prefill_v130.py` | 小manifest+二进制直传SSD，减少PC大tar |
| 验证、分析、安装 | `test/model_conversion/benchmark_locateanything_w8_prefill_v130.py` | 首组192调用/3648数组组件A-B；AI-only finally恢复 |
| 验证、分析、安装 | `test/model_conversion/locateanything_official_family_prefill_optimization_v1.py` | 新prefill组成契约及替换组固定 |
| 验证、分析、安装 | `test/model_conversion/locateanything_prefill_component_admission_v1.py` | 组件资格/hash校验 |
| 验证、分析、安装 | `test/model_conversion/regress_locateanything_prefill_o2_v135.py` | 首组O2完整160逐输出/概率/终止/JSON对照 |
| 验证、分析、安装 | `test/model_conversion/guard_locateanything_prefill_o2_v135.py` | 历史v6恢复守护；不能原样恢复到当前v7环境 |
| 验证、分析、安装 | `test/model_conversion/test_locateanything_prefill_admission_v135.py` | 资格准入负控；不发神经推理 |
| 验证、分析、安装 | `test/model_conversion/compare_locateanything_prefill_full_image_v136.py` | 历史完整图A-B；诊断47上下文非生产46内存口径 |
| 验证、分析、安装 | `test/model_conversion/install_locateanything_prefill_runtime_v138.py` | 当前v7事务安装与hash准入；版本固定，先检查再执行 |
| 验证、分析、安装 | `test/model_conversion/read_locateanything_prefill_runtime_health_v138.py` | 当前UID1000只读健康检查；0神经调用 |
| 验证、分析、安装 | `test/model_conversion/observe_locateanything_prefill_postinstall_v139.py` | 安装后新结果、真实SEI、内存、原录像观测 |
| 验证、分析、安装 | `test/model_conversion/profile_locateanything_runtime_phases_v143.py` | 11请求1861调用原生阶段计时；私有进程、不改SDK |
| 验证、分析、安装 | `test/model_conversion/analyze_locateanything_runtime_phases_v144.py` | 核对时间和分母、按类别统计与原始token一致性 |
| 验证、分析、安装 | `test/model_conversion/probe_locateanything_official_hwperf_v125.py` | 原始硬件trace/静态估算对照；不把DDR估算当带宽实测 |
| 历史研究/负面结果 | `test/model_conversion/prepare_locateanything_gptq_reference_v4.py` | 旧GPTQ基准配方/对照保留 |
| 历史研究/负面结果 | `test/model_conversion/prepare_locateanything_gptq_reference_v6_g16.py` | group16变体；失败/回退历史保留 |
| 历史研究/负面结果 | `test/model_conversion/prepare_locateanything_gptq_g32_actorder_v7.py` | group32 actorder历史变体 |
| 历史研究/负面结果 | `test/model_conversion/prepare_locateanything_gptq_sequential_mixed_g32_v8.py` | 顺序混合精度研究；成绩不可冒用到BPU |
| 历史研究/负面结果 | `test/model_conversion/prepare_locateanything_row_gptq_mixed_full36_v3.py` | 完整36层row混合checkpoint研究 |
| 历史研究/负面结果 | `test/model_conversion/build_locateanything_official_qwen_w4_rowgptq_layer_v2.py` | 官方结构上的W4 rowGPTQ层探针；非完整模型通过 |
| 历史研究/负面结果 | `test/model_conversion/compile_locateanything_compact_saved_bc_v1.py` | 紧凑路线保存BC复用；失败质量不继续做O2 |
| 历史研究/负面结果 | `test/model_conversion/compile_locateanything_w8_ar_balance_v119.py` | balance2负面实验保留，不采用 |
| 历史研究/负面结果 | `test/model_conversion/link_locateanything_saved_balance_hbo_v132.py` | 保留HBO恢复链接经验；不重编译/不宣称质量通过 |
| 历史研究/负面结果 | `test/model_conversion/benchmark_locateanything_recovered_balance_v134.py` | balance2受控板端负收益证据 |
| 历史研究/负面结果 | `test/model_conversion/reference_locateanything_native_hybrid_v146.py` | 原版BF16 CUDA完整hybrid诊断；93失败，不是BPU验收 |
| 已交付YOLOE32参考 | `test/model_conversion/compile_saved_bc.py` | YOLOE/组件保存BC重编译参考 |
| 已交付YOLOE32参考 | `test/model_conversion/stage_yoloe32_contract.py` | 32槽独立契约stage；保留8槽 |
| 已交付YOLOE32参考 | `test/model_conversion/capture_yoloe_detector_validation.py` | 完整文字+RepRTA+检测器板端输出 |
| 已交付YOLOE32参考 | `test/model_conversion/compare_yoloe_detector_validation.py` | 固定conf/NMS/IoU与框P/R比较 |
| 已交付YOLOE32参考 | `test/model_conversion/compare_yoloe_component_optimization.py` | 同BC O0/O2数组/速度验证，支持32槽 |
| 已交付YOLOE32参考 | `test/model_conversion/validate_yoloe_free_text_semantics.py` | 自由描述raw-grid gate；失败不得删除 |
| 已交付YOLOE32参考 | `test/model_conversion/validate_yoloe_visible_semantics.py` | 可见最终检测框/换词；与raw失败分别保留 |
| 已交付YOLOE32参考 | `deploy-package/install-yoloe32-s100p.py` | 32槽独立安装；已交付，不覆盖8槽 |

## 保存、迁移与复现边界

1. 除本文、精选源码快照和报告外，还必须保留原权重/索引/tokenizer、校准图像/分区与冻结列表、原版参考、converted BC、量化范围、HBO、HBM、ports、输入输出fixture及对应manifest/status。缺少这些，只有最终HBM不能复现量化或同BC重编译。
2. 板SSD、PC的C/D暂存、Docker/WSL虚拟盘是不同存储，不互为备份。容器删除会丢失未迁出的 `/opt` 工具和产物；Docker/WSL重启会使PID/fd路径失效。此次只制作精选源码+交接包，**没有把全部数十GB模型/环境迁出或完成全环境离线备份**。
3. 精选源码包是阅读/保留快照，包含64个文件，不是完整依赖闭包。仍依赖项目其余模块、板端ABI、官方SDK、校准/参考和原模型，不提供从干净机器一键重建的承诺。源文件hash检查可复现；模型精度/速度必须实际跑板端验收。
4. 新编译终态不能只保存status：校验HBO/HBM hash、反汇编BPU节点、范围与来源；上传先写同目录临时文件，再核对hash并原子替换。保留旧release与回滚指针；更新前CAS核对当前源码/配置，避免覆盖并行开发。
5. 本次交接新增文件，不修改模型、服务、用户配置、旧结果或其他项目。源包不包含密码、API密钥、生产私有配置、虚拟环境、权重或第三方工具链。未提交/推送。

源码包与校验清单的位置见同目录 `S100P-LOCATEANYTHING-HANDOFF-SCRIPTS.md` 及电脑 TASK 的 `README-HANDOFF.md`。后续每次有效实验补充版本化报告与本入口，失败也入账，不覆盖最佳方案。


## 接手增补 v154—v158（源码包v152仍为当时64文件快照）

以下新增源码均在 `test/model_conversion/`，完整hash/大小见 `test/results/locateanything-handoff-script-addendum-v158.json`；没有覆盖或重新标记旧源码包。

| 新文件 | 当前实际验证范围 |
|---|---|
| `locateanything_prefill_g9_admission_v154.py` | 层9..17新schema准入；20负控+1合成正控通过，0神经/服务动作。 |
| `prepare_locateanything_prefill_g9_board_v154.py` | 终态后打包D盘，复用原328参考与AR；已解析，待原编译终态实际运行。 |
| `transfer_locateanything_prefill_g9_v154.py` | 严格成员/hash直传新SSD目录；已解析，尚未传输候选。 |
| `benchmark_locateanything_prefill_g9_v154.py` | 新准入+原已实测worker/恢复guard，AST核对无改动；尚未执行192次BPU对照。 |
| `test_locateanything_prefill_g9_admission_v154.py` | 实际执行的20负控：错误BC/AR、CPU节点、KV/组不符、未终态、伪造放行等被拒绝；合成正控不等于真实候选通过。 |
| `reference_locateanything_native_hybrid_reppen11_v156.py` | NVIDIA示例重复惩罚1.1单变量、保持greedy0；新160项研究已启动，不能继承旧失败例外。 |

官方源核对固定HF revision `c32291ca5e996f5a7a485845b4f57a233936bba0`；PC小源码保留在TASK `/upstream-locateanything-v155`，审计报告 `locateanything-primary-source-mode-audit-v157.json`。Qwen/SDPA mask/采样/config四文件逐字节相同；冻结顶层generate文件有既存评分/概率观测补丁，勿称整文件与官方字节相同。前v146（惩罚1.0）93失败结果保持不变；新1.1研究截至epoch1792235182已执行37/160，无最终质量或BPU收益结论。现网仍slow/W8/v7。


## 接手增补 v161—v167：验证式候选研究与资源失败

源码仍在 `test/model_conversion/`，新增6项完整hash/大小见 `test/results/locateanything-handoff-script-addendum-v167.json`，旧v152包、v158增补不覆盖。

| 脚本 | 已实际做到什么 |
|---|---|
| `locateanything_verified_mtp_control_v161.py` / `test_locateanything_verified_mtp_control_v161.py` | 因果前缀接受、首错丢弃、EOS、预算与KV保留控制；12正常+3未来扰动+2错误拒绝通过，0神经调用。 |
| `probe_locateanything_verified_mtp_v161.py` | 七开发样例的逐token目标对照；实际在加载模型时被cgroup余量保护停止，0样例完成，不可当成算法失败或成功。 |
| `audit_locateanything_mask_visibility_v163.py` | 原始SDPA/Magi允许边7尺寸完全相同；仅mask算术，最大RSS465MB，不证明kernel/生成数值相同。 |
| `probe_locateanything_verified_mtp_after_compile_v164.py` | v161同worker的全新结果目录；原编译退出、容器初始余量≥6GiB才跑，保留原保护。 |
| `continue_locateanything_after_prefill_v165.py` | 精确等待现有终态观察器→校验/打包D盘→余量充分才做七例研究；不部署模型、不重启编译。 |

新1.1直接hybrid完整160仍92失败，原始报告 `locateanything-native-hybrid-reppen11-raw-v156.json` SHA71a4a825…保留，不是现网量化新分数。v161资源失败也留在 `locateanything-verified-MTP-failed-load-*-v161.json`；不要删除失败目录后重跑冒充第一次通过。v164尚无token一致性或速度结论，后续必须实际对照，不能只凭控制测试通过启用。最新综合总账 `locateanything-official-root-cause-evidence-v30.json`。


## BPU监控采样修复（2026-10-17）

详见 [S100P-BPU-MONITORING.md](S100P-BPU-MONITORING.md)。保留真实驱动读取、时间加权窗口、23项采样回归与部署证据。旧历史不回填；此改动提高监控准确性，不代表模型推理提速。


## 最新追加源码（v193）

追加索引：test/results/locateanything-handoff-script-addendum-v193.json；附加包：test/results/locateanything-handoff-addendum-v193.tar.gz。原v152/v158/v167快照不覆盖。主线为v154组件实核→v169契约→v177完整160→v178整图A/B→v189事务升级；v188只读健康，v191精确进程续跑。v187/v197是下一组尚须板验的编译/终态观察；v184为未通过数值诊断，不可直接部署。附加包包含BPU采样修复和测试，不含模型、SDK、凭据或完整依赖环境。


### v198独立现网观察补充

升级后另做45.13秒只读观察：新增4次原生识别、4次SEI及1354个延迟视频访问单元；四服务PID/start_ticks保持，后端23完成/失败0，原录像健康、droppedMsLastHour=0。报告test/results/locateanything-prefill-groups-native-observation-v198.json，后续总账v32。过载/归档反压两项旧字段在本探针为null，没有据此宣称0。源码附加包v193保持不可变历史快照，当前文档可继续追加。下一组编译及单图优化目标仍active。


## 最新追加源码 v230：待验候选与事件续跑

索引：test/results/locateanything-handoff-script-addendum-v230.json；包：test/results/locateanything-handoff-addendum-v230.tar.gz。源码仍以远程test/model_conversion和ai-service/runtime为准；PC TASK只是挂载编译/阅读副本。v201→v204→v205→v213→v217是第三组待执行验收链，当前未通过板验/未安装；实际已经完成的是各层控制检查，不能把工具通过当作候选通过。

传输必须使用transfer_locateanything_prefill_g18_v220.py，旧v201生产端schema版本不匹配。continue_locateanything_prefill_serial_v208.py等待第三组→打包→串行第四组；continue_locateanything_mtp_full160_v228.py再等待两组结束才做原v164算法的全160 PC研究。现网仍v8、前两组O2；不得把v9候选文件称已经安装。现存PID/fd仅适用于当前WSL会话，重启后须核实新身份，不能照抄。

完整160参考原BF16的无效项是52/105/117；现网试用的人类失败例外仍只有117。v225独立列出超出既有例外的候选失败，不降低IoU0.9或点容差10，也不隐藏严格token差异。MTP旧raw/失败不覆盖，完整研究还未运行。本包不含凭据、权重、SDK或完整离线环境。


## 接手增补 v241：现有事件句柄与第四组工具

追加包test/results/locateanything-handoff-addendum-v241.tar.gz、索引locateanything-handoff-script-addendum-v241.json。v232为板端第三组完整验收/条件升级；v233必须在电脑TASK运行，使用操作系统已有SSH认证，不在容器保存密钥，当前已启动等待事件。先查当前状态与进程，不重复运行已有传输/验收任务。

第四组v235/v236/v238/v239只是准备，v237的28项负控不等于模型通过。等待原v208实际完成；v236从其真实group27终态与hash生成新SSD包。后续还须实际组件/完整模型/速度/原生SEI验证，不能运行安装脚本跳过门槛。当前原编译、v208/v228与电脑v233均有精确身份记录于v34账本，PID/fd路径只适用于本次会话。


## 接手增补 v265：实测第三组与第四组完整验收工具

追加索引test/results/locateanything-handoff-script-addendum-v265.json，包locateanything-handoff-addendum-v265.tar.gz，总账locateanything-official-root-cause-evidence-v35.json。保留原v152/v158/v167/v193/v230/v241快照。新增15份源码，包括第四组完整契约/160/整图A/B/安装、v10候选后端及DDR观测分析。

第三组v205完整160已通过，实际后续状态读v232流水线、v213 A/B和v217安装报告；文件存在或工具控制通过不等于模型部署。第四组编译真实worker673373/start20878468来自v208，不能重用旧group18 PID。v254电脑端Windows PID119112/exec33349等待原v228研究资源释放，终态后才准备v236包、v238传输、v253板验；不要重复启动。仅本会话身份有效，重启后重新核实。

v256观测是保留的失败例，vendor返回0仍0样本，不采用。使用v258的短文件名/实际时长/样本数/错误文本联合门槛，v262仅分析现有文件。45秒连续私有验收的82.507%平均ratio不是低频现网均值、不是MAC占用率或DDR饱和证明。

本增补不含权重、BC/HBO/HBM、校准数据、完整依赖/SDK或凭据。容器删除前仍须另外保存这些大文件与工具链环境；PC TASK是编译挂载与阅读副本，远程test/model_conversion和runtime为源码正本。


## 接手增补 v276：缓存复用实验未过整图收益门槛

新增7份源码见test/results/locateanything-handoff-script-addendum-v276.json，包locateanything-handoff-addendum-v276.tar.gz，总账v36。v268是请求内工作区，v269是CPU数据控制/测速；v270包装原生成器，v273验证finally清零释放；v271为真实46上下文整图A/B，v272是从原已执行guard生成新探针的来源工具。

不要把CPU每组0.6909ms估算当作实际单图提速。真实22请求中位仅8.310ms，50ms门槛失败；未做完整160候选验收、未安装。v271结束已经恢复用户原v9及95秒SEI/录像连续性。原始状态与失败screen保留，勿降低门槛后重复命名成成功。第四组仍走原v207/v208→v228/v254→v253流程，先核实当前进程，勿沿用历史PID。


## 接手增补 v282—v288：视觉27块同BC O2已试用安装（2026-10-18）

**现网已是 v11**：
- 入口：`ai-service/runtime/locateanything_bpu_vision_o2_executor_v11.py`（SHA d4efa1bd…）
- 契约：`BASE/official-full-family-w8a16-vision-o2-v284.json`（SHA d471046ae84930c385db34841154583e2476a1d0fe210f5985debee31a29fbf2）
- 基于已装的 v10（四组 prefill O2，v253/v251 安装成功），只把 27 个 MoonViT 块共用的那个物理 HBM 换成同一份 converted.bc 编出的 opt2 版本。prefix/connector、解码器、词表、76 个逻辑程序和 46 个物理 HBM 都没变；没有重新校准，也没有改图和权重。

- **编译**：在 PC 容器里用 `vision_all27_same_bc_o2_build_v283.py`，jobs1、opt2，其余参数用 HBDK 默认值，27 块串行，共 12852 秒。HBM 为 63c7e861…，全部节点在 BPU。产物在 D 盘 `vision-all27-o2-v283`，板上在 `BASE/vision-all27-o2-v283-board-package`。
- **组件板验**（不暂停现网）：用 `run_/validate_locateanything_vision_o2_board_v283.py`，同一进程同时加载 O0 和 O2。18 例 × 2 轮 × 27 段，共 972 次逐段比较，逐字节不一致为 0；O0 的尾输出和现网存档逐字节相同。27 块整链中位从 374ms 降到 177ms（2.11 倍）。
- **完整 160**（AI 有界暂停）：用 `regress_locateanything_vision_o2_v285.py` / `guard_locateanything_vision_o2_v286.py`。160 项的输出、概率、终止和 JSON 全部与 v10 一致，失败项只有原来的 117，共 25794 次调用，已恢复现网。
- **整图 A/B**：用 `compare_locateanything_vision_o2_full_image_v287.py`，22 次请求 / 10 组配对。中位每张省 194.4ms，5 个用例全部变快（短例从 1.69 秒降到 1.48 秒），token 全部一致。
- **事务安装**：用 `install_locateanything_vision_o2_runtime_v288.py`，结果通过。用户配置没变，录像连续，AI + 后端保守峰值 6.45GB。安装后现网 12 次推理 p50 为 1644ms（v9 时约 2012ms）。
- **失败如实记录**：PC 上 v228 拉起的 v225（完整 160 MTP 研究）启动时报 `Insufficient initial model-loading headroom` 失败，原因是容器内存余量不足 6GiB。当时本轮的视觉编译正在同一个容器里跑（RSS 约 1GB），可能是原因之一。这是研究项，不在 BPU 主线上，没有自动重试；第四组的 v254→v253 不受影响，照常完成。
- **速度根因与后续路线**：见 D 盘 `speed-analysis-2026-10-17/LOCATEANYTHING-SPEED-ROOT-CAUSE.md`。
  - 解码受 DDR 带宽限制，不是算力不够。每个 token 约 129ms，其中 BPU 约 100ms；官方同维度模型在本板上实测单图 decode ≤83ms。
  - 下一批候选：缩小 prefill chunk；按官方结构把解码合成一张图。
- 目前仍是试用，正式质量发布未通过。
