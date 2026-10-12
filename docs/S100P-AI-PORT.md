# AINVR：Jetson → RDK S100P AI 迁移

目标目录 `/home/sunrise/ainvr`。`TecheAI/` 仅作只读参考。新产品代码与品牌为 AINVR。

## 结论与边界

不是把 CUDA 名称改成 OpenGL 就能完成移植。CUDA 指针、NVMM 帧和 TensorRT engine 都不能直接给 S100P 使用。OpenCV 既包含 CPU 算法也包含 CUDA 包装，须按每个实际用途替换，不能把所有操作机械地送进 NPU。

### 硬件分工修正：专用图像硬件优先

普通 NV12 缩小、多尺度金字塔优先接入已经在 `test/` 验证的 PYM；固定几何映射、鱼眼展开优先评估已验证的 GDC 路径。GPU 用于这些硬件无法覆盖的尺寸、变换、像素处理以及模型所需的归一化/布局转换。不能因为现有 GLES 封装能缩放，就让所有通道默认占用 GPU 做缩放。

必须按输入尺寸、格式、stride、ROI、目标尺寸、缩放比例及插值要求选择后端。PYM 金字塔实验不等于任意目标尺寸和任意滤波方式已验证；GDC 鱼眼 → ERP 实验也不等于 ERP → 透视裁剪自动完成了验证。后端不满足契约时明确报告原因或使用已验证的 GPU 路径，不悄悄改图像算法。

既有实测依据（2026-10-09）：

| 实验 | 结果与解释 |
|---|---|
| `test/results/20261009-153719-344786-pym/report.md` | PYM0/1/4 均通过 4096×4096 输入，六层输出 4096、2048、1024、512、256、128；短程 8 帧实验，PYM0/1 约 69.4 fps、PYM4 约 46.3 fps，不代表多路端到端性能 |
| `test/results/20261009-153456-785329-pym_8k/report.md` | PYM0/1/4 的 7680×3840 → 3840×1920 均在 set_attr 返回 -983049；不能直接把 8K 帧送进这条 PYM 路径 |
| `test/results/20261009-163505-242965-fisheye_erp/report.md` | GDC 鱼眼映射 3840×2160 → 1920×1920，120 帧通过；共享输入约 226 fps，CPU 拷贝加 flush 约 181 fps，均为该独立实验工况 |

优先链路为：VPU/JPU 解码 → PYM 缩放（需要时 GDC 几何映射）→ 必要的色彩/补边/归一化 → BPU。大于 PYM 已验证输入范围的图像另选经实测的路径；分块拼接、任意比例和零拷贝不能仅凭接口存在就算完成。

**当前实现状态：PYM/GDC 实验代码存在，但 AI 服务平台层尚未接入相应后端和自动选择器。新写的 `GlesPreprocessor` 是显式 GPU 实现，不能视为默认硬件调度方案。下一步优先复用 `test/native/pym_probe.c`、`test/native/gdc_erp_probe.c` 的已验证接口接入服务。**

| 原实现 | S100P 方案 | 当前情况 |
|---|---|---|
| 结果结构、NMS、坐标还原、时间戳、重连、SEI、AU 缓冲 | 保留 C++ 业务算法和协议 | 已移入独立构建；测试结果见运行报告 |
| GStreamer 推流、H.265 FLV 元素 | 保留普通 GStreamer；去除旧品牌 | 已移入构建 |
| TensorRT、CUDA 模型执行 | libdnn + libhbucp，HBM 模型、显式缓存同步 | 原生执行接口已实现；模型适配待逐模型验证 |
| GpuMat、CUDA resize/normalize | 缩放优先 PYM，必要的归一化/布局转换使用 GLES，CPU 后备 | 已接入统一预处理接口并实测；完整通道 worker 接入待完成 |
| ERP 透视裁剪 | 连续区域优先 GDC，接缝/极点/超限使用 GLES，CPU 后备 | GDC ERP→透视已实测并对拍；映射重建成本单独记录，详见 S100P-GDC-INTEGRATION.md |
| NVMM、NvBufSurface、nvv4l2decoder | S100 VPU 解码 + 自有帧生命周期；后续 DMA-BUF/EGLImage | 原生解码封装已实现并验证 H.264/H.265、B 帧与 JPEG；尚未接入 AI 通道 |
| JPEG 编码/截图、曝光、复原模型 | JPU/GLES/BPU 分工 | 尚待接入完整截图管线 |
| YOLO26、SCRFD、YOLOFace TensorRT adapter | HBM 输入/输出契约 + 对应 decoder | 用户模型到位后完成数值一致性验证 |
| YOLOE/LocateAnything Torch/CUDA 服务 | 分析图像/文本编码器与动态提示，分别导出可编译子图 | 不承诺任意动态算子都可在 BPU 执行 |
| AI API、配置中心、通道调度、归档 | 延续已有服务契约，替换底层平台接口 | 完整运行服务尚未启用 |

## 已落地代码

`image_preprocessor.*`：专用硬件 → GLES → CPU 的统一 NV12 预处理入口。PYM 缩放、GDC 全景 ERP 透视、GLES 与 CPU 颜色/归一化已接通；结果包含实际 backend 和硬件失败原因。相同视角复用 GDC 配置，跨 ERP 接缝和极点附近转用 GLES。它仍是平台库，不能把库的测试通过当作完整 AI 微服务完成。

`ai-service/src/platform/bpu.*`：加载单模型 HBM（多模型包须指定模型名），读取命名输入/输出、shape、dtype、stride、量化参数，分配 SDK 缓存内存，clean → submit → wait → invalidate，返回原始对齐输出。输入长度严格检查，不把带 padding 的量化输出误当作紧密 float 数组。实例串行执行；SDK 阻塞等待由外部 worker 进程超时监管，不能在硬件尚未结束时释放输入内存。

