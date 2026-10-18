# LocateAnything 历史实验与方案对照

来源：保留的原始 JSON 实测报告；本表只整理证据，没有重新运行模型。

## 指标口径与历史最佳

- 同一组 16 图 × 4 查询 = 64 用例，原版共 78 个框，匹配 IoU≥0.9。P/R 衡量与原始 BF16 输出的一致性，不是标注集准确率。
- 这组数据最初独立抽取，现在已多次用于诊断，属于回归/调优集。正式验收仍需冻结方案后使用新图。
- 历史量化候选最高：**校准 INT8 group32 + 5% INT16，P/R=88.46%/88.46%**；保留原生 BF16 视觉与解码运算，不是全 BPU 成绩。
- 最终 logits 舍入 v3：**84.62%/84.62%**，视觉仍原生 BF16。v4 理想权重表示对照也是该分数。v2 实际是 **63.75%/65.38%**，此前混写应以这里的原报告索引纠正。
- 已测完整 F32 视觉迁移路径的当前双指标最佳：**仅最终视觉特征舍入 v9，P=79.17%/R=73.08%**。v9 历史锚点仍完整保留；这些均不是实际全 BPU 成绩。
- 当前组件算式 v11-r2：**50.67%/48.72%**，必须标为回退；不是最佳替代方案。它未精确模拟所有 BPU 量化算式。
- 最新原版复测 v2：64/64 响应完全复现、78/78 框匹配，证明原始参考稳定。原版 100% 只表示自一致，不参加候选排名。
- **真实 S100P 完整模型 P/R：尚未测得。** 已有 HBM 组件的数值误差、运行成功和 GPU 全模型分数都不能填入这个空缺。

## 全部已核实的完整模型回归成绩

