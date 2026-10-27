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

固定候选的新增内容验收应显式选择网关、媒体策略和全新输出目录，例如：

```sh
timeout --kill-after=30 240 python3 test/gb28181/lan_receiver.py \
  --board-ip 192.168.100.189 --version 3.0 --signaling udp \
  --media tcp-passive --video hevc --fixture lan-hevc-alaw \
  --gateway out/gb28181/<candidate-gateway> \
  --result test/results/gb28181/<new-lan-run> \
  --record-seconds 8 --recorder --hold-after-record-seconds 75 \
  --reference test/results/gb28181/<hardware-fixtures>/hevc.mp4
```

Windows 对应选择同一版本、媒体模式和与参考内容匹配的 PS 样本，发送 65 秒。先前 30 秒发送可能在设备注册/目录/退避恢复之后留不够录像时间；发送端和接收端应分别核对结果，不因一端退出码为零就认为全链通过。收尾等待应覆盖发送器剩余运行时间。接收器只对隔离平台和 RTP 端口开放摄像头访问，控制 API、HTTP/RTSP 媒体接口绑定回环。

`--reference` 对复制视频身份及真实音频内容做有界片段检查，报告实际候选哈希和音频策略，不再依靠音轨名证明有声。8 秒内容检查不表示 45 秒循环、长期时钟或全端显示延迟均已验证。

## 音频内容与长测复现

新音视频验收必须使用修正后的 PS 生成器：初始 PSM 同时声明所有音轨，不能把接收器补出的静音当作真实摄像头声音。保留正在运行测试所用的旧可执行文件，另建新文件：

```sh
gcc -O2 -I out/gb28181/ZLMediaKit/3rdpart/media-server/libmpeg/include \
  test/gb28181/ps_fixture.c \
  out/gb28181/ZLMediaKit/release/linux/Release/libmpeg.a \
  -o out/gb28181/ps_fixture-pmt2

AINVR_GB_TEST_REMUXER="$PWD/out/gb28181/ps_fixture-pmt2" \
AINVR_GB_TEST_FIXTURE_SUFFIX=-pmt2 sh test/gb28181/prepare-matrix.sh
```

准备脚本拒绝覆盖已有样本；重复运行须选择新的后缀，不删除仍被长测读取的文件。生产及验收媒体配置使用 `enable_audio=1 / add_mute_audio=0 / modify_stamp=0`，分别保证接收真实音频、不伪造静音、保留源音画时钟。

下列内容验证使用已有硬件编码视频，不启用 CPU 视频编码/解码。先确认 VPU 空闲，再生成带独特声音的有界样本；不得与其他硬件实验并行抢占：

```sh
python3 test/onvif/prepare_vpu_fixtures.py \
  --fps 25 --seconds 24 --result test/results/gb28181/<new-fixtures>

python3 test/gb28181/prepare_soak_sources.py \
  --fixtures test/results/gb28181/<new-fixtures> \
  --result test/results/gb28181/<new-sources>

AINVR_GB_TEST_GATEWAY="$PWD/out/gb28181/<candidate-gateway>" \
AINVR_GB_TEST_REMUXER="$PWD/out/gb28181/ps_fixture-pmt2" \
AINVR_GB_TEST_SOURCE_DIR="$PWD/test/results/gb28181/<new-sources>" \
AINVR_GB_TEST_PORT_OFFSET=7000 \
timeout --kill-after=60 7380 python3 test/gb28181/soak.py \
  --channels 4 --seconds 7200 \
  --reference-dir test/results/gb28181/<new-sources>/references \
  --av-check-interval 900
```

双路 24 小时使用 `--channels 2 --seconds 86400`、外部期限 `86580` 和另一个未占用的端口偏移。按需串行运行；已有并行任务时先核对资源和端口。不要终止生产服务或其他任务的测试。

结果保留网关、样本、生成器哈希；开始、周期及结束均检查压缩视频身份和真实音频内容。音画偏移上限 200ms，有界片段漂移上限 50ms；500ms 人工偏移和静音对照必须能被判据检出。容量、媒体内容、浏览器播放和真机兼容是不同验收项，不能互相替代。

如需在不中断长测的情况下补采文件描述符，可用 `observe_resources.py`。`--jobs` 是包含 `jobs:[{"pid":<owned-soak-wrapper-pid>}]` 的本次清单；脚本核对进程命令和启动身份，结果目录必须不存在：

```sh
python3 test/gb28181/observe_resources.py \
  --jobs test/results/gb28181/<owned-job-list>.json \
  --result test/results/gb28181/<new-resource-observation> \
  --seconds 86580 --interval 60
```

