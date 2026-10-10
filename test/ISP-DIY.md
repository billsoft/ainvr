# 官方更新与 DIY ISP 实验（2026-10-09）

## 当前结果：RAW 输入格式问题已解决

本次成功的回灌格式为 **连续 LSB-first RAW10 bitstream**，每 4 像素连续占 40 位、按低字节先存放。
这与 MIPI 线上 4 个高 8-bit 字节＋低 2-bit 合并字节的排列不同。
内存每行必须补齐到 32 字节；1088 像素的有效数据 1360 字节，对应内存 stride 1376。
`native/isp_raw_lab.c` 会保留输入文件的紧凑行，填充内存行尾并提交对齐的 stride。

默认已改为 dummy、SC132GS calibration、bitstream_lsb10。当前矩阵通过已知渐变、RGB 彩条、零输入，
随后完成 9 类模块的 reference/bypass 与手动 AWB 共 22 次接口/取帧实验。
证据：`results/20261009-225822-359543-isp-raw-matrix/matrix.json`。
逐像素对照：同目录 `pixel-effects.json`。相同彩条、噪声和暗角的重复参考逐字节一致；渐变参考存在最大 2 灰阶差异，应避免把微小变化解释成独立黑电平效果。

| 对照 | 实际图像结果 |
|---|---|
| Demosaic | 旁路后已知彩条变成 Bayer 点阵灰度，Y 平均绝对差 58.334，插值/颜色路径效果已观察 |
| AWB 手动 512/128 | 非饱和灰条 R/B 比相对 unity 改变 2.736 倍，像素作用确认 |
| Mesh shading | Y 平均绝对差 7.906，空间增益作用可见；不证明真实镜头校正质量 |
| Iridix | Y 平均绝对差 2.976，色调响应可见；不是完整 HDR/曝光效果验收 |
| Defect pixel | 已知坏点素材上像素变化，Y 平均绝对差 1.156；校正率与画质仍需进一步定量 |
| Sinter / CNR | 同一噪声输入的旁路像素变化较小；不据此声称显著降噪 |
| Radial shading | 默认已旁路，本次 OR 旁路位是无操作，不算功能通过 |
| RAW frontend / 黑电平 | 零输入无差异；渐变差异仅约 0.034，不能孤立证明黑电平系数正确 |

`test_isp_sinter_sweep.py` 扫描 SDK 返回范围 0..255 的 Sinter target，并检查设置、读回与同输入噪声残差。
手动模块与固件模块控制两种诊断均未观察到 target 改变图像：残差比为 1.0；当前结论 **UNVERIFIED**，脚本以非零状态提示未达到降噪验收。
证据：`results/20261009-230933-047722-isp-sinter-sweep/` 和 `results/20261009-231231-620794-isp-sinter-sweep/`。

```sh
cd /home/sunrise/ainvr/test
python3 test_isp_raw_lab.py --freeze-algorithms
python3 test_isp_raw_matrix.py
python3 analyze_isp_raw_matrix.py results/20261009-225822-359543-isp-raw-matrix/matrix.json
python3 test_isp_sinter_sweep.py
python3 test_isp_sensor_raw.py --mipi 0 --pack-mode 1
python3 test_isp_sensor_raw.py --mipi 1 --pack-mode 0
```

物理 VIN RAW 两种布局已取得文件，包模式检查通过；未打包的 RAW10 样本为 LE uint16，低 6 位为零，符合 MSB 对齐。
相关记录：`results/20261009-225350-851694-isp_sensor_raw/`、`results/20261009-230152-989052-isp_sensor_raw/`。
这两次为不同接口的顺序采集，不是同帧 RAW/YUV 配对。
黑电平独立系数、真实镜头 LUT、AF 与自动闭环仍未完成；后面的旧失败保留为历史诊断。

## 完整传感器尺寸的 RAW 接口计时

`test_isp_raw_lab.py --width 1088 --height 1280 --frames 60 --freeze-algorithms --frame-period-ms 0`
在修正 32 字节行对齐后通过渐变像素检查；60 次提交/取回均完成，输入与输出帧号逐帧一致。
平均 send/get 完成延迟 **1.669 ms**，P50 **1.618 ms**，P95 **1.863 ms**。
这是固定已知 RAW 的顺序回灌接口计时，排除构建与初始化，不能作为完整摄像头流水线或标定后的 ISP 极限额定帧率。
证据：`results/20261009-232256-817874-isp_raw_lab/`、`results/system-recovery/raw-throughput-summary.json`。

同一接口另以 **3840×2160、60 帧**通过渐变验收，全部输入/输出帧号相符。
平均 send/get 完成延迟 **7.649 ms**，P95 **7.837 ms**。
证据：`results/20261009-232706-445387-isp_raw_lab/`、`results/system-recovery/raw-throughput-4k-summary.json`。
这是合成 RAW → ISP → NV12；不包含物理 4K 摄像头、编解码或多路并发，不能把单阶段余量当成整个 4K 流水线保证。

## 已核实的官方资料与代码

