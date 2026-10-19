# S100P LocateAnything：GPTQ INT8 高精度文字解码编译手册（最终版，2026-10-19）

本文是可以照着重做的完整流程。现网（v14 执行器 + v320 契约）就是按本文产出的。速度和精度的根因分析见 [S100P-LOCATEANYTHING-SPEED-ACCURACY-ANALYSIS.md](S100P-LOCATEANYTHING-SPEED-ACCURACY-ANALYSIS.md)，当前现网状态见 [交接文档](S100P-LOCATEANYTHING-HANDOFF.md) 开头一节。

## 1. 结论与配方

- **精度损失在哪里**：现网的 P/R 衡量的是与原版 BF16 的一致率，不是对标注的准确率。实用标准用 IoU≥0.5。在这个标准下，最大的损失来自逐行 W8 的文字解码权重：把视觉固定为 BPU 输出、文字换成原版 BF16 时 P/R 为 90.6/88.1，全 BPU 时只有 75.3/79.5。解码组的注意力早已是 A16（见 `build_locateanything_official_qwen_group_v3.py` 第 37–39 行）。
- **配方**：权重格式不变（逐行对称 INT8，scale = absmax/127，码值 ±127），用 GPTQ 优化舍入。方法参考 IST-DASLab/gptq：act-order、damping 0.01、block 128，逐层串行，每量化完一层就重新采集激活。
  - 校准集用旧 72 项开发集，共 72 条序列、12131 个 token（提示加原版答案做 teacher forcing），视觉输入用现网 BPU 视觉特征。校准集与独立 160 项不重叠。
  - lm_head 用直接舍入的 W8。
- **怎样喂给官方构建器**：沿用官方 `FakeQuantLinear(w_bits=8)` 的构建路径。把权重设为 `codes*scale`，并显式固定 `absmax_weight = 127*scale`。O0 板验已经证实精度收益得到保留。
- **结果**（独立 160 项，全 BPU）：

  | IoU | v11 P/R | GPTQ INT8 P/R |
  |---|---|---|
  | 0.5 | 75.3/79.5 | 87.8/89.0 |
  | 0.75 | 70.6/74.4 | 77.5/78.5 |
  | 0.9 | 59.3/62.6 | 64.9/65.8 |

  有效输出 159/160，失败项仍只有 117。速度与 v11 持平（逐例耗时中位比 1.0037），内存峰值 6.44GB。

## 2. 环境

- PC 容器 `ainvr-locateanything-w4-20261014`：镜像 `ai_toolchain_ubuntu_22_s100_s600_gpu:v3.7.0`，8 CPU、27.9GB 内存、RTX 4090。
  - 隔离 SDK 位于 `/opt/locate-oellm-research-v1/sdk448-isolated`，配合 `leap-source-overlay` 使用。
  - `/work` = `C:\Users\bills\.codex\tmp\ainvr-locateanything-w4`，`/model` = `D:\code\LocateAnything-3B`。
- Git Bash 下执行 `docker exec` 前，必须先 `export MSYS_NO_PATHCONV=1`，否则容器内路径会被改写。
- **磁盘规则（血的教训）**：
  - 容器的 `/opt` 位于 C 盘的 `docker_data.vhdx` 中。大体积中间文件写进去，vhdx 只会变大、不会缩小。曾经因此写满 C 盘，导致 Docker 数据盘被识别为"无文件系统"。
  - 新产物写到 `/work`，写完立即在主机侧移到 D 盘。
  - 主机侧守护：C 盘剩余低于 8GB 时，按精确 PID 停止编译。
- 在 PC 上用 3.5B 模型做仿真时，用 BF16，不要用 FP32。FP32 会占满显存，大约 8 分钟才出一个样本。

## 3. 步骤（版本号就是文件名）

