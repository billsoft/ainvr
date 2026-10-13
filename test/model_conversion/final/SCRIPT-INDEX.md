# 最终脚本用途与参数索引

运行环境：PC OE GPU 容器用于校准编译；板端验证脚本需要实际 HBRT。源码中保留的历史探针名称不代表其无用，最终 YOLOE 导出/敏感层修复仍依赖这些实现。所有路径参数均应先核对新工作目录，CLI 帮助不是验收。

## 最终固定入口

`final/Get-OeGpu.ps1` 下载校验；`Start-OeGpu.ps1` 启动；`Export-ApprovedCheckpoints.ps1` 导出六份已验收 BC；`run_approved_recipe.py` 校验 BC 并打印或执行固定配方。

## 转换、验证和辅助脚本

### `audit.py`

AINVR uploaded-model inventory; never unpickles PT/PTH checkpoints.

参数：`directory`、`--output`

### `audit_four_model_delivery.py`

AINVR completion audit: real artifacts, running native service and UI evidence.

无通用命令行参数；先阅读脚本中的固定范围。

### `audit_hbm_placement.py`

AINVR record compiled HBM precision/placement; reject neural CPU fallback.

参数：`--hbm`、`--advice`、`--output`

### `benchmark_featuremap_hbm.py`

AINVR bounded real-board featuremap HBM speed test; no accuracy claim.

参数：`--model`、`--input-f32`、`--precision-report`、`--report`、`--frames`

### `capture_ptq_validation.py`

Offline PTQ simulation oracle; never a production inference backend.

参数：`--model`、`--inputs`、`--output`

### `capture_yoloe_detector_validation.py`

AINVR capture 128 independent dynamic-prompt YOLOE detector outputs.

参数：`--backend`、`--model`、`--prepared`、`--images`、`--output`、`--status`、`--baseline-status`、`--bpu-text`、`--bpu-reprta`、`--tokenizer`、`--tokenizer-libraries`、`--text-quality-report`、`--reprta-quality-report`

### `check_yoloe_text_prompt_semantics.py`

AINVR offline real-text/real-image check of the two-input YOLOE ONNX.

参数：`--root`、`--output`

### `collect_yolo26_calibration.py`

Prepare bounded real-camera YOLO26 calibration seeds; never claim HBM acceptance.

参数：`--samples`、`--interval-ms`、`--source`、`--model`

### `compare_hbm_optimization.py`

AINVR compare optimized HBM to an approved HBM on 128 board inputs.

参数：`--baseline`、`--candidate`、`--inputs`、`--output`、`--config`、`--channel`

### `compare_hbm_reference.py`

AINVR compare independent BPU outputs against unquantized FP32 references.

参数：`--reference`、`--actual`、`--kind`、`--output`

### `compare_yoloe_component_optimization.py`

AINVR same-BC O0/O2 comparison for token or dual-input detector HBMs.

参数：`--kind`、`--baseline`、`--optimized`、`--references`、`--images`、`--output`

### `compare_yoloe_detector_validation.py`

AINVR compare complete raw YOLOE BPU detections with the original FP32 oracle.

参数：`--reference`、`--actual`、`--output`

### `compile_mobileclip2_text_candidate.py`

AINVR isolated encoder HBM candidate; no deployment or accuracy approval.

参数：`--model`、`--calibration`、`--output`

### `compile_saved_bc.py`

Compile a verified saved BC in a fresh process; never repeats calibration.

参数：`--bc`、`--expected-sha256`、`--output`、`--jobs`、`--opt`、`--cache-mode`、`--cache-source`、`--filename`

### `compile_yoloe_component.py`

AINVR GPU-toolchain candidates for matching RepRTA or complete YOLOE.

参数：`--kind`、`--prepared`、`--research`、`--images`、`--output`、`--jobs`、`--reuse-calibration`、`--rewrite-float-clip`、`--detector-float-prompt-norm`、`--reprta-weight-ec`、`--reprta-activation-headroom`、`--detector-matching-ec`

### `deploy_verified_hbm_optimization.py`

AINVR install an exact-output optimized HBM with SSD backup and rollback.

参数：`--model`、`--candidate`、`--comparison`、`--compile-status`、`--backup`、`--output`、`--config`、`--channel`

### `evaluate_coco_subset.py`

AINVR AP50 on the user's YOLO-box validation subset (not official COCO mAP).

参数：`--predictions`、`--dataset-manifest`、`--labels`、`--output`

### `export_mobileclip2_text_onnx.py`

AINVR fixed-length, variable-token text ONNX preparation, offline only.

参数：`--encoder`、`--prompt-samples`、`--output`

### `export_yolo26x.py`

AINVR test-only official YOLO26x PT -> ONNX with real-frame numerical parity.

参数：`--task`、`--source`、`--output`、`--image-f32`

### `fetch_yolo26x.py`

AINVR: download the pinned official YOLO26x asset to SSD, verify before use.

无通用命令行参数；先阅读脚本中的固定范围。

### `guard_docker_compile_memory.py`

AINVR host memory guard, scoped to two explicitly owned compile containers.

参数：`--output`、`--max-seconds`

### `make_hbm_contract.py`

AINVR create a candidate model contract from actual SDK tensor metadata.

参数：`--model`、`--description`、`--placement`、`--kind`、`--export-summary`、`--output`

