# RDK S100P 硬件资源实验

在板端项目目录运行。每个资源有独立脚本，默认串行测试、有限帧数、命令超时；
普通硬件实验产物写入本目录的 build/ 和 results/，不修改 /app 官方示例、不写裸块设备。
系统恢复工具另有显式安装入口；本次已获用户授权完成官方包与引导恢复，见 SYSTEM-RECOVERY.md。

## ISP 当前入口（2026-10-09）

官方 4.0.5 系统恢复并重启后，两路 SC132GS 自由运行模式均完成 MIPI → ISP → YNR → PYM → 硬件 H.264 录像。
每路 4 种降噪配置各 120 帧，约 30 FPS，0 帧号缺口，录像解码通过。当前暗场图像的可辨识内容与降噪质量尚未验收。
`python3 test_isp_camera_matrix.py --mipi 0 1 --frames 120` 可复现，详见 [ISP-CAMERA.md](ISP-CAMERA.md)。
手动 AE/AWB 像素对照：`python3 test_isp_camera.py --mipi 0 --frames 180 --control-trial`。
RAW 格式已验证为连续 LSB-first RAW10，32 字节行对齐；`python3 test_isp_raw_matrix.py` 已通过已知渐变、彩条、零输入与模块接口矩阵。
`analyze_isp_raw_matrix.py` 比较模块像素响应；默认已旁路、无可见变化和实际效果分别记录，见 [ISP-DIY.md](ISP-DIY.md)。
Sinter 强度：`python3 test_isp_sinter_sweep.py`；参数可读回，但当前 target 扫描没有可见降噪，验收状态 UNVERIFIED。
物理 RAW 快照：`python3 test_isp_sensor_raw.py --mipi 0 --pack-mode 1`。
固定 2A 的录像矩阵：`python3 test_isp_camera_matrix.py --mipi 0 1 --frames 120 --fixed-2a`，两路各四组约 30 FPS、无帧号缺口。
最新官方源码与 328 个板端示例哈希由 `sync_official_sources.py` 保存于 results/official-sources.json。

## 运行

```sh
cd /home/sunrise/ainvr/test
python3 run_all.py
python3 selfcheck.py
python3 test_gpu.py
python3 test_bpu.py --frames 100
python3 test_vpu.py --width 3840 --height 2160 --frames 60
python3 test_jpu.py --width 3840 --height 2160 --frames 60
python3 test_pym.py --width 3840 --height 2160 --frames 60
python3 run_matrix.py --resource vpu --frames 60
python3 run_matrix.py --resource jpu --frames 8 --include-limits
```

Python >=3.10、gcc、官方 hobot SDK 是基本要求；板上已具备 Python 3.10.12，
NumPy、OpenCV、hbm_runtime、FFmpeg。无需 Node/Bun，也不要替换 Ubuntu 系统 Python。
每项生成 result.json、report.md 和命令日志；run_all.py 生成本次运行的 summary。

## 实验与边界