| 步骤 | 运行位置 | 脚本（`test/model_conversion/`，SHA 前 16 位） | 说明 |
|---|---|---|---|
| 0 归因 | 板 + PC | `capture_locateanything_vision_features160_v302.py`；`audit_locateanything_vision_text_attribution160_v303.py`（eb48f2b7…）；`rescore_iou_thresholds_v317.py`（11863c1d…） | BPU 视觉特征接原版 BF16 文字；有两项原生接口正控必须逐字一致；按 IoU 0.5/0.75/0.9 重新计分 |
| 1 仿真筛选 | PC GPU | `simulate_locateanything_text_weight_quant160_v306.py`（a183b29f…） | none / row8 / g32 只对权重做量化；g32 简单量化无效 |
| 2 GPTQ | PC GPU | `gptq_locateanything_text_row8_v307.py`（0cfaad93…） | 输出 `/opt/locate-text-gptq-row8-v307/layer{i}.{name}.npz`（int8 码 + scales），并自带独立 160 项仿真评估 |
| 3 O0 构建 | PC 容器 | `build_locateanything_official_qwen_group_gptq8_v312.py`（43cd38a9…），驱动 `run_gptq8_groups_v312.sh` | 官方构建器加 GPTQ 覆盖（absmax 固定），4 组 × s1/s256，O0，全 BPU；每组约 40 分钟 |
| 4 O0 评估 | 板 | `locateanything_official_text_gptq8_eval_v313.py`（6a8c1d3e…）+ executor v13 + `regress_..._eval_v314.py` + `guard_..._eval_v315.py` | 完整 160 项质量关（期间暂停现网 AI，结束后自动恢复） |
| 5 O2 编译 | PC 容器 | `compile_text_gptq8_groups_o2_v318.py`（328cf320…），驱动 `run_text_gptq8_o2_v318.sh`；`link_text_gptq8_o2_v318c.py`（7e94c668…） | 同 BC，opt2/balance100/max_l2m 0；jobs=8 时 s1 约 11 分钟、s256 约 25–40 分钟；输出写到 `/work`，再移到 D 盘 |
| 6 打包 | 主机 | `host_package_o2_v318d.py`（5bc6ca27…） | O2 HBM 加 v312 编译器参考用例，从 D 盘直接打包；传板用 `tar cf - <子目录> \| ssh … tar xf - --no-same-owner` |
| 7 组件验证 | 板 | `validate_locateanything_text_gptq8_o2_board_v319.py`（78374b6d…） | 同进程运行 O0 和 O2，每组 2736 次比较，必须逐位一致；同时做配对测速 |
| 8 O2 完整 160 | 板 | `locateanything_official_text_gptq8_o2_eval_v320.py`（1c397957…）+ executor v14（27da9bc4…）+ `regress_..._o2_eval_v321.py`（50fc4a65…）+ `guard_..._o2_eval_v322.py`（0349d749…） | 要求与 O0 的 160 项逐项一致（token 和 logprob 都相同） |
| 9 速度 | 板 | `test/results/locateanything-text-gptq8-o2-speed-paired160-v323.json` | 两个模型族放不进同一个 ION 池，所以改用两次条件相同的完整 160 运行做逐例对比 |
| 10 安装 | 板 | `install_locateanything_text_gptq8_runtime_v323.py`（ca2fe45f…） | 先做只读准入，再加 `--install`；事务化切换 drop-in 和 sidecar，失败自动回滚 |
| 11 回滚 | 板 | `rollback_locateanything_to_v11_v324.py`（103a8f07…） | 不带参数时只做检查；`--execute` 恢复 v11（尚未实际演练） |

辅助产物（实验或否决路线，保留作为证据）：
- 视觉配方：v296 探针、链接与驱动，v297 特征采集，v298 评估，v299–v301 完整 160。
- O2 视觉：v283 构建。
- 网格探针：v308–v310。
- BPU 利用率：v282、v289–v294。

## 4. 已否决的路线（不要重复尝试）

| 路线 | 结论 | 证据 |
|---|---|---|
| 视觉注意力 qk16×16/sv16×16（INT8 权重） | 单块误差下降 23%，但独立 160 项为 57.1/62.1，比现网差；旧 72 项上的 +8 是假象 | v301 |
| 视觉 16bit 权重 | 单块 HBM 190MB，27 块约 5.1GB，装不下 | v296 w16 |
| 历史 FP32 视觉（3 路 INT8 分支） | 每块 367MB，27 块约 9.9GB | vision-fp32-stage*-v19 |
| 文字 group32 简单量化 | P 和 R 此消彼长，没有整体提升 | v306 |
| FP16 编译 | nash-m 的 `hbir.linear` 和 `hbir.matmul` 输入只支持 int8/int16（SDK `docs/hbir_op_J6E_constraint_v2.mdx`） | — |
| 两请求重叠以提高 BPU 占用 | 吞吐 0.98–1.0 倍，没有收益 | v292、v294 |

## 5. 已知的坑

- 官方编译后的权重并不是精确的 absmax/127 网格（v310 用 one-hot 输入恢复出的有效权重存在约 0.4% 的偏差）。但以 O0 板验的端到端结果为准，GPTQ 的收益得到了保留。
- 契约 key 是两位补零的格式：`decoder-group-00-08-ar`。
- 构建器要求进程是进程组组长；在循环里调用时要用 `setsid -w`。
- 不要用 `pkill -f` 去匹配自己命令行里也出现的字符串，否则会杀掉自己，应按精确 PID 处理。
- 写给自己用的 `.done` 完成标记，重跑前要删掉。
- tar 解包时如果包含根条目 `.`，会把目标目录的属主改掉。
- 构造契约时，会对 46 个 HBM 逐一算哈希，耗时可能超过 10 分钟，属于正常现象。
- 守护杀掉 Python 父进程后，`hbdk-lld` 子进程会变成孤儿继续运行，要一并停掉。
