# S100P：Qwen3-VL-4B 告警复审模型全 BPU 量化编译与板测（v3，2026-10-21）

> **性质**：测试版。未安装到 `ai-service/models/`，未接入 ai-service，未替换现网模型，未达生产准入。
> 指标是与原版 BF16 的"是/否"判定一致率；标注准确率另列。
> **新手请先读同目录 [S100P-QWEN3VL-BUILD-GUIDE.md](S100P-QWEN3VL-BUILD-GUIDE.md)**：基础概念与意图、环境搭建、分步命令与通过标准、排错、迁移到其他模型（含 Qwen3-VL-8B 内存估算）。

## 1. 用途与接口设想
告警复审：输入告警截图（固定 448×896，2:1 对应 4K ERP）+ 告警描述 → 只读第一个输出 token 的 logits，得到"是/否"
两侧概率，按可配置阈值决定是否发送告警。同一机制可扩展为单选（A–F）和等级分（0–9）。建议输出格式 `ainvr.alarm_review.v1`：

```json
{"schema":"ainvr.alarm_review.v1","alarm_id":"...","model":{"name":"qwen3-vl-4b","backend":"bpu","contract_sha256":"..."},
 "answers":{"is_real":{"type":"binary","p":0.82,"raw_logits":{"yes":3.1,"no":1.6}}},
 "usage":{"input_tokens":470,"latency_ms":2830},"status":"ok"}
```
极性统一为 `is_real`（告警属实概率）；保留原始 logits 以便后续用真实告警做温度/阈值标定。

## 2. 最终结果（O2，全 BPU）
| 项 | 结果 |
|---|---|
| 独立评估集 559 项（只跑一次） | 判定一致率 阈值 0.3 / 0.5 / 0.7 = **97.85% / 97.67% / 97.67%**；\|Δp\| 均值 0.025；13 项翻转，其中 10 项 BF16 自身概率在 0.2–0.8 |
| 标注准确率 | BPU **88.2%**，BF16 88.7% |
| O2 是否继承 O0 质量 | 开发集 157 项与 O0 **逐项完全相同**（22 个决策 token logit 全等）；9 个 O2 包与编译器参考**逐位一致** |
| 单次复审耗时 | **中位 2.83 s**（p95 2.85 s）= 切 patch 21 ms + 视觉 0.53 s + 文字 prefill/决策 2.29 s；O0 为 8.0 s |
| 内存峰值 | **5.72 GB**（ION 5.50 GB + RSS 0.22 GB；RSS 计一次 + 活线程 ION，逐项采样，保守口径） |
| HBM | 视觉 4 组 ≈300 MB/组，文字 4 组 ≈1.03 GB/组（s1+s256 共享权重），决策头 2 MB，共 ≈5.3 GB |

对照（开发集 157 项）：PC 仿真 GPTQ W8 文字（激活浮点）100%；PC 仿真视觉 W8（文字 BF16）99.4%；板上仅文字 BPU 98.1%；板上全 BPU 97.5%。
→ 主要损失来自文字 A16 激活量化，表现为逐项随机噪声（logit 差约 1.6），不是系统偏移（阈值整体偏移无收益）。

## 3. 结构与配方
- **视觉**（24 块 ViT，1024 维，16 头，全注意力，1568 patch → 392 token）：分 4 组（0–5 含 patch embedding、6–11、12–17、18–23 含最终合并层），
  DeepStack 合并层在第 5/11/17 块后输出。W8 直接舍入，官方 Omni 视觉注意力位宽；2D 旋转 cos/sin 作为输入（做常量每块 +26 MB）；
  GELU 用量化域分段 `gelu(sat8(x)) + relu(x-8)`。
- **文字**（Qwen3，36 层，2560 维，32/8 GQA，head 128）：分 4 组 × 9 层，s1 与 s256 两档共享权重，KV 容量 1024。
  GPTQ 逐行 INT8（act-order、damp 0.01、block 128，校准 = 407 条 teacher forcing 序列），A16；q/k RMSNorm；
  交错 MRoPE 在主机侧算 cos/sin；mask −96；softmax 量化域分解；DeepStack 在 group0 第 0–2 层后相加。决策 token 走 s1。
