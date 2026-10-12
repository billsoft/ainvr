# AINVR 上传模型检查（2026-10-11）

来源：`/home/sunrise/ainvr/ai-service/models`。原模型未修改。目标板为 S100P，编译目标 `nash-m`。

## 已完成与未完成

- 14 个原始 ONNX 通过 `onnx.checker.check_model(full_check=True)`。
- 13 个原始 ONNX 与独立生成的 SCRFD 640×640 候选，在开发板 ONNX Runtime CPU 上各执行一次，输出均为有限数值。测试输入为零张量，不能据此判断真实检测精度或图像修复质量。
- 检查 3 个 PT 的序列化类型引用，没有执行 pickle 反序列化。它们包含 Ultralytics 模型结构，具备继续研究导出路径的材料，但本次没有执行 PT → ONNX。
- 尚未执行地平线编译器兼容性检查、量化、HBM 编译或用户模型的 BPU 推理。不能将 ONNX checker/CPU PASS 当作 BPU PASS。
- 现有编译入口检查返回 3：未找到 `hb_compile`，不是编译器拒绝模型。板上系统为 4.0.5，官方工具链下载页对应 OE 3.7.0；板端已装 DNN/UCP runtime 不等于装了模型编译器。

## 模型结论

| 模型 | 实际接口与建议 |
|---|---|
| `scrfd_10g_kps.onnx` | 动态高宽，9 个输出（分数/框/关键点）；已生成并执行 `models/derived/s100p/scrfd_10g_kps_640.onnx`，建议优先进入 HBM 编译验证 |
| `yolo26m.onnx` | 640×640，输出 `[1,300,6]`，COCO 80 类，含 TopK；可作编译起点，是否拆出后处理由编译器检查决定 |
| `yolo26x-face.onnx` | 640×640，输出 `[1,300,6]`，单类 face，含 NonMaxSuppression/ScatterND；保留原 ONNX 对拍，必要时从 PT 重导出原始检测头 |
| `yolov12m-face.onnx` | 640×640，单类 face，带 NMS；已有 ONNX 可作编译起点，目录中未发现对应 PT |
| `yoloe-26x-seg.onnx` | 元数据实际为 detect/YOLOEDetect，类别只有 `adult woman`；唯一输入 images，唯一输出 `[1,300,6]`。没有 mask/prototype 输出，也没有文本特征输入，不能代替完整动态提示分割模型 |
| `yoloe-26x-seg.pt` | 类型引用包含 YOLOESegModel、YOLOESegment26、Proto26、SAVPE；保留了分割结构信息。完整功能需要重导出图像/提示/掩码相关接口并逐项验证 |
| `gpen_bfr_256_sim.onnx` | 256×256，单图输入输出，CPU 运行通过；含 ConvTranspose 等算子，需要编译验证。原始 GPEN 也通过，优先检查简化版；原图的 graph.input 包含可覆盖初始化权重，不应当作必须额外喂入的图片输入 |
| `gfpganv1.4_sim.onnx` | 512×512，单图输入输出；原版与简化版均可运行。修复网络需要检查量化后的细节质量，不以文件能编译作为唯一验收 |
| `codeformer_w02.onnx` / `codeformer_w07.onnx` | 512×512，输入输出形状明确，CPU 运行通过；含 MatMul/TopK 等，建议先检查这些版本。文件名暗示不同修复权重，具体语义仍需导出来源确认 |
| `codeformer.onnx` / `codeformer_single.onnx` | 分别为多输出/单输出，输出存在符号维度；均可运行，需要确认编译时形状推断 |
| `codeformer_qdq.onnx` | 已有 QuantizeLinear/DequantizeLinear，CPU 能运行；已有 ONNX 量化格式不等于地平线量化产物，优先从浮点 ONNX 走官方校准流程 |
| `yoloe-text-encoder/mobileclip2_b.ts` | TorchScript 文本模型，尚未导出或执行；完整文本功能还需匹配 tokenizer/词表与提示编码流程 |
| 两份 `model-0000*-of-00002.safetensors` | 包含 language_model 权重，检查时文件仍在上传增长；不能凭文件名判定具体模型。尚未发现 config、权重索引和 tokenizer 文件，需要完整模型目录才能安排导出/LLM 工具链 |

## 转换路线

已有合适 ONNX → 官方工具链检查/编译试验 → 使用真实场景校准 → nash-m HBM → 板端输出对拍与性能测试。

PT 只在现有 ONNX 接口不满足功能、需要去除嵌入后处理或需要重新导出时使用。已导出的 ONNX 元数据记录 Ultralytics 8.4.138 / 8.4.142 / 8.3.241，应按具体模型锁定导出依赖，不能只安装最新版后假定结果一致。

`test/model_conversion/compile_probe.sh` 必须在官方工具链环境中使用；它使用 `hb_compile --march nash-m --fast-perf`，只用于编译/性能摸底，不产出经真实校准验收的生产模型。编译成功后仍需检查 CPU/BPU 算子分配与模型输入契约。

当前没有代表性校准集。正式量化需要本项目的摄像头/ERP、人脸大小、暗光和噪声场景数据；修复网络还需对比量化前后的视觉质量。

## 产物

- 脚本：`test/model_conversion/audit.py`、`run_onnx.py`、`prepare_scrfd.py`、`compile_probe.sh`
- 环境：`test/runtime/model-audit-20261011/venv`，没有修改服务所用 Python 环境
- 报告：`test/results/model-audit-20261011/inventory.json`、各 `*-runtime.json` 与 `scrfd-preparation.json`
- 静态候选：`ai-service/models/derived/s100p/scrfd_10g_kps_640.onnx`

## 官方依据

- https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/toolchain_development/overview （OE 3.7.0 对应系统 4.0.5）
- https://toolchain.d-robotics.cc/guide/ptq/ptq_tool/hb_compile/convert.html （hb_compile、nash-m、fast-perf 的范围）
- https://toolchain.d-robotics.cc/guide/env_install.html （开发机与 CPU Docker 环境）
