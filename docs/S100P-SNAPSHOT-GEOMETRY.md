# AINVR S100P snapshot geometry

The native `ai-service/src/output/snapshot_plan.{hpp,cpp}` computes ordinary rectangular/square crops and ERP-to-perspective views without CUDA, Jetson or OpenCV. It is compiled into ainvr_ai_core. Source rectangles are x/y/width/height; yaw, pitch and horizontal_fov are radians. Output dimensions preserve reference rounding, including small and odd dimensions.

Ordinary square crops retain border replication; rectangular crops clip to image boundaries. ERP framing projects nine samples per bounding-box edge, applies configured padding, and retains the reference fallback and FOV limits. Invalid detections return nullopt; invalid configurations throw.

Run `python3 test/ai_port/verify_snapshot_plan.py` from the repository. It reads reference fixtures without modifying them and checks 13 valid/invalid detection cases plus six rejected configurations. Evidence: test/results/snapshot-plan-20261011-174945-343680/summary.json. The native build succeeded and all 20 existing CTest groups passed; logs: test/results/snapshot-plan-build.log and snapshot-plan-ctest.log.

This verifies geometry only. It does not prove rendered pixels, reference supersampling/interpolation parity, or integration with channel processing and Mongo archive. Rendering must preserve this field of view. JPEG hardware currently accepts even visible dimensions at least 18; odd/small geometry still needs an explicit encoding solution rather than silently changing the crop. Hardware dispatch remains dedicated IP first, then GLES, then CPU when required.