该观察不发送信号、不重建进程；支持 `soak.py` 和 `highrate_soak.py` 的已运行任务。记录父PID、启动身份和CPU ticks，RSS使用实际系统页大小。采样完成不是媒体测试通过，进程树还包含发送模拟器及内容判据，Docker SRS须另测；不能将总量当作生产网关内存。

## 高清与 B 帧容量补测

`highrate_soak.py` 复用上面的实际接收链路，只明确选择一种视频测试源；启动前核对分辨率、帧率和码率，不能拿小样本冒充高清容量。源文件应是已有压缩视频，禁止为此启用 CPU 视频编码。

有 B 帧的 TS 重复读取可能丢前导 DTS；视频周期与独立原始音频周期也必须可对齐。`prepare_soak_sources.py` 提供显式测试选项：`--normalize-test-cfr` 仅接受接近完整帧网格的时间戳，`--closed-test-gop-frames` 校验首尾 IDR 和完整图像网格，`--concat-test-seconds` 生成有界 concat 输入。这些不修改生产媒体时间戳。

例如 30FPS、250 帧的 IDR 段，视频周期为 8⅓ 秒；准备 25 秒不重复的测试音频，三个视频循环组成共同周期。参考至少覆盖完整共同周期和一次截图窗口，可选 `--reference-cycles 5`。`distinctive.wav` 的 G711 采样数必须是 160 的整数倍；不能简单截断末包后仍声称周期一致。

```sh
python3 test/gb28181/prepare_soak_sources.py \
  --fixtures test/results/gb28181/<highrate-fixtures> \
  --result test/results/gb28181/<new-highrate-sources> --videos h264 \
  --normalize-test-cfr --closed-test-gop-frames 250 \
  --reference-cycles 5 --concat-test-seconds 7500

AINVR_GB_TEST_GATEWAY="$PWD/out/gb28181/<candidate-gateway>" \
AINVR_GB_TEST_REMUXER="$PWD/out/gb28181/ps_fixture-pmt2" \
AINVR_GB_TEST_SOURCE_DIR="$PWD/test/results/gb28181/<new-highrate-sources>" \
AINVR_GB_TEST_VIDEO_CONCAT=1 AINVR_GB_TEST_SOURCE_FFMPEG=/usr/bin/ffmpeg \
AINVR_GB_TEST_PORT_OFFSET=4000 \
timeout --kill-after=60 7380 python3 test/gb28181/highrate_soak.py \
  --video h264 --channels 4 --seconds 7200 \
  --reference-dir test/results/gb28181/<new-highrate-sources>/references \
  --profile-report test/results/gb28181/<new-profile-report>.json
```

先做 120 秒短测并检查首尾内容，再运行两小时。上述 250 帧只是本次源的真实 IDR 边界，换样本必须重新核对，不能照搬。concat 所需系统 FFmpeg 仅生成测试输入；固定的生产媒体桥接不因此增加软件视频转码。MP4 判据按包偏移读取压缩数据，单包、元数据、进程输出和时间均有界；仍保持 200ms/50ms 门槛，并要求 500ms 与静音对照。

## RTP32 / PS33 时间戳回绕

`virtual_camera.py --timestamp-offset-ticks` 仅在 `--isolated-test` 时允许非零偏移。它同时平移RTP、PES PTS/DTS和PS SCR，而发送节奏始终按未回绕的原始相对时间计算；不会排序回绕后的值制造数小时等待，也不转码视频。交错音视频反复经过边界只计一个时钟代次。

```sh
timeout --kill-after=60 1200 python3 test/gb28181/timestamp_wrap_acceptance.py \
  --gateway out/gb28181/<candidate-gateway> \
  --fixtures test/results/gb28181/<completed-sync>/fixtures.json \
  --references test/results/gb28181/<same-hardware-fixtures> \
  --result test/results/gb28181/<new-wrap-run>
```

使用同一批独特声音的AAC及H264/H265样本，分别验证2016/2022的32位RTP和33位PS边界，共8组。各组要求真实回绕发生于录像活动期，现有录像命令取得连续8秒视频，DTS无断裂，压缩视频/声音内容通过200ms/50ms门槛。报告绑定源与候选哈希，保留失败。接收器成功后正常关闭连接不应导致测试父进程中断收尾；取消进入清理阶段后仍须回收全部自有子进程及隔离容器。

这是加速时钟边界验证，不能代替双路24小时持续运行、实际网络或真机测试。测试监听器沿用 `lan_receiver.py` 的专用端口，已有任务占用时须等待，禁止重启别人的测试或生产服务。