| 方案 | P | R | 匹配/预测/原版框 | 精度路径 | 结论 | 原始报告 |
|---|---:|---:|---:|---|---|---|
| v9 投影 GEMM 映射 v14 / v9_only_patch_linear_mapping | 79.17% | 73.08% | 57/72/78 | 仅将 patch Conv2d 改为同权重/偏置的 F32 GEMM；其余保持 v9 | 64/64响应与v9完全一致，P/R不变；该硬件映射未丢失原成绩 | [locateanything-patch-linear-ablation-v14.json](../test/results/locateanything-patch-linear-ablation-v14.json) |
| 显式 F32 视觉算式 v15 / explicit_f32_vision_component_equations | 79.17% | 73.08% | 57/72/78 | 完整27层显式F32视觉/连接器，原生F32位置/RoPE常量，无逐算子BF16舍入；保留最终特征/logits格式 | 联合硬件映射方案，非单变量因果归因；16图原生F32特征桥接相对误差约1e-5，完整P/R见本行；实际BPU仍需复验 | [locateanything-fp32-component-oracle-v15.json](../test/results/locateanything-fp32-component-oracle-v15.json) |
| v9 位置插值单变量 v12 / v9_same_harness_control | 79.17% | 73.08% | 57/72/78 | 同一程序先完整复现 v9，再仅将学习位置编码插值改为 BF16 常量；其余 F32 视觉/解码保持 v9 | 控制组64/64响应精确复现；BF16位置变体退步至P58.33/R53.85，拒绝该改动 | [locateanything-vision-position-ablation-v12.json](../test/results/locateanything-vision-position-ablation-v12.json) |
| v9 位置插值单变量 v12 / v9_only_native_bf16_learned_position | 58.33% | 53.85% | 42/72/78 | 同一程序先完整复现 v9，再仅将学习位置编码插值改为 BF16 常量；其余 F32 视觉/解码保持 v9 | 控制组64/64响应精确复现；BF16位置变体退步至P58.33/R53.85，拒绝该改动 | [locateanything-vision-position-ablation-v12.json](../test/results/locateanything-vision-position-ablation-v12.json) |
| v9 输入像素单变量 v13 / v9_only_bf16_input_pixels | 51.39% | 47.44% | 37/72/78 | 仅将输入像素格式化为 BF16 表示值后进入 v9 F32 视觉；保留原 v9 F32 位置插值，其余完整架构不变 | 单变量结果以本行实际逐例P/R为准；不自动替换最佳方案；仍非实际全BPU | [locateanything-input-format-ablation-v13.json](../test/results/locateanything-input-format-ablation-v13.json) |
| W4 GPTQ / group128_v2 | 53.93% | 61.54% | 48/89/78 | 视觉/连接器/输出头 BF16；252 个解码线性层 W4 | W4 低于当前 INT8 候选；保留失败质量，不重复原配方 | [locateanything-gptq-heldout-validation-v2.json](../test/results/locateanything-gptq-heldout-validation-v2.json) |
| W4 GPTQ / group32_v3 | 55.56% | 70.51% | 55/99/78 | 视觉/连接器/输出头 BF16；252 个解码线性层 W4 | W4 低于当前 INT8 候选；保留失败质量，不重复原配方 | [locateanything-gptq-heldout-validation-v2.json](../test/results/locateanything-gptq-heldout-validation-v2.json) |
| 朴素 INT8 | 42.00% | 53.85% | 42/100/78 | 252 个解码线性层 W8；其余 BF16 | 低分对照；不重复原配方 | [locateanything-int8-heldout-validation-v1.json](../test/results/locateanything-int8-heldout-validation-v1.json) |
| GPTQ INT8 初版 | 85.29% | 74.36% | 58/68/78 | 原生 BF16 视觉/解码计算，解码权重量化 | 保留为 GPTQ 校准对照 | [locateanything-gptq-int8-reference-v1.json](../test/results/locateanything-gptq-int8-reference-v1.json) |
| GPTQ INT8 group32 | 80.88% | 70.51% | 55/68/78 | 原生 BF16 视觉/解码计算，解码权重量化 | 低于后续 5% 敏感组方案 | [locateanything-gptq-int8-g32-v2.json](../test/results/locateanything-gptq-int8-g32-v2.json) |
| 未校准敏感组选择 / all_int16_diagnostic | 80.49% | 84.62% | 66/82/78 | 逻辑 INT8/INT16 权重，BF16 CUDA 计算；按权重误差选组 | 不能把增加 INT16 比例等同于质量提高 | [locateanything-mixed-int8-int16-validation-v1.json](../test/results/locateanything-mixed-int8-int16-validation-v1.json) |
| 未校准敏感组选择 / int8_plus5pct_int16 | 75.64% | 75.64% | 59/78/78 | 逻辑 INT8/INT16 权重，BF16 CUDA 计算；按权重误差选组 | 不能把增加 INT16 比例等同于质量提高 | [locateanything-mixed-int8-int16-validation-v1.json](../test/results/locateanything-mixed-int8-int16-validation-v1.json) |
| 未校准敏感组选择 / int8_plus10pct_int16 | 65.00% | 66.67% | 52/80/78 | 逻辑 INT8/INT16 权重，BF16 CUDA 计算；按权重误差选组 | 不能把增加 INT16 比例等同于质量提高 | [locateanything-mixed-int8-int16-validation-v1.json](../test/results/locateanything-mixed-int8-int16-validation-v1.json) |
| 校准 INT8 + 5% INT16 | 88.46% | 88.46% | 69/78/78 | group32；校准选敏感组；视觉/连接器/解码运算/输出头保留 BF16 | 历史量化候选最高双指标；保存权重与配方，作为质量锚点；尚非 BPU 成绩 | [locateanything-calibrated-int8-g32-plus5pct-int16-v1.json](../test/results/locateanything-calibrated-int8-g32-plus5pct-int16-v1.json) |
| 校准 INT8 + 10% INT16 | 83.33% | 83.33% | 65/78/78 | group32；增加敏感组比例；其余原生 BF16 | 双指标低于 5% 方案，不以更高位宽比例为由替换最佳 | [locateanything-calibrated-int8-g32-plus10pct-int16-v2.json](../test/results/locateanything-calibrated-int8-g32-plus10pct-int16-v2.json) |
| 原权重 F32 解码 | 63.75% | 65.38% | 51/80/78 | 原生 BF16 视觉/连接器 + F32 解码 | 用于区分运算精度与权重量化误差，不作为量化方案排名 | [locateanything-original-fp32-decoder-v3.json](../test/results/locateanything-original-fp32-decoder-v3.json) |
| 原权重舍入边界 / head_only | 78.21% | 78.21% | 61/78/78 | 原生 BF16 视觉；F32 解码加指定 BF16 舍入；注意力仍 F32 | 仅数值定位；保留各变体 | [locateanything-fp32-rounding-boundaries-v1.json](../test/results/locateanything-fp32-rounding-boundaries-v1.json) |
| 原权重舍入边界 / final_norm_and_head | 78.21% | 78.21% | 61/78/78 | 原生 BF16 视觉；F32 解码加指定 BF16 舍入；注意力仍 F32 | 仅数值定位；保留各变体 | [locateanything-fp32-rounding-boundaries-v1.json](../test/results/locateanything-fp32-rounding-boundaries-v1.json) |
| 原权重舍入边界 / full_boundaries | 68.75% | 70.51% | 55/80/78 | 原生 BF16 视觉；F32 解码加指定 BF16 舍入；注意力仍 F32 | 仅数值定位；保留各变体 | [locateanything-fp32-rounding-boundaries-v1.json](../test/results/locateanything-fp32-rounding-boundaries-v1.json) |
| 原权重原生 BF16 注意力 / full_boundaries_native_attention | 85.90% | 85.90% | 67/78/78 | F32 解码加舍入，但注意力使用原生 BF16 CUDA SDPA | 85.90% 仍依赖原生 BF16 注意力；不能称 BPU 可部署方案 | [locateanything-native-attention-rounding-v2.json](../test/results/locateanything-native-attention-rounding-v2.json) |
| 88 候选转 F32 解码 v2 | 63.75% | 65.38% | 51/80/78 | 选定量化权重的 INT8 分支表示；视觉仍 BF16；F32 解码，无最终 logits BF16 格式修复 | 实际 P63.75/R65.38；不得把继承的 selected_candidate_pc_quality 当本轮成绩 | [locateanything-trial88-fp32-qualification-v2.json](../test/results/locateanything-trial88-fp32-qualification-v2.json) |
| 最终 logits 舍入 v3 | 84.62% | 84.62% | 66/78/78 | 原生 BF16 视觉/连接器；分支权重表示 + F32 解码；最终 logits 转 BF16 表示值 | 84.62% 的真实出处；视觉仍不是 BPU 对应算式 | [locateanything-trial88-final-logit-format-v3.json](../test/results/locateanything-trial88-final-logit-format-v3.json) |
| 理想权重表示对照 v4 | 84.62% | 84.62% | 66/78/78 | 与 v3 同精度路径，但直接使用选定候选的精确存储权重作对照 | 同为 84.62%；这是权重表示对照，不能说 v4 已验证分支等价或 BPU | [locateanything-trial88-exact-weight-control-v4.json](../test/results/locateanything-trial88-exact-weight-control-v4.json) |
| 全 F32 视觉 v5 | 77.78% | 71.79% | 56/72/78 | 完整 F32 视觉/连接器/解码；最终 logits BF16 表示值 | 作为全视觉 F32 迁移对照，低于 v9 | [locateanything-complete-fp32-image-path-v5.json](../test/results/locateanything-complete-fp32-image-path-v5.json) |
| 视觉逐边界舍入 v6 | 47.56% | 50.00% | 39/82/78 | F32 视觉/连接器加入显式 BF16 边界；F32 解码 | 质量退步；保留拒绝，不能因局部误差小而推广 | [locateanything-image-bf16-boundaries-v6.json](../test/results/locateanything-image-bf16-boundaries-v6.json) |
| 视觉舍入修订 v7 | 73.91% | 65.38% | 51/69/78 | 修订 BF16 边界及残差表示；F32 视觉/解码 | 仍低于 v9；不重复同配置 | [locateanything-image-bf16-boundaries-v7.json](../test/results/locateanything-image-bf16-boundaries-v7.json) |
| 末端低秩补偿 v8 | 49.32% | 46.15% | 36/73/78 | 全 F32 视觉/连接器 + 校准 rank16 特征补偿 + F32 解码 | 局部特征误差下降但最终框质量下降；拒绝该配方 | [locateanything-image-lowrank-calibration-v8.json](../test/results/locateanything-image-lowrank-calibration-v8.json) |
| 仅最终视觉特征舍入 v9 | 79.17% | 73.08% | 57/72/78 | 完整 F32 视觉/连接器，只在最终图像特征转 BF16 表示值；F32 解码/末端 logits 舍入 | 已测完整 F32 视觉路径中双指标最强锚点；R73.08 仍低于此前试用75，不是实际全 BPU | [locateanything-final-image-format-v9.json](../test/results/locateanything-final-image-format-v9.json) |
| 视觉 SDPA 接口 v10 | 68.66% | 58.97% | 46/67/78 | F32 视觉与显式 BF16 边界，尝试原生注意力接口形状/掩码；F32 解码 | 低于 v9；接口调整不能自动视为改进 | [locateanything-native-vision-sdpa-interface-v10.json](../test/results/locateanything-native-vision-sdpa-interface-v10.json) |
| 当前组件算式 v11-r2 | 50.67% | 48.72% | 38/75/78 | 完整27视觉/连接器/36解码/全词表；CUDA 执行当前组件 oracle 算式，含逐算子舍入 | P50.67/R48.72；明显回退。不是精确 BPU 仿真，更不是全板验收；先定位与锚点差异 | [locateanything-bpu-math-oracle-v11-r2.json](../test/results/locateanything-bpu-math-oracle-v11-r2.json) |
| 原版复现 v1 | 100.00% | 100.00% | 78/78/78 | 完全原始 BF16 CUDA 模型，无量化 | 100% 是复现性，不是标注准确率或部署精度 | [locateanything-native-original-regression-recheck-v1.json](../test/results/locateanything-native-original-regression-recheck-v1.json) |
| 环境恢复后原版复现 v2 | 100.00% | 100.00% | 78/78/78 | 完全原始 BF16 CUDA 模型，无量化 | 64/64 响应完全复现；原始参考稳定；不参加量化候选排名 | [locateanything-native-original-regression-recheck-v2.json](../test/results/locateanything-native-original-regression-recheck-v2.json) |