- [S100 4.0.5 发布说明](https://developer.d-robotics.cc/rdk_s_doc/Release_Note/s100/v4_0_5)：
  2026-03-03 发布，内核从 6.1.112-rt43 更新为 6.1.158-rt58；明确修复双目 132GS 跑不满 30 FPS。
- [官方资源页](https://developer.d-robotics.cc/rdk_s_doc/en/Quick_start/download?p=RDK+S100&v=4.0.5)：
  当前列出的 S100 镜像/BSP 源码为 RDKS100-V4.0.5_20260507。
  BSP 源码路径为 `RDKS100_V4.0.5-20260507/.../board_support_package/platform_source_code.tar.gz`。
  [构建指南](https://developer.d-robotics.cc/rdk_s_doc/Advanced_development/rdk_gen)说明源码下载需要注册登录，
  商业资料另有访问流程；没有把不同芯片的公开 hobot-camera 仓库冒充 S100 源码。
- [官方 GS130 SDK](https://github.com/D-Robotics/gs130_camera_sdk)：包含 S100 原生 C/C++、Python ctypes 和 ROS 2 层。
  已克隆到 `runtime/gs130-camera-sdk/`，在 S100P 上构建成功；未安装其 Debian 包。
  已有界运行双目 RAW 模式，外部触发模式 6 暂无 MIPI 帧；自己的官方流水线封装使用自由运行模式 1 已能采集。
  固定提交 `12bde1f530533a11eba1803c1de525cee928c88b`，提交日期 2026-09-24，VERSION 0.1.2。
  仓库将其标为开发预览 Alpha；当前已恢复匹配系统，实际外部触发与自由运行结果分别记录。
- [官方 ISP 回灌示例](https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/multimedia_development/multimedia_application/sample_isp)：
  使用虚拟传感器，无需连接实体摄像头；Bayer 顺序必须与 RAW 对应。
  实际源码仍创建 dummy camera、VIN 并 attach，以提供 sensor/tuning 上下文。

S600 的 5.1.0 发布属于另一板型，不能直接视为 S100/S100P 的升级版本。

## 系统恢复已完成

用户授权后已完成官方 4.0.5 的摄像头、多媒体、开发包、示例、内核与 miniboot 安装和待配置事务恢复，并重启。
实际主板为 **RDK S100P V1P0**，当前运行内核为 `6.1.158-rt58-DR-4.0.5-2603191535-gf29a43-g94bc27`。
重启后环境检查通过；两路 SC132GS 各完成 4 种 YNR 配置、每组 120 帧，约 30 FPS，0 帧号缺口，录像解码通过。
详细步骤、包版本、引导读回与保留的历史失败见 [SYSTEM-RECOVERY.md](SYSTEM-RECOVERY.md)；当前摄像头入口见 [ISP-CAMERA.md](ISP-CAMERA.md)。

## 恢复前的历史问题

APT 历史记录显示，2026-10-09 13:23:02 由 aptdaemon 开始更新；没有对应的 End-Date。
dpkg 日志最后停在 13:25:57 的 hobot-miniboot half-installed 状态。
恢复前 641 个期望安装的软件包尚未全部配置，`hobot-miniboot` 为 `iHR`（半安装且要求重装）。
当时内核为 DR-4.0.4，摄像头包已解包为 4.0.5，其他多媒体组件没有全部同步。
这是“未完成升级并混用组件”的证据，不能把它概括为新版官方取消了摄像头支持。

只读的 `apt-get -s -f install` 模拟报告 0 个 Inst、625 个 Conf、0 个 Remv，
没有修复 iHR 引导包，也没有把旧内核与旧多媒体包整体升到新版本；因此不能把这一条命令当成完整修复方案。
历史模拟结果在 `results/isp-recovery-20261009/`；实际授权恢复记录在 `results/system-recovery/`。
没有重新刷整盘镜像；使用官方包恢复匹配的驱动、内核、引导与 SDK。

## DIY 的代码与历史验证

- `native/isp_raw_lab.c`：自己的有限循环，复用官方 dummy 参数和反馈源码；原生硬件接口，不使用 CPU/GPU 模拟 ISP。
  支持 direct（无 camera/VIN）、direct_algorithms（尝试启用算法）、dummy（官方虚拟传感器初始化）三条路径。
  ISP 节点使用完整、清零的 `isp_cfg_t`，参考最新 GS130 S100 实现，明确缓存刷新和失效处理。
- `test_isp_raw_lab.py`：生成渐变、黑场、彩条、噪声、坏点、暗角 RAW；支持 RGGB/GRBG/GBRG/BGGR，
  unpacked uint16 和 MIPI RAW10 5-byte/4-pixel 两种存储；检查 NV12 与基本像素语义。
- `test_isp_raw_matrix.py`：先验收基础成像，再串行运行模块旁路和 AWB 读回实验；基础失败后其他项均 SKIP。

```sh
cd /home/sunrise/ainvr/test
# 历史失败路径诊断，当前默认已改为成功的 dummy + bitstream_lsb10：
python3 test_isp_raw_lab.py --path direct --calibration disable --packing unpacked16 --scenario gradient --frames 8
python3 test_isp_raw_lab.py --path direct_algorithms --calibration disable --packing unpacked16 --scenario gradient --frames 8
python3 test_isp_raw_lab.py --path direct --calibration disable --packing mipi_raw10 --scenario gradient --frames 8
python3 test_isp_raw_lab.py --path dummy --runtime installed --frames 8
python3 test_isp_raw_lab.py --path dummy --runtime isolated --frames 8
python3 test_isp_raw_matrix.py
```

| 实验 | 实测与边界 |
|---|---|
| direct RAW 提交/取帧 | 实际返回了 NV12、尺寸与长度符合；不等于正确成像 |
| direct_algorithms 渐变 | 8 帧完成，但亮度曲线相关性仅约 0.088，像素语义 FAIL |
| direct MIPI RAW10 渐变 | 8 帧完成，但亮度曲线相关性仅约 0.035，像素语义 FAIL |
| 原生 demosaic 旁路 | set/get 接口与帧返回通过；基础成像未通过，不能证明正确插值或旁路效果 |
| 手动 AWB 512/128 | 参数读回 512/128，但输出与参考的哈希相同；没有证明增益作用于图像 |
| installed dummy | camera create 返回 -65667，0 帧 |
| isolated 4.0.5 dummy | camera create 通过，VIN 属性阶段返回 -10，0 帧 |

早期 `210035`、`210125`、`210156`、`210223` 结果的 PASS 只包含传输、布局和参数读回，
随后增加的像素内容验收明确 FAIL；这些早期记录不能用作成像功能通过的证据。
direct 路径没有提交 sensor 的 Bayer metadata，改变素材 Bayer 排列不等于配置了硬件 CFA 相位。
当时未确认直接路径正确的 RAW 输入格式和完整 tuning/context 初始化，不能用这些无效图像的耗时报告 ISP 性能。

## 格式修复前的覆盖与缺口（历史）

| 功能 | 素材/方法 | 目前覆盖 |
|---|---|---|
| Bayer 插值与 YUV | 已知 RGB 彩条、四种 Bayer 相位，颜色优势与尺寸检查 | 实验已实现，基础成像未通过 |
| 黑电平 | 恒定黑场、输入 offset 扫描，对照实际 ISP 黑电平系数 | 黑场和 offset 生成已实现；offset 是输入素材参数，不是 ISP 系数控制 |
| 坏点 | 注入已知冷热像素，defect_pixel 旁路对照 | 素材/旁路已实现，未验收校正效果 |
| Sinter/CNR | 空间噪声输入，模块启用/旁路，固定曝光后比较 | 素材/旁路已实现，未验收降噪效果；不等同 YNR 的全部 2D/3D 功能 |
| 暗角/局部色调 | 合成径向暗角、梯度，shading/iridix 旁路 | 素材/旁路已实现；真实镜头 LUT 和参数标定仍需 tuning 支持 |
| 白平衡 | 手动 gain 的返回码、读回和 RGB 图像变化 | 读回通过，像素效果未通过 |
| AE/AWB 自动算法 | 统计接口、算法状态、随亮度/色温变化的收敛曲线 | 命令读取入口已实现；闭环没有验证 |
| 传感器曝光/增益闭环 | 实体 sensor 控制，或将算法输出反馈到下一帧合成 RAW 的虚拟模型 | 尚未实现虚拟闭环；静态重复 RAW 不能证明真实 sensor AE |
| YNR 2D/3D | ISP1 在线链 + 多帧变化噪声/运动素材，4 种开关配置 | 物理脚本见 ISP-CAMERA.md；当前 RAW 单帧重复不验证时间降噪 |
| AF | AF 算法接口及可控对焦执行器 | 当前 HBN 算法枚举仅 AE/AWB，不能宣称完整 3A |
| MIPI/VIN | 真摄像头的帧计数、包错、曝光帧率 | RAW 回灌不覆盖物理 MIPI 接收 |

我们可以自己开发素材、流水线、控制与验收脚本；要逐项证明 ISP 功能，仍需要可用的驱动、固件和标定上下文。
基础色彩与渐变验收通过后，才有意义继续参数扫描、画质比较及性能测量。

## 4.0.5 重启后、格式修复前的 RAW 回灌复验（历史）

`test_isp_raw_alignment.py` 串行检查 RAW10 在 uint16 内的 0/2/4/6 位移；四项均完成硬件取帧，但输入渐变像素验收仍 FAIL。
`test_isp_raw_lab.py --path dummy --calibration sc132gs --frames 60` 又按 33 ms 间隔喂帧，完整初始化统计缓冲与 DDR 输出，仍未通过渐变验收。
证据分别在 `results/20261009-223530-956730-isp-raw-alignment/` 和 `results/20261009-223936-029168-isp_raw_lab/`。
当时尚未确认正确成像，不能将这些失败记录的耗时作为 ISP 画质或峰值性能结论。
`--isp-test-pattern` 是内部图样接口诊断，会绕过输入内容验收；其结果不证明合成 RAW 解释正确。