- **决策头**：final norm + 22 个决策 token 行（是/否、A–F、0–9、Yes/No/yes/no）。
- **主机侧（非 BPU，正式化前需处理）**：token embedding 行查表（原版 BF16）、切 patch 与归一化（按 S100P 分工应走 PYM/GLES）、
  cos/sin 计算、KV 与掩码排布。

## 4. 踩过的坑（新模型照此预检）
1. `leap.gelu` 查表在输入上百时整块算错（ViT 第 23 块编译后误差 87 倍，torch 正常）→ 量化域分段。
2. 未量化张量上的 `leap.clip/gelu/exp/sub` 会静默落 CPU（convert 日志 `hbtl.call: native::*`）；构建脚本对 HBM 做
   DEVICE_CATEGORY_BPU 断言拦住 → 每步后接 16 bit fake-quant，clip 用固定范围的饱和 fake-quant。
3. mask −512 撑宽 add_mask 的 int16 量化范围（有效分数实测 [−31, 51]）→ −96。官方 softmax 概率误差约 2.3%，量化域分解为 1.7%。
4. 整组 rel_l2 会掩盖末 token 误差：首 token 有上万的超大激活，s256 整体 0.03% 而 s1 末行 9 层累积约 20%。是/否只看末行，要单独看。
5. `ConstFakeQuant.forward` 只记范围不量化 → "torch 伪量化 vs BF16" 偏乐观；真实量化误差以编译器参考为准。
6. 编译资源：一个 9 层文字组的 s256 编译器参考仿真约 24 GB 内存，O2 编译约 19 GB，两个并行会 OOM（WSL 32 GB）；
   O0 每组约 1.2–1.8 h，O2 每组约 1.8 h（jobs 7）。中间产物每组约 12 GB，注意 D 盘余量；编译临时目录不要放在 C 盘的 Docker vhdx 里。
7. 饱和诊断：多数样本都有 6–12 个量化点超出校准范围 2–11%；softmax 求和项最多超 22%。

## 5. 板测与生产保护
- 所有板测由 `test/model_conversion/qwen3vl/board_guard_eval_v2.sh` 有界暂停 `ainvr-ai` 与 `ainvr-locateanything-official-bpu`，
  finally 恢复测试开始时处于运行状态的服务，并验证 LocateAnything 只读健康 ok、AI 产生新的健康归档；录像与接入从不停止。
- 本轮共暂停 5 次、合计约 74 分钟：10-21 03:38–03:39、03:39–03:54、04:13–04:35、04:40–04:41、18:07–18:43。每次均已恢复。

## 6. 下一步（v4 候选）
- 扩大校准集；softmax 求和项固定宽范围；查明 dev-0082 类离群（偏差约 8 logit，非饱和导致）。
- embedding 上 BPU，切 patch/归一化走 PYM/GLES；与 ai-service 对接需新增适配器与 `.hbm.ainvr.json` 契约后再放入 `ai-service/models/`。
- 正式部署前需确认与现网模型的 ION 共存方案（本模型峰值 5.72 GB）。

## 7. 脚本目录（本文件所在目录 `test/model_conversion/qwen3vl/`）

运行环境：带 ★ 的是 v3 最终产物实际用到的脚本。PC 侧脚本在编译容器 `ainvr-qwen3vl-20261020` 内运行，路径约定为：
`/models` = D:\models（只读）；`/qwork` = D:\codex-task-staging\qwen3vl\work；`/opt/qsdk` = SDK 4.4.8a2 隔离副本与 leap overlay。
板端脚本放在 `/mnt/ainvr-ssd/qwen3vl/scripts/` 下运行。构建脚本必须用 `setsid -w` 启动，因为官方构建器要求进程是进程组组长。

