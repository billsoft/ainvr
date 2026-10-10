# S100P 官方系统恢复记录（2026-10-09）

权威工作目录：`/home/sunrise/ainvr/test/`。用户已授权更新官方代码、包、内核、引导并重启。

## 实际完成

主板设备树与启动参数确认：**D-Robotics RDK S100P V1P0**，S100P 专用 DTB。
已用官方签名 APT 索引验证 9 个相关包的 SHA256，安装统一的软件包并完成 641 项待配置事务。
旧 `linux-headers-6.1.112-rt43` 与新版头文件发生路径碰撞：备份后仅移除无反向依赖的旧头文件，再正常安装新头文件；没有强制覆盖文件。
已有 ethtool 包缺 md5sums 文件，按官方同版重装修复。最终 `dpkg --audit` 无输出，待配置包为 0。

| 组件 | 当前实际版本 |
|---|---|
| 运行内核 | 6.1.158-rt58-DR-4.0.5-2603191535-gf29a43-g94bc27 |
| hobot-camera | 4.0.5-20260226134124 |
| hobot-multimedia | 4.0.5-20260211103855 |
| hobot-multimedia-dev | 4.0.5-20260317191728 |
| hobot-multimedia-samples | 4.0.5-20260211104018 |
| hobot-spdev | 4.0.5-20260211104313 |
| hobot-miniboot | 4.0.5-20260402203050 |
| hobot-firmware | 4.0.3-20250818222930（官方当前候选版本） |

官方 miniboot 包的安装脚本已更新当前 A 引导分区。6 个 NOR 有效载荷与包中官方 `disk/miniboot_flash.img` 对应区域一致；4 个 eMMC 有效载荷与对应官方镜像一致。
部分 `*_signed.img` 比原始 NOR 镜像中的有效载荷多 2048 字节包尾；完整签名容器与物理分区尾部不同不能直接作为刷写失败结论。
核验证据：`results/system-recovery/boot-payload-verification.json`。没有因为该包尾差异再次刷写。
系统已实际重启，重启后的环境检查：`results/20261009-221124-105681-isp-environment/environment.json`。

## 备份与恢复工具

`recover_official_system.py` 保留安装预检、包哈希、日志、旧头文件冲突处理与审计；默认不执行安装，`--help` 说明入口。
备份在 `runtime/system-recovery/backup/`（root 专用权限），包含原引导、包状态和相关配置。
备份清单明确记载未完整读取的备用 NOR 尾部；不能声称已获得整个闪存的完整可恢复镜像。目录按 `.gitignore` 排除，不提交。
实际恢复证据在 `results/system-recovery/`；早期失败和中间核验均保留。

## 本次更新的官方资料与源代码

`sync_official_sources.py` 记录来源、版本和源码哈希，清单在 `results/official-sources.json`。

| 官方来源 | 本地位置与固定版本 |
|---|---|
| [rdk_doc](https://github.com/D-Robotics/rdk_doc) | runtime/rdk-official-docs，2ab42f3c295c1dd1fa94fbf0df24a81442cd642b（2026-09-23） |
| [GS130 Camera SDK](https://github.com/D-Robotics/gs130_camera_sdk) | runtime/gs130-camera-sdk，12bde1f530533a11eba1803c1de525cee928c88b（2026-09-24），0.1.2 Alpha |
| 官方已安装 C 示例 | /app/multimedia_samples；328 个源码哈希及 runtime/ 中原样快照 |

GS130 S100 后端在本板构建成功，其外部触发双目运行尚无帧；没有安装该额外包。
[官方 S100 4.0.5 发布说明](https://developer.d-robotics.cc/rdk_s_doc/Release_Note/s100/v4_0_5)明确包含 SC132GS 双目帧率修复。
[下载页](https://developer.d-robotics.cc/rdk_s_doc/en/Quick_start/download?p=RDK+S100&v=4.0.5)列出 20260507 的 4.0.5 镜像/BSP；完整 BSP 下载需要官方账户，本次没有获得其受限源码。

当前实测摄像头状态与复现实验见 [ISP-CAMERA.md](ISP-CAMERA.md)，RAW 单模块验证缺口见 [ISP-DIY.md](ISP-DIY.md)。
