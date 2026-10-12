# YOLO26 真实图像校准种子

工作目录 `/home/sunrise/ainvr`，目标板 RDK S100P。
此工具补齐模型转换前的数据准备，不产生生产 HBM 或已验证的模型清单。

## 采集和格式验证

```sh
test/runtime/model-audit-20261011/venv/bin/python \
  test/model_conversion/collect_yolo26_calibration.py \
  --samples 20 --interval-ms 500
```

运行账号为 root；硬件采集子进程使用生产 AI 服务的账号 sunrise。
代码位于 `test/model_conversion/calibration_capture.cpp`，通过 BUILD_TESTING
生成独立工具，未改变生产服务的启动流程。

直接复用生产 `StreamSource` 和 `ImagePreprocessor`：VPU 解码后优先 PYM
缩放，GLES 完成颜色转换、letterbox 和归一化。硬件不支持时只允许已实现的
GPU 路径，不允许 CPU 解码或 CPU 图像处理后备。

当前 YOLO26m 输入契约为 RGB、NCHW、float32、`[1,3,640,640]`，像素除以
255，均值为 0，填边色 114。采集时读取真实帧的色彩矩阵及色彩范围信息。
保存文件为小端 float32 原始字节，不含 header，与模型输入顺序一致。

每帧保存源尺寸、源/映射 PTS、硬件后端、范围、SHA-256 与字节数。
脚本重新读取所有张量，检查形状、有限值、范围、填边、画面变化和哈希；
这一步只做格式/数值检查，没有 CPU 图像转换或模型推理。

一次运行最多 60 帧，间隔 200～1000 ms，采集最长 90 秒。
已有输出目录会被拒绝，不能覆盖用户数据。张量位于
`/mnt/ainvr-ssd/model-calibration/`，采集报告和小型测试日志位于 `test/results/`。
数据目录仅允许 sunrise 与 root 访问。

2026-10-12 实测：20 帧来自 3840×1920 的真实 `live/xm`，合计 98,304,000 字节。
通过证据：

`test/results/yolo26-calibration-20261012-061120-2166852/summary.json`

## 编译候选配置

使用采集报告生成独立的工具链配置，不直接部署：

```sh
python3 test/model_conversion/prepare_yolo26_compile.py \
  test/results/yolo26-calibration-20261012-061120-2166852/summary.json \
  /mnt/ainvr-ssd/model-compile-candidates/yolo26-seed-20261012
```

生成器核对原模型与所有样本的 SHA-256、尺寸和目录内容，拒绝覆盖已有输出。
`candidate.yaml` 使用 nash-m 与 featuremap/NCHW 直通输入，不再做一次颜色或
均值/缩放变换。JSON 形式的文件是 YAML 的合法子集。
工具链运行时需要能访问配置中的模型和数据绝对路径；容器中应映射同名路径。
`working_dir` 是编译进程工作目录下的独立 `model_output`。

在已安装的官方工具链环境内，以新实验目录为工作目录执行：

```sh
hb_compile --config /mnt/ainvr-ssd/model-compile-candidates/yolo26-seed-20261012/candidate.yaml
```

配置依据：[官方模型量化编译手册](https://toolchain.d-robotics.cc/guide/ptq/ptq_tool/hb_compile/convert.html)。
目前没有 hb_compile；候选配置尚未经过编译器解析或算子分配验证。
不使用 fast-perf 结果冒充真实校准结果，也不提前生成 `.hbm.ainvr.json`。

## 剩余验收

20 帧只是一段真实流的校准种子，未覆盖多场景、暗光、噪声、目标大小和独立
验证样本，不能视为已接受的代表性校准集。不能用于宣称量化精度、识别 FPS 或
模型已完成 BPU 转换。

后续仍需官方编译器兼容性检查、代表性校准、确认无 CPU 推理算子、核对 SDK
输入输出张量契约、浮点/BPU 输出与任务精度对比，最终验证识别、归档、SEI 和
浏览器整条链路。其他检测模型、提示模型及人脸修复模型需要各自的输入契约和
校准数据，不能直接共用此 RGB/0～1 的 YOLO26 校准集。
