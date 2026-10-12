# AINVR S100P 原通道工作器移植

远程工作目录：`/home/sunrise/ainvr`。`TecheAI/` 只读。

## 保留与替换

`ai-service/src/pipeline/reused_channel_worker.cpp/.hpp` 来自参考的
`channel_worker.cpp/.hpp`。保留双线程调度、启停、重连、配置热更新、授权停止锁存、
帧采样/背压统计、结果缓存、抓拍供给、SEI 时间戳与输出代次协调。

硬件边界改为：

- 原 `StreamSource` 接口后面的 S100P VPU 解码、独立 NV12 帧。
- `BpuChannelAdapter`：模型元数据初始化与实际模型加载分开。HBM 加载、GLES
  预处理与 BPU 执行在推理线程进行；同一线程销毁资源。
- 抓拍供给：Mali GPU 从 NV12 取指定区域，输出 RGBA，兼容奇数尺寸。
  业务层的 `cv::Mat` 用作字节容器，CPU 仅复制下载的字节。
- 原 `SnapshotStore`、MongoDB、抓拍队列与原 `StreamPublisher` 继续复用。

`s100p_control_service.cpp` 的工厂连接该工作器。模型路径按服务参数
`MODEL_ROOT` 解析，持久化配置保留用户的相对路径。没有 CPU 推理后备。

## 模型契约

生产模型必须是 `provider=bpu` 的 `.hbm`，旁边有 `.hbm.ainvr.json`。
元数据检查通过只表示契约可解析；实际 HBM 是否可加载仍由 SDK 验证。

元数据要求：

| 字段 | 约束 |
|---|---|
| schema_version | 1 |
| target | rdk_s100p |
| adapter | 与通道一致，当前 yolo26_bpu / yoloface_bpu / scrfd_bpu |
| hbm_sha256 | 实际 HBM 全文件 SHA-256 |
| input_size | [高度, 宽度]，与通道及 SDK 张量一致 |
| input_contract | float_nchw 或 nv12_full_range_bt601_embedded |
| output_contract | end2end_xyxy_score_class；SCRFD 使用 scrfd_9_heads |
| class_names | 编译/任务类别表，与显式通道类别表一致 |
| outputs | SDK 顺序的 name、shape，加载时逐项核对 |
| preprocess | rgb_order、normalize、mean[3]、std[3]，后者有限且为正 |

当前检测任务要求 letterbox，插值支持 bilinear / nearest。NV12 嵌入预处理契约
要求编译模型自己完成归一化，不允许通道重复归一化。开放词汇、人脸增强等模型
尚未接入本适配器，需要独立 BPU 任务适配与精度验收。

预启动失败返回 HTTP 422 / `bpu_model_not_ready`，发生在开启解码和清除手工停止
意图之前。保存停止通道的输出地址不要求模型已经安装。

## 验证方法与范围

在开发板上以 root 运行：

```sh
cd /home/sunrise/ainvr
python3 test/ai_port/run_reused_worker_validation.py
python3 test/ai_port/run_reused_worker_service_validation.py
python3 test/ai_port/run_hardware_archive_validation.py
```

硬件测试串行；第二个脚本在独立 loopback 端口运行生产服务构建，使用独立配置、
通道与数据库名，验证保存、回环拒绝、鉴权、缺少 HBM 和停止意图持久化。
它保留生产配置字节，并在结束时停止自己启动的进程。

`reused_worker_test` 用**测试专用模型替身**验证生命周期：真实拉取 `live/xm` 并由
VPU 解码，GPU 下载抓拍区域；固定测试目标只进测试缓存/隔离临时流，
不会写用户识别历史。该测试没有实际执行 BPU 模型。

独立官方 YOLO11 HBM 测试实际执行 BPU，但不是用户 YOLO26 模型的验收。
契约测试故意使用无效 HBM 字节；只能证明预校验行为，不能证明编译模型可用。

结果写入 `test/results/reused-worker-*`、`reused-worker-service-*` 和
`hardware-archive-*`。每份报告明确区分真实硬件、模型替身、用户模型和浏览器验收。

## 尚未完成

用户模型的 HBM 转换、量化精度验证、真实识别到归档/SEI/浏览器链路、
开放词汇与人脸增强适配、全部协议的重连验收、完整新板安装仍未完成。
不能将本组件测试帧率当成产品识别帧率。
