# Qwen3-VL-4B 告警复审 → S100P BPU：脚本索引

总说明见 `docs/S100P-QWEN3VL-ALARM-REVIEW-BPU.md`。PC 侧脚本在编译容器 `ainvr-qwen3vl-20261020` 中运行
（`/models` = D:\models 只读，`/qwork` = D:\codex-task-staging\qwen3vl\work，`/opt/qsdk` = SDK 4.4.8a2 隔离副本与 leap overlay）。

| 阶段 | 脚本 | 说明 |
|---|---|---|
| 公共 | `qwen3vl_common_v1.py` | 固定 448×896、提示词、是/否概率 |
| 数据 | `host_select_coco_v1.py`、`extract_camera_frames_v1.py`、`build_items_v2.py` | COCO 2:1 子集 + 相机帧；校准/开发/独立评估三份互不重叠 |
| 参考 | `reference_bf16_v2.py`、`capture_states_v1.py`、`capture_vision_v1.py`、`gen_vision_feats_v1.py` | 冻结 BF16 结果与逐层状态 |
| 仿真 | `sim_text_quant_v1.py`（rtn/gptq，GPTQ 码输出）、`vision_attr_v1.py`、`score_yesno_v1.py` | PC 归因与 GPTQ |
| 构建 | `qwen3vl_bpu_text_v1.py`、`build_text_group_v1.py`、`qwen3vl_bpu_vision_v1.py`、`build_vision_group_v1.py`、`build_head_v1.py` | O0：校准→导出→转换→编译器参考→编译→链接→BPU-only 断言 |
| O2 | `compile_o2_same_bc_v1.py` | 同一 converted.bc，opt2/balance100 |
| 排查 | `debug_*_v1.py`、`diag_saturation_v1.py`、`score_range_v1.py`、`verify_host_v1.py` | 逐中间张量 taps、饱和诊断、主机侧对齐 |
| 板端 | `qwen3vl_host_v1.py`、`board_run_alarm_v1.py`、`board_validate_fixtures_v1.py`、`board_guard_eval_v2.sh`、`score_board_v1.py` | numpy 主机侧、端到端编排、逐位校验、生产有界暂停守护、评分 |
| 编排 | `run_*_v3*.sh`、`disk_guard_v2.sh`、`move_to_f_v1.sh` | 串行队列（防 OOM）、磁盘守护 |
