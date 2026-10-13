# 校准数据准备

当前生产编译使用 512 校准 + 128 独立验证，不再采用早期直播 20 帧种子作为交付数据。完整流程见 [PC GPU 编译手册](../../docs/S100P-HBM-PC-GPU.md#51-校准输入)。

- COCO80：`prepare_coco_calibration.py`，用户 COCO 图像与对应 YOLO 标签。
- Face / GPEN：`prepare_celeba_calibration.py`，CelebA 图像、官方 bbox 和分区。
- YOLOE：`prepare_yoloe_runtime_calibration.py` 及文字/独立图像工具，见 `final/SCRIPT-INDEX.md`。
- `collect_yolo26_calibration.py` / `calibration_capture.cpp` 仍用于核对生产硬件前处理契约，不是替代代表性数据集。

早期 seed 编译脚本及原说明已可恢复归档，位置见 `final/cleanup-manifest.json`。保留原测试结果，不把旧“尚无编译器”的记录当当前状态。