| 脚本 | 实际验证 | 性能口径/前置条件 |
|---|---|---|
| test_cpu.py | 逐核/全核整数运算、绑核、独立 Python 校验 | 自定义运算次数/秒，不是 DMIPS |
| test_memory.py | 64MiB 数据复制、逐字节检查 | memcpy 有效负载 GB/s，不是 DDR 理论峰值 |
| test_gpu.py | GPU 设备、OpenCL 编译/执行、仿射/FMA 结果 | OpenCL 事件时间；渲染需显示器 |
| test_bpu.py | 模型加载、NV12 两平面、BPU 核调度、确定性 | 同步 run 的均值/P50/P95/FPS，不证明模型准确率 |
| test_vpu.py | H264/H265 硬件编码和解码回环 | 单路、低延迟 GOP；帧数/尺寸/像素误差校验 |
| test_jpu.py | MJPEG/JPEG 硬件编解码回环 | 单路；帧数、尺寸、像素误差校验 |
| test_pym.py | PYM0/1/4，多层尺寸与恒定图像不变性 | sendframe 到 getframe 完成；剔除预热 |
| test_isp.py | ISP 接口；合成 Bayer RAW 或指定素材离线回灌 | 默认生成 RAW10 灰度渐变，检查帧完成和输出，非传感器色彩标定 |
| test_gdc.py | 官方 1080p 校正素材回灌、结果预览 | 整体帧循环时间；不代表标定误差已验收 |
| test_stitch.py | 官方四幅图的 GDC+STITCH 链路 | 整条链路 FPS，不是 STITCH 单独峰值 |
| test_camera.py | MIPI/CIM 节点；可指定传感器链路 | 需实际相机和对应配置 |
| test_ynr.py | YNR1 节点；可指定 ISP1-YNR1-PYM1 链路 | 必须在线链路，不以 CPU 降噪冒充 |
| test_mcu.py | MCU remoteproc 固件与状态 | IPC/实时性能需匹配测试固件；不自动刷写 |
| test_display.py | DRM 状态、模式 | 需 HDMI 和 Wayland，未连接时跳过输出测试 |
| test_storage.py | 64MiB 文件写入/fsync/哈希读回 | 读回可能命中缓存，包含哈希开销 |
| test_network.py | 网口协商状态、可选 iperf3 双向 TCP | --peer 指向已有服务端；不用回环冒充物理网口 |

PASS 表示该项实验有完成和检查证据；PARTIAL 表示部分通过、部分缺条件；
SKIP 不是成功；FAIL 包含返回错误、超时、缺少完成证据、校验不一致。
默认不会据官方峰值阈值判定硬件故障，不会锁频或修改散热配置。
一次执行一个实验；并发执行会因锁文件被拒绝。

## 额外条件

```sh
python3 test_isp.py --raw /path/to/unpacked.raw --raw-format raw10 --width 1920 --height 1080
python3 test_network.py --peer 192.168.100.10
```

test_camera.py 会列出板端官方传感器配置；连接对应相机后，用 --sensor 配置序号、
--gdc-bin 匹配该相机的校正文件运行有限帧的官方 VIN-ISP-PYM-GDC 链路。
test_ynr.py 使用同一入口，并检查实际链路必须启用 ISP1-YNR1-PYM1。
GMSL 相机还需 --link-port 0..3。未指定传感器时，仅构建并列配置，采集项记 SKIP。
可选 camera/ynr 外部命令必须有限结束，并输出 HWJSON 行，包含 completed_frames>0；
只打印帮助或退出码为零不能算通过。接口存在只能算接口检查。
MCU 不刷写，网口不重配置，显示输出不抢占已有会话。

## 官方依据