`gles_preprocess.*`：真实 Mali compute shader，明确 host upload/readback，构造、执行和析构须在同一个线程。默认通过 `/dev/dri/renderD128` 的 GBM/EGL pbuffer 创建离屏上下文，无需桌面或 HDMI；可显式指定 Wayland socket。支持 NV12 的 BT.601/BT.709、全/有限范围 GPU 转 RGB；范围和色彩矩阵必须由流元数据指定。CPU/GPU/BPU 之间仍有拷贝，吞吐不能由 GPU 单次 shader 时间推算。

系统默认 `LD_LIBRARY_PATH` 会把 Mesa 放到前面，运行硬件程序应显式设 `LD_LIBRARY_PATH=/usr/hobot/lib`，不能仅依赖可执行文件的 RUNPATH。上下文检查实际 renderer 必须为 Mali，拒绝软件渲染。

`vpu_decoder.*`：独立提交和获取接口，允许 B 帧重排；支持结束包、输入队列超时和 NV12 行跨度复制。返回帧拥有自己的内存；这是可验证的复制路径，尚未实现跨 VPU/GPU 的 DMA-BUF 零拷贝。暂由单个调度线程驱动；SDK 非超时错误后应销毁并重建 decoder。

`tensor_decode.*`：处理 HBM 对齐跨度、INT8/INT16/INT32、float16 等输出及逐通道量化。`ainvr_infer` 接收真实 SDK 对齐输入文件并输出解量化张量，可用于后续模型对拍，尚不替代各模型的检测/分割后处理。

`tools/model_contract.py`：校验模型格式、S100P 目标、静态输入输出和后处理声明。`tools/inspect_onnx.py` 在转换主机校验 ONNX 并记录算子、维度与哈希。它们不伪装成通用模型转换器。

## 模型交付之后的流程

1. 保存原始权重、模型结构/代码版本、任务类型、类别、输入尺寸、色彩和归一化、输出解释、参考图片与原平台输出。只有 `.engine` 不足以可靠恢复 ONNX；需要原始模型或已导出的 ONNX。
2. 使用该模型官方 exporter 导出 ONNX，固定或确认可支持的维度与 opset。先运行 `inspect_onnx.py`，再用 ONNX Runtime 比对原模型输出。
3. 使用与 S100P 部署 runtime 兼容的官方工具链，目标明确为 **nash-m**。S100 的 nash-e 不能作为新 S100P 模型的默认编译目标。
4. 代表性校准集包含真实暗光、鱼眼/ERP、噪声和目标大小分布；按模型评估 INT8/INT16 混合量化。不把几十张随意图片当作精度验收。
5. 编译 HBM 后读取真实张量布局，按 stride、量化轴和 zero point 做解码，比较类别/框/关键点/掩码。禁止按文件名猜输出结构。
6. 接通 VPU → GLES/PYM/GDC → BPU → 后处理 → SEI/归档，测单路及多路端到端延迟、队列、丢帧和内存；保留原始视频时间戳。

官方 YOLO mapper 的 `--march nash-m` 示例只适用于其支持的 YOLO 导出路径，不能直接套给 SCRFD、CodeFormer 或多模态网络。

## 验证方法

```sh
cmake -S ai-service -B out/build/ai-s100p -DCMAKE_BUILD_TYPE=Release
cmake --build out/build/ai-s100p -j4
ctest --test-dir out/build/ai-s100p --output-on-failure
timeout 60 out/build/ai-s100p/ainvr_bpu_probe /path/model.hbm 10
python3 test/ai_port/verify.py --model /path/model.hbm
python3 test/ai_port/verify_codecs.py
```

probe 的零填充输入只检验硬件执行、内存和输出可达性，不代表检测精度，也不代表视频端到端 FPS。实验记录放在 `test/results/ai-port-20261011/`。

首轮板端结果：104 项 C++ 用例（含 5 项 Mali 像素测试与 2 项张量解码测试）、4 项 Python 张量测试通过。官方 YOLO11n NV12 HBM 连续执行 10 次，确认 SoC 为 `D-Robotics RDK S100P V1P0`，DNN/UCP 版本 3.13.6；输出布局解码为每次 1,209,600 个元素。官方现成文件名含 `nashe`，这只是本次 SDK 执行样本，不改变自有模型编译目标 nash-m。

## 后续验收顺序

1. 平台接口基线：本次已实现上述原生库、协议核心与可重复实验，尚不是完整生产 AI 微服务。
2. 完整服务迁移：先接入已有实测的 PYM/GDC 后端，再将通道 worker、配置中心和 API 接入新帧/张量接口，迁移截图、曝光、归档和模型适配器。不得通过伪造模型结果或移除授权检查宣称服务可用。
3. 模型交付：原模型 → ONNX 对拍 → nash-m HBM 量化/编译 → 精度与端到端验证；每种模型单独验收。
4. 优化：DMA-BUF 零拷贝、PYM/GDC 分工、多路压力和重连恢复。先测实际分辨率与队列，之后才承诺路数/帧率。

## 官方依据

- https://developer.d-robotics.cc/rdk_s_doc/Algorithm_Application/python-api
- https://github.com/D-Robotics/rdk_model_zoo_s/blob/s100/samples/Vision/ultralytics_yolo/README_cn.md
- https://developer.d-robotics.cc/rdk_s_doc/en/FAQ/toolchain

本次读到的板端头文件与 `/app/cdev_demo/bpu` 示例是 C++ SDK 接口的直接依据。实际测试前不宣称所有 AI 功能已迁移完成。
