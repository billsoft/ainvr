# SC132GS 摄像头与 ISP 实验

代码与结果：/home/sunrise/ainvr/test/。主板为 **RDK S100P V1P0**。
原生 C 层复用官方 C SDK；Python 管理实验与验收。不需要 GStreamer。
硬件编码为 H.264，FFmpeg 负责 MP4 封装、独立解码和抽帧。

## 4.0.5 系统恢复后的实测

系统已完成恢复与重启，详见 [SYSTEM-RECOVERY.md](SYSTEM-RECOVERY.md)。
I2C1/0x32、I2C2/0x33 芯片 ID 均为 0x0132，符合 SC132GS。
具体 GS130W/WI 产品版本及 IMU 未确认。
实际输入 **1088×1280 RAW10、2-lane**，官方驱动自由运行模式 sensor_mode=1 已可采集。
用户确认扩展板 LPWM 3.3V 开关 ON；模式 6 外部触发仍无帧，不能推断开关未开或传感器损坏。

实测链：MIPI → VIN → ISP1 → YNR1（2D/3D）→ PYM1 → 硬件 H.264 → MP4 → 解码抽帧。
MIPI0 使用 ISP1/slot4 的 DDR 输入；MIPI1 使用 ISP1/slot0 在线输入。
NV12 按实际 stride 保存，CPU 复制给硬件编码器；尚未零拷贝。

| MIPI | 降噪初始化配置 | 录像帧数 | 到帧 FPS | 帧号缺口 | 解码 |
|---|---|---:|---:|---:|---|
| 0 | 2D＋3D | 120 | 29.985 | 0 | PASS |
| 0 | 仅 2D | 120 | 29.987 | 0 | PASS |
| 0 | 仅 3D | 120 | 29.989 | 0 | PASS |
| 0 | 关闭 | 120 | 29.992 | 0 | PASS |
| 1 | 2D＋3D | 120 | 29.993 | 0 | PASS |
| 1 | 仅 2D | 120 | 29.999 | 0 | PASS |
| 1 | 仅 3D | 120 | 30.000 | 0 | PASS |
| 1 | 关闭 | 120 | 29.997 | 0 | PASS |

证据：results/20261009-222819-203325-isp-camera-matrix/matrix.json。
汇总：results/system-recovery/camera-matrix-summary.json。
这是串行单路实验，不证明双路同时运行或曝光同步。
每次预热 60 帧，检查帧号、时间戳、尺寸与实际 AE/AWB 参数。
独立解码检查完整录像帧数，并保存首/中/末帧 PNG。
目前暗场预览主要是噪声，未确认可辨识房间物体；解码通过不等于画质验收通过。

## 复现

```sh
cd /home/sunrise/ainvr/test
python3 inspect_isp_environment.py
python3 test_isp_camera.py --mipi 0 --frames 90
python3 test_isp_camera.py --mipi 1 --frames 90
python3 test_isp_camera_matrix.py --mipi 0 1 --frames 120
python3 test_isp_camera_matrix.py --mipi 0 1 --frames 120 --fixed-2a
python3 test_isp_camera.py --mipi 0 --frames 180 --control-trial
# 外部触发诊断，目前无帧：
python3 test_isp_camera.py --mipi 0 --sensor-mode 6 --trigger-duty 1000 --frames 8
```

目录级锁保证实验串行；每项都有帧数与超时限制，失败记录接收器状态并清理节点。
自己的封装为 native/isp_camera_probe.c，官方源码未修改。

## 手动 AE/AWB 对照

--control-trial 在 180 帧中切换：自动 → 曝光 500 → 曝光 20000 →
R/B=512/128 → R/B=128/512 → 恢复自动；切换后 15 帧采样。
曝光为 SDK 原生值，未将尚未确认的单位解释为微秒。白平衡增益为 Q4.8。
证据：results/20261009-223619-110320-isp_camera/control-effects.json。

所有 set/get 返回成功，AE 模式与曝光读回正确。
亮度差 **1.820/255** 未达到保留的 3/255 门限，曝光像素验收 FAIL，需稳定照明复验。
暖/冷设置的画面 R/B 均值比变化 **1.417 倍**，达到 1.2 倍门限，可见白平衡像素作用。
合并检查仍为 FAIL，没有以白平衡有效掩盖曝光未充分验证。

固定 2A 的矩阵已另完成：曝光 20000、analog 128、digital 0、ISP 32、R/B=256/256；每次持续核对读回值。
证据：results/20261009-230529-945772-isp-camera-matrix/matrix.json，汇总在 results/system-recovery/camera-fixed2a-summary.json。
两路各四组、每组 120 帧，29.980～29.992 FPS，帧号缺口为 0，完整录像解码通过。
在当前暗场下，开启 YNR 与关闭的帧间残差没有显示一致的显著降低，不能据此宣称已验证 2D/3D 降噪质量。

## 功能边界

| 功能 | 当前证据与缺口 |
|---|---|
| MIPI/VIN、ISP、NV12、PYM、硬件编码 | 两路串行 8 组采集、录像、解码通过；有照明的真实场景尚待检查 |
| AE/AWB 自动 | 获取接口、自动模式、参数通过；可控亮度/色温下的收敛未验收 |
| 手动 AWB | 参数读回及 R/B 画面变化有效 |
| 手动 AE | 参数有效，暗场像素变化未达到门限 |
| YNR 2D/3D | 自动与固定 2A 两套四配置矩阵均能录像；本暗场未证明显著降噪，画质验收保留 |
| Bayer / YUV | LSB-first RAW10 回灌已通过已知 RGB 彩条；demosaic 旁路有明确像素变化，见 ISP-DIY.md |
| 坏点、shading、Iridix | 9 类模块的接口与已知素材对照已完成；像素变化、默认已旁路和无作用分别报告，不等于标定质量合格 |
| 黑电平 | 零输入基础检查通过；非零恒定输入存在空间校正变化，独立黑电平系数扫描未实现 |
| AF | SDK 算法枚举只提供 AE/AWB，镜头执行器未确认，不能宣称完整 3A |
| 外部触发、双目同步 | LPWM 开关 ON 已确认；模式 6 无帧，自由运行不证明同步 |
| 原始 RAW | test_isp_sensor_raw.py 已分别采集 VIN 打包和未打包 RAW；同帧 RAW/YUV 配对仍未实现 |

历史混用 SDK 的失败日志保留；--runtime isolated 只供诊断。
当前默认使用已恢复的 installed SDK 和自由运行模式 1。

## 官方来源

- [GS130 SDK](https://github.com/D-Robotics/gs130_camera_sdk)
- [S100 Camsys](https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/multimedia_development/S100/camsys)
- [ISP 回灌](https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/multimedia_development/multimedia_application/sample_isp)
- [SC132GS 双目](https://developer.d-robotics.cc/rdk_doc/en/rdk_s/Robot_development/boxs/spatial/hobot_stereonet/)

板上源码入口：/app/multimedia_samples/sample_vin/、sample_isp/、
sample_pipeline/single_pipe_vin_isp_ynr_pym_vpu/。
固定版本与源码哈希：results/official-sources.json。