### 7.1 公共模块与主机侧
| 文件 | 运行位置 | 作用 |
|---|---|---|
| ★ `qwen3vl_common_v1.py` | PC | 加载 BF16 模型；固定 448×896 输入；告警复审提示词；从第一个 token 的 logits 算是/否概率 |
| ★ `qwen3vl_bpu_text_v1.py` | PC | 文字层在官方 leap_llm 模块上的实现：Omni W8/A16 注意力 + q/k RMSNorm、GQA 32/8、量化域 softmax、mask −96、DeepStack 加法、GPTQ 覆盖（absmax 钉为 127×scale）、分块/KV 排布 |
| ★ `qwen3vl_bpu_vision_v1.py` | PC | ViT 24 块分组实现：LayerNormSplit、量化域分段 GELU、DeepStack 合并层/最终合并层、位置编码常量，cos/sin 作为输入 |
| ★ `qwen3vl_host_v1.py` | 板 + PC | 纯 numpy 主机侧：切 patch 与归一化、MRoPE 位置、交错 cos/sin、分块计划（决策 token 走 s1）、KV/掩码排布 |

### 7.2 数据与 BF16 参考
| 文件 | 作用 |
|---|---|
| ★ `host_select_coco_v1.py` | 在 Windows 侧运行：按哈希确定性抽取 COCO 2:1 子集（train → 校准，val → 开发/独立评估），并带上标注 |
| ★ `extract_camera_frames_v1.py` | 从板上录像抽帧：11 点的帧用于校准，12 点的帧用于独立评估，按时间互不重叠 |
| `build_items_v1.py` | 第一版告警描述（"闯入/越界"式）。BF16 有 90% 回答"否"，已弃用 |
| ★ `build_items_v2.py` | 第二版告警描述（"画面中出现 X"式），真报和误报比例均衡 |
| `reference_bf16_v1.py` / ★ `reference_bf16_v2.py` | 冻结 BF16 参考：是/否 logits、概率、序列长度 |
| ★ `capture_states_v1.py` | 抓取 BF16 解码层的输入、输出、KV，以及 cos/sin、DeepStack、视觉掩码，用于校准和比对。环境变量：QDEV、QITEMS、QIDS |
| ★ `capture_vision_v1.py` | 抓取视觉参考：patches、24 块的输出、DeepStack、合并输出 |
| `smoke_bf16_v1.py` | BF16 冒烟测试 |
| `verify_host_v1.py` | 校验 numpy 主机侧与 HF 一致（patch 误差 1e-7，位置编码完全相同） |

### 7.3 仿真、GPTQ 与归因
| 文件 | 作用 |
|---|---|
| ★ `sim_text_quant_v1.py` | 文字权重量化仿真，支持 rtn 和 gptq 两种模式。`--save-codes` 输出 252 个 GPTQ 码文件（构建时由 `--gptq` 读取） |
| `vision_attr_v1.py` | 视觉归因：用伪量化视觉替换 BF16 视觉塔，评估对是/否的影响 |
| `score_yesno_v1.py` | 给 PC 仿真结果评分 |
| `score_range_v1.py` | 统计未被屏蔽的注意力分数范围，用来确定 mask 取值 |

### 7.4 构建（O0）与 O2
| 文件 | 作用 |
|---|---|
| ★ `build_text_group_v1.py` | 构建一个文字组（9 层，s1+s256，KV1024）：校准 → 导出 → 转换 → 编译器参考 → 编译 → 链接 → BPU-only 断言。环境变量：QSILU=lut、QREFN |
| ★ `build_vision_group_v1.py` | 构建一个视觉组（`--rope-inputs --device cpu`） |
| ★ `build_head_v1.py` | 构建决策头 |
| ★ `compile_o2_same_bc_v1.py` | 用同一份 converted.bc 编 O2（opt2/balance100/max_l2m 0），并复制 O0 的测试样本用于板上逐位比对 |
| ★ `run_vision_groups_o0_v3.sh` | v3 视觉 4 组 O0 队列 |
| ★ `run_remaining_o0_v3c.sh` | v3 文字 4 组 + 决策头 + 视觉剩余组的严格串行队列（两个 s256 编译器仿真同时跑会 OOM） |
| ★ `run_o2_v3b.sh`、★ `run_o2_text_v3c.sh` | O2 串行队列，临时目录放在 D 盘 |
| `run_text_groups_o0_v1/v2/v3.sh`、`run_text_groups_lane2_v1/v2/v3.sh`、`run_vision_groups_o0_v1/v2.sh`、`run_remaining_o0_v3/v3b.sh`、`run_o2_v3.sh` | 历史队列：被 OOM、CPU 回退或磁盘写满打断的各版本，保留作记录 |

