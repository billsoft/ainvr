# SRT / WHIP 与原 SEI 链路验收

在 `/home/sunrise/ainvr` 以 root 运行：

```sh
python3 test/non_ai/verify_push_protocols.py
```

可选择协议单独验证；单协议通过不代表全矩阵通过：

```sh
python3 test/non_ai/verify_push_protocols.py --protocols srt
python3 test/non_ai/verify_push_protocols.py --protocols whip
```

## 复用范围

测试直接使用现有 `ingest-service/tests/media_probe.py` 的 WHIP 发送端，以及
`test/ai_port/stream_source_sei_probe.cpp` 和前端的 `seiDetections.ts`。
业务链路仍是生产 `StreamSource`、VPU、原 `StreamPublisher`、AU 缓冲和 SEI
接口，没有另一套推流或时间戳实现。

SRT 发送端由系统 FFmpeg 生成小型编码素材，再用项目 FFmpeg 8.1.2 复制发布。
WHIP 的 GStreamer 编码也只生成测试素材。素材为 640×320、15 FPS、8 位、
无 B 帧、闭合 GOP；不作为生产吞吐量基准。

每种协议、编码组合均先发布，再停止并重新发布同一测试流，要求发布会话 ID
更新且收到真实新视频。每个阶段检查：

- 输入和回流均由 S100P VPU 解码，尺寸保持一致。
- 原发布器按解码显示 PTS 给对应 AU 注入 SEI，稳定阶段严格要求匹配。
- 经 SRS 回流后，压缩 VCL 哈希和 DTS 检查通过，没有视频重编码。
- 生产前端 SEI 解析器接受真实码流里的元数据。
- WHIP 会话为 HTTP 201、媒体连接 connected、DELETE 成功。

SEI 使用明确标记的空检测元数据，只验传输协议；没有假装执行用户模型，也
不向用户识别历史写入数据。

## 依赖与发现

本板 GStreamer 为 1.20.3。WHIP 测试发送端还需要：

```sh
apt-get install --no-install-recommends gir1.2-gst-plugins-bad-1.0 gstreamer1.0-nice
```

2026-10-12 只新增了这两个小型依赖，未升级其他软件包。版本分别为
`1.20.3-0ubuntu1.1` 与 `0.1.18-2`。

实际测试发现并纠正了三个测试环境/调用问题：

1. 缺少 GstWebRTC Python 接口和 libnice ICE 插件，发送端无法启动。
2. HTTP 回环地址能建立会话，但本次发送端不能用回环 ICE 地址完成媒体连接。
   读取 eth0 的真实 IPv4 地址作为 `eip` 后，媒体连接成功。
3. H.265 必须带 `codec=hevc`；现有生产 `backend/src/routes/ingest.ts` 已有这一
   逻辑，测试按原代码补齐参数后成功。没有把 H.265 自动降为 H.264。

SRS 官方说明：[候选地址](https://ossrs.io/lts/en-us/docs/v7/doc/webrtc)、
[HEVC 的 WHIP 参数](https://ossrs.io/lts/en-us/docs/v6/doc/hevc)。

## 实测结果

| 输入组合 | 初次/重新发布 | 输入 VPU 帧 | 回流 VPU 帧 | SEI 核对帧 |
|---|---|---:|---:|---:|
| SRT / H.264 | 均通过 | 147 | 24 | 24 |
| SRT / H.265 | 均通过 | 149 | 24 | 24 |
| WHIP / H.264 | 均通过 | 122 | 32 | 24 |
| WHIP / H.265 | 均通过 | 122 | 32 | 24 |

合计八个阶段、652 帧 VPU 解码及 96 帧真实 SEI 解析核对通过。
证据来自分别完成的 SRT 和 WHIP 运行；首次全矩阵运行因 WHIP 依赖缺失失败，
原失败报告保留，不重写为成功。

汇总报告：`test/results/push-protocols-matrix-20261012.json`。

SRT 通过的分项证据位于首次运行报告：
`test/results/push-protocols-20261012-061926-2179786/`。

WHIP 最终通过证据：
`test/results/push-protocols-20261012-062900-2195339/`。

测试停止自己持有的进程和流，不修改用户通道、生产二进制或配置，不重启
生产服务。测试完成后所有测试发布停止，原 `live/xm` 与录像服务正常。
大素材位于 SSD 的 `/mnt/ainvr-ssd/test-media/`。

## 尚未证明

WHIP 直接调用原生 SRS 接口；控制台的鉴权、凭据撤销和通道管理 HTTP 路由仍
需单独验收。前端解析器测试也不等于真实浏览器 WebRTC 播放或画面叠加。
用户模型 BPU 推理、识别归档、含真实目标的 SEI、4K 并发压力、不同 profile、
位深、B 帧、音频及外部网络条件尚不能由本测试证明。
