# AINVR 检测输出解码迁移

`ai-service/src/adapters/detection_decode.*` 不依赖 CUDA、TensorRT 或 OpenCV，接收已按 SDK stride/量化参数还原的紧密浮点张量。HBM 原始缓冲必须先经 `platform/tensor_decode.*` 解量化，不能直接强转 float 指针。

## 明确支持的输出契约

- SCRFD：3 个 stride（8/16/32），每位置 2 个 anchor，9 个 `[N,1]` / `[N,4]` / `[N,10]` 输出，允许前置 batch=1。按形状唯一绑定，不依赖编译后的输出顺序。完成距离解码、NMS、框和五点关键点反 letterbox。拒绝缺少/重复检测头、错误长度和非有限数值。
- 六列 end-to-end 检测：`[N,6]` 或 `[1,N,6]`，明确要求 `[x1,y1,x2,y2,confidence,class_id]`，不再次做 NMS。输出类别必须有显式类别表；检查置信度、类别编号和框方向，按置信度稳定排序并限制结果数。

坐标换算使用现有 `ScaleInfo` 和公共后处理，因此这里描述的是 letterbox 输入契约；非等比拉伸、分割 mask、动态文本提示以及去掉 NMS 后的 YOLO 原始检测头仍需各自适配，不能套用六列解码器。

`ainvr_decode_detections` 是离线输出解码工具，读取测试 JSON 张量并输出框/类别/关键点。它不加载 HBM，不是完整 AI 服务。

## 验证

- C++ 固定样本：anchor 重复顺序、跨重复框 NMS、反 letterbox 和关键点的手算坐标；错误/重复输出检测；end-to-end 不重复 NMS。
- `test/ai_port/verify_scrfd_decode.py`：真实 SCRFD ONNX CPU 推理输出与 NumPy 参考算法对比，故意重排输出张量。合成输入，20 个检测结果，坐标/置信度/关键点对拍。
- `test/ai_port/verify_end2end_decode.py`：对上传的 YOLO26m、YOLO26x-face、YOLOv12m-face、YOLOE ONNX 实际六列输出逐个对拍。YOLOE 文件仍然只是固定类别检测输出，不据此声称分割或动态提示可用。

两个脚本使用 `test/runtime/model-audit-20261011/venv/bin/python`，在 `test/results/` 保存独立记录。原模型哈希在运行前后核对，不修改原权重。合成数据只验证接口和算法一致性，不是精度验收，也不是 BPU 执行证据。

本次非空结果对拍：SCRFD 20 个、YOLO26m 20 个、当前固定类别 YOLOE 1 个，最大数值误差为零。两个 face ONNX 在该合成输入上没有检出目标，只通过空结果处理检查，不能据此声称这两个模型的真实人脸框已完成对拍。

## 工具链状态

官方资料目前给出系统 4.0.5 对应 OE 3.7.0，CPU 镜像为 `ai_toolchain_ubuntu_22_s100_s600_cpu:v3.7.0`。官方离线 tar 的 HEAD 响应大小为 11,212,483,072 字节。板上约 3 GiB 剩余空间不足以存放该镜像。

本机 Docker CLI 存在，但 Linux Docker Engine 尚未运行，`hb_compile` 未找到。启动 Docker Desktop 并下载官方镜像的操作被自动审批策略拒绝（只返回 blocked by policy）。没有执行下载、加载镜像或 HBM 编译，没有通过别的命令绕过限制。仍需可用的官方 x86 编译环境，之后验证 nash-m 编译、真实校准精度和板端 BPU 推理。

版本依据：https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/toolchain_development/overview
