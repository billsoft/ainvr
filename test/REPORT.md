# RDK S100P 板端硬件实验实测

2026-10-09T15:26:16.445104+08:00

代码位置：`/home/sunrise/ainvr/test/`。本表使用每类资源最后一次完成的记录；原始日志全部保留。
PASS 表示指定参数下的有限帧实验通过；PARTIAL 表示有接口/功能通过，但仍有项目缺少条件。
微基准、单路离线循环和合成输入的结果不能直接视为官方峰值、长期性能或业务吞吐量。

## 各资源结果

| 资源 | 结果 | 通过/失败/跳过 | 原始记录 |
|---|---|---|---|
| cpu | PASS | 2/0/0 | [20261009-152234-793872-cpu](results/20261009-152234-793872-cpu/result.json) |
| memory | PASS | 2/0/0 | [20261009-152239-169738-memory](results/20261009-152239-169738-memory/result.json) |
| gpu | PARTIAL | 2/0/1 | [20261009-151736-543593-gpu](results/20261009-151736-543593-gpu/result.json) |
| bpu | PASS | 2/0/0 | [20261009-151737-009056-bpu](results/20261009-151737-009056-bpu/result.json) |
| vpu | PASS | 3/0/0 | [20261009-152115-561998-vpu](results/20261009-152115-561998-vpu/result.json) |
| jpu | PASS | 3/0/0 | [20261009-152239-793665-jpu](results/20261009-152239-793665-jpu/result.json) |
| pym | PASS | 3/0/0 | [20261009-152250-817450-pym](results/20261009-152250-817450-pym/result.json) |
| isp | FAIL | 1/1/0 | [20261009-151746-890488-isp](results/20261009-151746-890488-isp/result.json) |
| gdc | PASS | 1/0/0 | [20261009-151748-058019-gdc](results/20261009-151748-058019-gdc/result.json) |
| stitch | PASS | 1/0/0 | [20261009-151749-425874-stitch](results/20261009-151749-425874-stitch/result.json) |
| camera | PARTIAL | 2/0/1 | [20261009-151750-341543-camera](results/20261009-151750-341543-camera/result.json) |
| ynr | PARTIAL | 2/0/1 | [20261009-151753-565209-ynr](results/20261009-151753-565209-ynr/result.json) |
| mcu | PARTIAL | 1/0/1 | [20261009-151754-732429-mcu](results/20261009-151754-732429-mcu/result.json) |
| display | PARTIAL | 1/0/1 | [20261009-151754-847023-display](results/20261009-151754-847023-display/result.json) |
| storage | PASS | 1/0/0 | [20261009-151754-970779-storage](results/20261009-151754-970779-storage/result.json) |
| network | PARTIAL | 1/0/1 | [20261009-151755-627460-network](results/20261009-151755-627460-network/result.json) |

## CPU、内存、GPU 和 BPU

- CPU：6 核自定义整数混合运算 2.257 Giteration/s，独立 Python 校验通过；不是 DMIPS。
- 内存：64MiB×40 次复制 14.39 GB/s，逐字节读回检查通过；不是 DDR 理论带宽。
- GPU：OpenCL float4 FMA 89.72 GFLOPS；结果经过 CPU 参考校验，未验证显示渲染。
- BPU：resnet18_224x224_nv12，平均 1.391 ms，P95 1.473 ms；同步推理，检查有限/非空/确定性输出，不证明分类准确率。

## 编解码和 PYM 分辨率测试

编解码用合成 NV12 灰度渐变，并验证帧数、尺寸、像素误差及独立 ffprobe；文件写入不在接口计时内。
PYM 对启用层检查尺寸和恒定图像保持，记录 sendframe 到 getframe 完成时间。
1080p 30 帧、4K 12 帧、尺寸边界 8 帧；预热帧不计入下表均值。输入简单，不能推断复杂运动场景的编码极限。

