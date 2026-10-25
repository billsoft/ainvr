# Windows 国标虚拟摄像头与只读参考

## 参考选择

- WVP: https://github.com/648540858/wvp-GB28181-pro
  已有只读子模块 `third_party/reference/wvp-GB28181-pro`，固定提交
  `2b656f4e55147f2377986a878da01a98ae564fe5`，MIT。核对注册鉴权、目录查询、
  INVITE/ACK/BYE 事务时机。不是运行依赖，不修改子模块内容或跟随 master 自动升级。
- ZLMediaKit: https://github.com/ZLMediaKit/ZLMediaKit
  已由国标构建锁定为独立媒体组件；负责 RTP/PS，不替换现有 SRS。
- sbgb28181: https://github.com/sb-im/sbgb28181
  是可研究的 Python/GStreamer 模拟摄像头，依赖自编译插件，其说明验证环境为 Ubuntu。
  不直接作为已验证的 Windows 产品依赖，也不复制未明确许可的代码。
- SPVMN: https://github.com/GB28181/GB28181-Simulation-Tool
  提供设备/平台模拟，但需要其 Java/SIP Servlet 运行环境，保留为可选独立对测工具。

现有 WVP 信令实现和 ZLM 媒体组件足够参考，无需重复引入完整平台。
开源实现不是正式标准的替代，不等同于 2022 全标准认证。

## Windows 使用

Python 3.10+，不需要 OBS、FFmpeg、GStreamer 或管理员权限来发送已有样本。
将 `device_simulator.py`、`virtual_camera.py` 和 `sample.psrecords` 放在同一目录。
在 AINVR 先配置平台地址、预建设备和独立密码，启动模拟器，目录出现后选择接入。
接入媒体模式与 `--media` 一致。TCP passive 指网关监听、摄像头主动连接。

```powershell
py -3.10 virtual_camera.py --server 192.168.100.189 --local-ip 192.168.100.182 --port 5060 --version 2016 --signaling tcp --media tcp-passive --sample sample.psrecords --seconds 300
```

提示时输入预配置的设备密码。默认设备 ID `34020000001320000001`，视频通道 ID
`34020000001320000002`，平台 ID `34020000002000000001`，域 `3402000000`；
用对应参数改为现场配置。密码不放命令行、日志或仓库。
支持 `--version 2022`、UDP/TCP 信令及 UDP/TCP 主动/被动媒体。
默认五分钟，最长 24 小时；Ctrl+C 停止。进程结束后网关按心跳超时将设备标离线。

`--isolated-test` 使用公开固定测试凭据，仅可连接隔离测试接收器，不用于正式设备。
本次隔离接收器端口为 15060；不修改生产平台配置、摄像头、SRS 或录像设置。
模拟器是有界开发测试工具，未实现所有 SIP 重传、网络恢复和厂商扩展，不当作生产摄像头。
发送报告的 `receiverVerified=false` 是有意的：发出数据不代表接收成功，必须核对接收报告和录像。

## 换成自己的视频

使用原有测试构建产物，在板上复制封装一个短样本：

```sh
python3 test/gb28181/prepare_camera_sample.py /path/to/input.mp4 /path/to/sample.psrecords --seconds 60
```

然后复制样本到 Windows。只复制 H.264/H.265 视频和 AAC 音频，不解码、不视频转码。
其他音频请显式 `--no-audio` 或先准备支持的样本。输出不得覆盖已有文件。
样本最大 128 MiB，制作最多 120 秒；播放时正确推进 PS 的 SCR/PTS/DTS 与 RTP 时间戳。
测试音频为测试音，不是现场麦克风。

## 可复现网络验收

串行运行，先停止本任务自己的长测，不停止生产服务：

```sh
python3 test/gb28181/lan_receiver.py --board-ip 192.168.100.189 --version 2.0 --signaling tcp --media tcp-passive --fixture h264-aac
```

出现 `READY_FOR_WINDOWS_CAMERA` 后，在 Windows 执行上述命令，改端口为 15060，
加 `--isolated-test --seconds 65`。2022 用接收端 `--version 3.0`，发送端 `--version 2022`。
接收端用独立测试 SRS 和 ZLM，制作 45 秒 MP4；验证编码和音轨，最后回收测试进程。
`secondsFromReceiverReady` 包含操作者启动发送端的等待，不是点播首帧延迟。
对应结果在 `test/results/gb28181/lan-probe/`；运行结果目录被 Git 忽略，测试源文件随仓库交付。

## 仪表盘探测修复

2026-10-24 22:29:44、22:46:45、23:22:33 的后端发布重启与探测异常时间相符。
旧前端探测请求 `/api/branding`，后端重启会同时把 nginx 标异常。
现在前端独立验证静态页面壳，后端仍独立探测；不隐瞒实际失败。
失败细分 HTTP 状态、超时、连接拒绝、格式错误与进程采集失败，不记录敏感响应。
只重启了 helper；没有重启 SRS、AI、录像或修改现有通道。
其他历史波动由于旧代码吞掉异常原因，不能据此断言全部都是假警报。