### `make_text_encoder_validation.py`

AINVR independent MobileCLIP2 text oracle; offline development host only.

参数：`--root`、`--output`、`--heldout`

### `prepare_celeba_calibration.py`

AINVR offline CelebA calibration for face detection and GPEN256.

参数：`--root`、`--output`

### `prepare_coco_calibration.py`

AINVR offline calibration: deterministic class coverage, separate validation.

参数：`--images`、`--labels`、`--output`、`--calibration-count`、`--validation-count`

### `prepare_text_final_holdout.py`

AINVR unseen text references from the original MobileCLIP2 TorchScript.

参数：`--root`、`--output`

### `prepare_yoloe_final_images.py`

AINVR deterministic unseen COCO images; offline CPU reference preparation.

参数：`--images`、`--labels`、`--previous`、`--prepared`、`--oracle`、`--output`

### `prepare_yoloe_free_text_semantics.py`

AINVR original FP32 references for predeclared non-COCO free descriptions.

参数：`--root`、`--output`

### `prepare_yoloe_runtime_calibration.py`

AINVR actual MobileCLIP2/RepRTA references and varying YOLOE prompt inputs.

参数：`--root`、`--image-manifest`、`--output`

### `probe_gpu_calibration_runtime.py`

AINVR offline CUDA execution probe; never a board inference backend.

参数：`--model`、`--inputs`、`--output`

### `probe_text_sensitive_precision.py`

AINVR reuse text calibration, diagnose sensitive precision before compilation.

参数：`--candidate`、`--references`、`--output`、`--jobs`、`--sensitive-dtype`、`--explicit-fp16-center`、`--fp32-center-via-add`、`--variant`、`--attention-float-mask`、`--bounded-integer-softmax`、`--attention-input-ec`、`--final-float-norm`、`--linear-weight-ec`、`--float-softmax-tail`

### `probe_yoloe_runtime_prompts.py`

AINVR offline two-input YOLOE-26x export experiment, not production inference.

参数：`--weights`、`--expected-sha256`、`--output`、`--size`、`--max-prompts`

### `reference_dataset_outputs.py`

AINVR offline FP32 reference outputs for independent validation only.

参数：`--root`、`--output`

### `render_gpen_validation.py`

Render fixed validation samples for manual GPEN color/detail inspection.

参数：`--inputs`、`--reference`、`--candidate`、`--output`

### `requantize_saved_calibration.py`

Experimental OE 3.7.0 requantization using preserved calibration thresholds.

参数：`--calibrated`、`--expected-sha256`、`--original-float`、`--output`、`--prefix`、`--ptq-only`、`--weight-type`、`--resize-implementation`、`--softmax-sub-range`

### `rewrite_gpen_static_conv.py`

GPEN batch-one modulated convolutions: Conv(x*s,W)*d == Conv(x,W*s*d).

参数：`--source`、`--output`

### `run_dataset_int8_compile.py`

AINVR official OE INT8 compilation using checked, independent datasets.

参数：`--workspace`、`--output-name`、`--models`、`--calibration-method`、`--prepare-only`、`--gpen-model-path`、`--gpen-parity-report`、`--compiler-jobs`

### `split_mobileclip_token_lookup.py`

AINVR equivalent split token lookup and reuse of saved text calibration.

参数：`--saved`、`--samples`、`--output`、`--jobs`

### `stage_yoloe_component_contract.py`

AINVR: stage a quality-approved YOLOE HBM contract on SSD, not deployment.

参数：`--research`、`--repo`、`--probe`

### `test_hbm_contract.py`

Check the deployment input contract independently of compiler availability.

无通用命令行参数；先阅读脚本中的固定范围。

### `validate_gpen_rewrite.py`

Compare a GPEN graph rewrite with original FP32 outputs, offline only.

参数：`--model`、`--reference`、`--inputs`、`--output`

### `validate_hbm_dataset.py`

AINVR bounded BPU validation capture on independent dataset inputs.

参数：`--model`、`--inputs`、`--precision-report`、`--output`

### `validate_text_encoder_hbm.py`

AINVR real-token encoder validation on S100P BPU, before RepRTA.

参数：`--candidate`、`--references`、`--output`

### `validate_yoloe_free_text_semantics.py`

AINVR native arbitrary strings -> BPU encoder/RepRTA -> BPU detector.

参数：`--references`、`--text`、`--reprta`、`--detector`、`--python`、`--helper`、`--assets`、`--native-probe`、`--output`

### `validate_yoloe_reprta_hbm.py`

AINVR board validation of matching RepRTA on 128 independent raw vectors.

参数：`--candidate`、`--references`、`--output`

### `validate_yoloe_visible_semantics.py`

AINVR: compare every production-NMS detection for predeclared free text.

无通用命令行参数；先阅读脚本中的固定范围。

### `verify_yoloe_descriptions.py`

AINVR offline real-description parity against the reference YOLOE workflow.

参数：`--model`、`--yoloe-onnx`、`--encoder`、`--text-onnx`、`--image-f32`、`--output`、`--description`

### `verify_yoloe_producer.py`

Compare dynamic-prompt ONNX with the user's PT under its producer version.

参数：`--model`、`--onnx`、`--image-f32`、`--text-source`、`--text-onnx`、`--output`