| 模块 | 输入分辨率 | 操作 | 完成帧数 | 平均 ms | 顺序 FPS |
|---|---|---|---:|---:|---:|
| PYM0 | 1920×1080 | 六通道离线循环 | 30 | 1.864 | 536.47 |
| PYM0 | 3840×2160 | 六通道离线循环 | 12 | 7.170 | 139.48 |
| PYM0 | 4096×4096 | 六通道离线循环 | 8 | 14.388 | 69.50 |
| PYM1 | 1920×1080 | 六通道离线循环 | 30 | 1.865 | 536.25 |
| PYM1 | 3840×2160 | 六通道离线循环 | 12 | 7.165 | 139.57 |
| PYM1 | 4096×4096 | 六通道离线循环 | 8 | 14.394 | 69.47 |
| PYM4 | 1920×1080 | 六通道离线循环 | 30 | 2.787 | 358.83 |
| PYM4 | 3840×2160 | 六通道离线循环 | 12 | 10.732 | 93.18 |
| PYM4 | 4096×4096 | 六通道离线循环 | 8 | 21.565 | 46.37 |
| h264 | 1920×1080 | decode | 30 | 3.578 | 279.47 |
| h264 | 1920×1080 | encode | 30 | 3.479 | 287.47 |
| h264 | 3840×2160 | decode | 12 | 11.414 | 87.61 |
| h264 | 3840×2160 | encode | 12 | 12.140 | 82.37 |
| h264 | 8192×4096 | decode | 8 | 44.159 | 22.65 |
| h264 | 8192×4096 | encode | 8 | 47.184 | 21.19 |
| h265 | 1920×1080 | decode | 30 | 3.348 | 298.66 |
| h265 | 1920×1080 | encode | 30 | 3.288 | 304.13 |
| h265 | 3840×2160 | decode | 12 | 9.165 | 109.12 |
| h265 | 3840×2160 | encode | 12 | 11.345 | 88.15 |
| h265 | 8192×4096 | decode | 8 | 33.294 | 30.04 |
| h265 | 8192×4096 | encode | 8 | 44.231 | 22.61 |
| jpeg | 1920×1080 | decode | 30 | 1.902 | 525.79 |
| jpeg | 1920×1080 | encode | 30 | 2.131 | 469.20 |
| jpeg | 3840×2160 | decode | 12 | 7.166 | 139.55 |
| jpeg | 3840×2160 | encode | 12 | 8.045 | 124.31 |
| jpeg | 8192×4096 | decode | 8 | 28.531 | 35.05 |
| jpeg | 8192×4096 | encode | 8 | 31.669 | 31.58 |
| jpeg | 8192×8192 | decode | 8 | 56.506 | 17.70 |
| jpeg | 8192×8192 | encode | 8 | 62.753 | 15.94 |
| mjpeg | 1920×1080 | decode | 30 | 1.876 | 532.91 |
| mjpeg | 1920×1080 | encode | 30 | 2.095 | 477.32 |
| mjpeg | 3840×2160 | decode | 12 | 7.101 | 140.84 |
| mjpeg | 3840×2160 | encode | 12 | 8.042 | 124.34 |
| mjpeg | 8192×4096 | decode | 8 | 28.339 | 35.29 |
| mjpeg | 8192×4096 | encode | 8 | 31.451 | 31.80 |
| mjpeg | 8192×8192 | decode | 8 | 56.430 | 17.72 |
| mjpeg | 8192×8192 | encode | 8 | 63.189 | 15.83 |

## ISP 失败与未完成项

ISP 回灌在 hbn_camera_create 阶段报 -65667，官方 hb_camera_error.h 定义为 HBN_STATUS_CAM_MOD_VERSION_ERROR (0x10083)。
板端相机日志实际报：check dummystd v1.0.0 ko v1.3 > v1.2 error。当前驱动版本超出该相机库接受范围，尚未获得 ISP 输出帧。
诊断见 results/isp-driver-diagnosis.log；没有绕过版本检查或更换系统驱动。

- gpu/OpenGL-ES-rendering：Headless OpenCL tested separately. OpenGL ES rendering needs a connected display and Wayland session.
- camera/sensor-capture-and-frame-rate：Select the connected sensor with --sensor INDEX; no sensor is chosen or initialized automatically
- ynr/ISP1-YNR1-PYM1-online-denoising：Select the connected sensor with --sensor INDEX; no sensor is chosen or initialized automatically
- mcu/IPC-roundtrip-and-real-time-latency：Requires matching MCU echo/test firmware and its IPC endpoint; existing firmware is not replaced
- display/HDMI-scanout-and-render-rate：Needs connected HDMI display and an identified Wayland session
- network/physical-link-TCP-forward-and-reverse：Specify --peer for an existing iperf3 server; loopback does not validate physical Ethernet

## 记录解释与复现

早期 CPU 循环被 GCC 提出计时循环，早期性能数据作废；最终 CPU 代码使用 volatile 输入防止提出，并已重新实测和校验。
曾向 PYM 提交 8192×4096，超过官方 4096×4096 范围，旧日志中的拒绝不作为硬件故障证据；入口已增加范围校验。
旧日志用于开发排错；以本报告链接的记录和 reviewed-summary.json 为本次审阅结果。

```sh
cd /home/sunrise/ainvr/test
python3 selfcheck.py
python3 run_all.py
python3 test_jpu.py --width 8192 --height 8192 --frames 8
python3 test_pym.py --width 4096 --height 4096 --frames 8
python3 summarize.py
```

官方资料和每个实验的计时口径见 README.md。编译记录保留 SDK 来源路径、SHA256、参数、温度和频率快照。