## 部署工具回归（不操作生产）

```sh
cd test/gb28181
python3 -m unittest test_deployment test_console_release test_virtual_camera test_external_acceptance
```

组件测试用临时ARM64格式占位文件和假的 `systemctl`，覆盖校验清单、明确候选哈希、媒体/许可证改动拒绝、安装复制差异、三种启用/运行状态恢复及部署锁。控制台测试执行真实临时目录交换，覆盖源码/产物篡改、健康失败回滚、并发更新冲突、交换中断、磁盘余量及重复回滚拒绝。所有服务操作均替换为模拟调用，不把这些结果当作板上生产发布/回滚演练。

下方是历史仪表盘检查记录，与本轮国标媒体长测分别解释。

## 外置网关的受保护连接

外置部署说明见 `gb28181-service/EXTERNAL-GATEWAY.md`。全局管理地址改为
HTTPS 只配置了控制连接，外置主机还须安全转发 RTMP 发布与 SRS 状态查询。
测试使用真实独立网络空间、HTTPS 证书验证、受限 SSH 和已编译后端映射器，
但参数库为假适配器，不等于物理外置主机或厂商摄像头验收。

```sh
timeout --kill-after=60 480 python3 test/gb28181/external_acceptance.py \
  --gateway out/gb28181/<accepted-gateway> \
  --console out/<accepted-console-build> \
  --source-dir test/results/gb28181/<continuous-soak-sources> \
  --references test/results/gb28181/<same-source-clock-references>/references \
  --remuxer out/gb28181/ps_fixture-pmt2 \
  --result test/results/gb28181/<new-external-run>
```

使用 `prepare_soak_sources.py` 准备的低码率独特声音输入及与发送器相同的
连续参考时钟。参考目录的父目录必须包含对应六个输入文件，运行器逐一
核对 SHA-256；单周期 MP4 不能识别跨循环边界的八秒片段。共享发送器使用
`soak.py` 的 `ContinuousDevice`，仅配置设备地址与输入目录，不复制另一套
媒体发送实现；BYE 和取消均合作停止发送。

2016 TCP/H264/AAC、2022 UDP/H265/G711 A-law 两组，均为网关被动 TCP 媒体。
分别录制恢复前后八秒，核对实际压缩视频与声音；保持 200ms/50ms 门槛。
断开 SSH 后必须实际观察 SRS 发布消失而 HTTPS 仍可用，重建后 60 秒内恢复。
错误令牌须返回 401；不受信证书必须产生真正的证书验证异常，HTTP 错误和
连接拒绝均不能冒充通过。另实际请求 shell 和未授权转发地址，确认均被拒绝。

可选在上述命令增加 `--network-profile bounded-lan`；默认 `none` 不注入。
受损阶段单向延迟 150ms、抖动 ±25ms、随机丢包率 0.001，分别保存启用前、
受损期间及连接恢复后的八秒实际录像。每个版本必须观察到注入丢包且
无转发队列溢出；压缩视频/声音内容仍须满足相同 200ms/50ms 判据。
R12 实测 2016/2022 受损阶段约 11.518/12.189 秒、1087/1457 包、各丢一包；
媒体连接恢复约 23.625/23.016 秒。该短测不证明长期弱网络稳定性、物理
网络指标或标准完整端到端显示延迟；报告明确保留设置值与观察值的区别。

测试占用基准网络空间 `ainvr-onvif-fault`、198.18.0.0/30 链路和自有隔离
SRS。先确认这些对象与专用端口空闲，禁止清理他人任务。管理令牌、TLS/SSH
密钥只写入本次忽略目录且权限受限，退出回收子进程、命名空间和自有容器。
不修改主机信任、物理网卡、防火墙、原 SSH 或生产 SRS。SSH 的固定公钥命令
仅用于隔离夹具，生产使用独立受限账号与正确归属的公钥目录。

## 仪表盘探测修复

2026-10-24 22:29:44、22:46:45、23:22:33 的后端发布重启与探测异常时间相符。
旧前端探测请求 `/api/branding`，后端重启会同时把 nginx 标异常。
现在前端独立验证静态页面壳，后端仍独立探测；不隐瞒实际失败。
失败细分 HTTP 状态、超时、连接拒绝、格式错误与进程采集失败，不记录敏感响应。
只重启了 helper；没有重启 SRS、AI、录像或修改现有通道。
其他历史波动由于旧代码吞掉异常原因，不能据此断言全部都是假警报。
