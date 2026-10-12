# RTSP 接入与断流恢复验收

在开发板 `/home/sunrise/ainvr` 以 root 运行：

```sh
/usr/bin/python3 test/non_ai/verify_rtsp_recovery.py
```

脚本直接导入生产 `ingest-service/main.py` 的 `CopyProcess` 和
`Supervisor`，调用原来的接入、进度检测、超时、退避、重连和清理逻辑。
没有另一套接入业务实现。与只读 TecheAI 的差异为 AINVR 的 FFmpeg
安装路径及可配置的内部监听地址。

## 验收内容

- H.264/TCP、H.264/UDP、H.265/TCP、H.265/UDP 四种 RTSP 接入。
- 实际停止测试摄像头进程，确认接入进程进入重试，随后恢复同一端口的摄像头。
- 确认使用新的接入进程恢复，每种组合在断流前后分别抓取 15 帧。
- 两路并发时暂停一路测试摄像头，确认另一路保持原接入进程、持续收到新帧。
- 所有抓取样本均以生产 AI 服务账号调用实际 S100P VPU 解码，检查帧数、
  尺寸和非空画面；成功运行合计验证 135 帧。

输入为 GStreamer 生成的 640×320、15 FPS 人工测试画面。
GStreamer 的 CPU 编码仅用于测试摄像头素材。生产接入仍使用
FFmpeg 8.1.2 的码流复制；样本由 VPU 解码，没有 CPU 推理或 CPU 解码后备。

摄像头重启的恢复计时截止于接入恢复；另一项计时包含后续抓取与 VPU 校验，
两者不能混为恢复耗时。此测试不作为识别 FPS 或最大吞吐量基准。

## 隔离与结果

测试只使用名称含 `ainvr-rtsp-`、时间戳和 PID 的私有测试流，不创建或修改
用户通道。它不向用户 MongoDB 历史写入识别结果，不重启生产服务。
大样本位于 SSD 支持的 `data/ai/test-runtime/`，报告位于
`test/results/rtsp-recovery-<时间戳>-<PID>/`。

结束时停止自己持有的摄像头和接入进程；Ctrl-C 和 SIGTERM 均执行清理。
失败运行保留日志及 `passed=false` 的报告，不将跳过或部分通过算成成功。

最终脚本的通过报告：

`test/results/rtsp-recovery-20261012-060257-2153089/summary.json`

五个场景和 135 帧验证通过。SIGTERM 期间的独立清理验证见：

`test/results/rtsp-recovery-cancellation-20261012.json`

测试结束后的生产输入、录像健康与参考目录检查见：

`test/results/rtsp-recovery-final-20261012.json`

首次通过报告（保留历史证据）：

`test/results/rtsp-recovery-20261012-055840-2146015/summary.json`

该首次通过运行的旧 `outage_to_recovery_seconds` 字段包含抓取和 VPU 校验；
当前脚本已分别记录两个时长。首次运行验证五个场景、135 帧，其中健康输入
在另一路暂停期间持续增加 255 帧。

## 尚未证明

此测试调用生产接入类和真实 SRS/VPU，但不是配置中心到接入服务的全部 HTTP
控制流程验收，也不是 RTSP 认证、多路 4K 持续运行、RTMP/SRT/WebRTC 全协议、
用户模型 BPU 推理、SEI 识别叠加或浏览器播放验收。
这些仍需分别验证，不能因本脚本通过而宣称整个移植完成。