- [硬件规格](https://developer.d-robotics.cc/rdk_s_doc/01_Quick_start/01_hardware_introduction/01_rdk_s100/01_rdk_s100_kit)
- [Codec 硬件/API](https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/multimedia_development/S100/codec)
- [sample_codec](https://developer.d-robotics.cc/rdk_s_doc/Advanced_development/multimedia_development/multimedia_application/sample_codec)
- [sample_pym](https://developer.d-robotics.cc/rdk_s_doc/Advanced_development/multimedia_development/multimedia_application/sample_pym)
- [sample_gdc](https://developer.d-robotics.cc/rdk_s_doc/Advanced_development/multimedia_development/multimedia_application/sample_gdc)
- [sample_isp](https://developer.d-robotics.cc/rdk_s_doc/Advanced_development/multimedia_development/multimedia_application/sample_isp)
- [Camsys/STITCH/YNR](https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/multimedia_development/S100/camsys)
- [GPU 官方测试](https://developer.d-robotics.cc/rdk_s_doc/Advanced_development/linux_development/hardware_unit_test/10-3d_gpu)
- [DDR 带宽](https://developer.d-robotics.cc/rdk_s_doc/Advanced_development/linux_development/hardware_unit_test/ddr_bandwidth)
- [MCU](https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/mcu_development/basic_information)

native/codec_probe.c 直接包含板上官方 sample_codec.c，复用配置函数，另写有界
编解码循环，不调用有固定 sleep 的示例性能流程。native/sdk_probe.c 直接包含
板上官方示例，通过 getframe 接口记录完成与等待时间；GDC 的原始整数秒计时
有短任务除零风险，本实验另写单调高精度计时循环。
官方代码保留在 /app，构建记录源码 SHA256；SDK 升级后应重新执行。
本项目不将 SDK 通用头文件中的枚举视为已支持的硬件能力。

## 当前板端发现

2026-10-09 的 ISP 离线回灌在 hbn_camera_create 阶段返回 -65667，
对应 hb_camera_error.h 的 HBN_STATUS_CAM_MOD_VERSION_ERROR (0x10083)。
板端相机日志指出 dummystd 支持的驱动版本上限为 v1.2，实际驱动为 v1.3。
该错误如实记录为 FAIL；没有跳过 SDK 版本校验或修改系统驱动。
完整板端实验结果见 REPORT.md 和 results/ 下的原始记录。

## 7680×3840 缩放与 30 FPS 专项

```sh
cd /home/sunrise/ainvr/test
python3 test_vpu.py --width 7680 --height 3840 --frames 120 --sample-decoded --timeout 90
python3 test_gpu_scale.py --frames 60 --timeout 90
python3 test_pym_8k.py --frames 8 --timeout 10
```

test_gpu_scale.py 用 NV12 两平面做精确 1/2 缩放，输出 3840×1920，
分别测单线程 C 参考实现、GPU 核函数，以及每帧上传+计算+下载的时间；
全幅输出逐字节与独立 C 参考比较。输入含空间变化，U/V 分量分别处理。
这个速度不包含 VPU 解码，也不表示一般缩放比、其他滤波器和多路并发的性能。
--sample-decoded 仅保存并检查首尾两帧像素，仍检查全部完成帧数和独立码流帧数，
避免把磁盘写入大幅 NV12 的速度当成解码速度。
test_pym_8k.py 是明确的超规格探测，仅允许 7680×3840 输入、1/2 输出；
默认 test_pym.py 继续限制为官方最大 4096×4096。当前驱动在 set_attr 返回
-983049，三个 PYM 均拒绝；没有帧完成，不能宣称支持这个尺寸或 30 FPS。
当前单项实测与串行/流水线区别见 8K-SCALING.md。

## OpenGL ES 缩放 shader

```sh
cd /home/sunrise/ainvr/test
python3 test_shader_platform.py
python3 test_shader_scale.py
```

默认以 7680×3840 NV12 输入，分别输出 3840×1920、3072×1536、2560×1280；
双线性、三线性、精确区域加权各测 60 帧。shaders/ 内保留可直接参考的 GLSL，
native/gles_scale_probe.c 处理 EGL、纹理、离屏渲染和计时，test_shader_scale.py
逐像素比较独立 CPU 参考。数据、首尾 NV12、mip 层和源码哈希保存在 results/。
三线性包含每帧生成 mipmap 的实验，整数与非整数比例都有验证。
测量分别包含 GPU 驻留输入、每帧上传/读回，另外记录进程 CPU 时间。
详细结果、滤波差别和计时范围见 [SHADER-SCALING.md](SHADER-SCALING.md)。
当前需要已有 Wayland socket /run/user/1000/wayland-0；不打开窗口，不修改桌面服务。

## 鱼眼到经纬展开 ERP：专用 GDC

```sh
cd /home/sunrise/ainvr/test
python3 test_fisheye_erp.py --frames 120
python3 test_fisheye_erp.py --width 3840 --height 2160 --output-width 3840 --output-height 1920 --frames 120
```

用数学定义的 ERP 输出光线生成 GDC CUSTOM 映射，调用 HB_GDC:0 完成 NV12
重采样，未调用 GPU。test_fisheye_erp.py 生成映射并校验像素与世界经纬坐标，
native/gdc_erp_probe.c 生成 bin、提交共享缓冲、取回完成帧并统计 CPU 时间。
映射、bin、NV12、参考图、结果保存在 results/。支持相机中心、半径、FOV 和
鱼眼径向模型参数；当前定量结果使用理想合成鱼眼，实际镜头需提供标定参数。
完整半球的圆边缘与极点差异、4K 吞吐量与 8K 限制见 [FISHEYE-ERP.md](FISHEYE-ERP.md)。