## 如何避免重复试验与丢失最佳方案

1. 新试验开始前先查本表和机器索引，指定对照的实验 ID；写清假设、父版本、只改变哪些变量。
2. 对照权重/manifest 哈希、算式与舍入位置、输入形状/生成模式、源码哈希、数据与原版输出哈希、执行后端。相同配方不重复做；环境恢复复测或修 bug 必须单独说明原因。
3. 优先保留两个质量锚点：88.46% 的 BF16 量化候选用于定位权重量化损失；v9 用于定位完整视觉迁移损失。新版本差于相应锚点就标回退，不覆盖最佳配方。
4. 在相同完整架构上先诊断 P/R，再决定是否为新算式展开昂贵编译；最终必须实际板端验证。不得用单层相对误差替代整模型质量。
5. 每次追加原始报告与新索引版本，保留失败，不把 selected_candidate_pc_quality 等继承字段当成本轮成绩。正式门槛与试用门槛分开记录；降低试用门槛不等于运行链路已经齐备。

机器索引：[locateanything-experiment-ledger-v3.json](../test/results/locateanything-experiment-ledger-v3.json)。包含每份原报告 SHA256、当前源码快照哈希及其历史证明范围、数据指纹、指标位置、逐例计数复核、失败索引。v1/v2 原文件保留；同分时保留更早的最佳锚点。