### 7.5 排查与诊断
| 文件 | 作用 |
|---|---|
| `debug_block_taps_v1.py` | 视觉单块逐中间张量比对，定位了 GELU 查表算错 |
| `debug_block_v1.py`、`debug_merger_v1.py` | 视觉块区间、最终合并层的单独比对 |
| `debug_text_taps_v1.py`、`debug_text_attn_taps_v1.py` | 文字单层逐中间张量和注意力内部比对，定位了 softmax 和 mask 的问题。环境变量：QCAL、QTEST、QS1CAL |
| `diag_saturation_v1.py` | 按构建时的方式重新校准后，列出超出校准范围的量化点 |

### 7.6 板端
| 文件 | 作用 |
|---|---|
| ★ `board_validate_fixtures_v1.py` | 用编译器参考的输入跑 HBM，逐位比对输出并测耗时 |
| ★ `board_run_alarm_v1.py` | 全 BPU 端到端编排（视觉 → 文字分块 prefill → 决策头），记录耗时和内存峰值。设 `QVFEAT=1` 时视觉改用 BF16 特征，用于归因 |
| ★ `prepare_board_items_v1.py`、`gen_vision_feats_v1.py` | 生成板端评估包：token ids、无损图片、BF16 embedding 位表、视觉 cos/sin；BF16 视觉特征 |
| ★ `board_guard_eval_v2.sh` | 生产有界暂停守护：恢复后检查 LocateAnything 健康状态，并确认 AI 产生新的健康归档。`board_guard_eval_v1.sh` 是不含恢复检查的早期版本 |
| ★ `score_board_v1.py` | 板上结果评分：各阈值一致率、翻转列表、\|Δp\|、logit 差误差、标注准确率、耗时 |

### 7.7 PC 运维
| 文件 | 作用 |
|---|---|
| `disk_guard_v2.sh`（`c_drive_guard_v1.sh` 为旧版） | C 盘剩余低于 8GB 或 D 盘低于 10GB 时停止编译 |
| `memguard_v1.sh` | 并行构建时的内存看门狗 |
| `move_to_f_v1.sh` | 把 D 盘目录迁到 F 盘，校验后再删除源目录 |
| `backup_la_container_v1.sh` | 删除 LocateAnything 旧编译容器前的备份，备份在 F:\la-container-backup-20261021 |
| `status_v1.sh` | 查看所有构建的状态 |

### 7.8 复现最短路径（v3）
1. 数据：`host_select_coco_v1.py` → `extract_camera_frames_v1.py` → `build_items_v2.py` → `reference_bf16_v2.py`
2. 校准状态：`capture_states_v1.py calib 32 0,8,9,17,18,26,27,35 …`、`capture_vision_v1.py calib 24 …`（开发集同理）
3. GPTQ：`sim_text_quant_v1.py gptq <out> --save-codes`
4. O0：`run_vision_groups_o0_v3.sh`，以及文字 4 组 + 决策头（`run_remaining_o0_v3c.sh`）
5. O2：`compile_o2_same_bc_v1.py`（`run_o2_v3b.sh` / `run_o2_text_v3c.sh`）
6. 板上：`board_validate_fixtures_v1.py` 逐包校验 → `board_guard_eval_v2.sh` 包住 `board_run_alarm_v1.py`（manifest-o2-v3.json）→ `score_board_v1.py`

## 8. 其他文件位置
- 板上产物：`/mnt/ainvr-ssd/qwen3vl/`（`*-o0-v3`、`*-o2-v3`、`run-v1/` 评估包与清单 `manifest-o2-v3.json`）。
- 结果：`test/results/qwen3vl-*`（gitignored，原始逐项输出与守护记录）。
- PC 侧大文件：`D:\codex-task-staging\qwen3vl\work`（编译中间件、捕获、校准、GPTQ 码），容器 `ainvr-qwen3vl-20261020`。