核验：32 个完整模型实验/变体，均核对同一 64 用例身份，并从逐例结果重算框计数及 P/R；15 份失败报告单独索引。缺少运行时源码哈希的老报告明确标为当前源码快照，不能冒称历史字节级复现证据。

## 下一步选择

v12 控制组已64/64响应精确复现 v9；仅改 BF16 位置插值便使最终框质量显著下降，因此保留 F32 位置插值锚点，拒绝该单变量改动。v13 独立考察输入像素表示，结果见表。完整模型当前组件算式 v11 的低分不得当作新最佳。

视觉旧配方的批量调度器已按 PID/startticks/source 核实后仅 SIGSTOP 主进程，当前编译子进程未中断；保留产物并防止低分算式继续自动扩编。详见 test/results/locateanything-vision-quality-expansion-hold-v1.json。这是编译队列质量复审，目标与生产服务未暂停；勿未经复审盲目 SIGCONT 旧配方。解码器编译继续。

生成后处理已有51用例原版 CUDA 对照及板端 NumPy 回放，涵盖框/点/空框/混合模式；这不是整模型NN验收。CPU原版Softmax对照的2.15e-6概率差异失败报告保留；相同检查阈值下原版实际CUDA对照最大误差3.58e-7通过。温度>0随机采样在本候选明确拒绝；top-k同概率顺序采用固定ID顺序，显式tie用例保留，不宣称跨后端普遍逐位等价。

v14已证明F32 patch Conv→GEMM映射64/64响应精确复现v9。v15将无逐算子舍入的显式F32视觉算式与原生F32位置/RoPE常量连接起来；最终质量以独立逐例计数为准，不用特征桥接小误差替代。实际BPU还存在INT8激活/权重分支和近似算子差别，电脑端诊断不等于实际全BPU验收。

全 BPU 27 层视觉、36 层解码、完整词表与生成控制链路尚需完成，再测实际板端 P/R/耗时/内存并接入独立试用模型与 UI；原有模型保持。
