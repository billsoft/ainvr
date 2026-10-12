> UPDATE 2026-10-11: Production POC matching is now integrated and tested. B-frame rejection described below is historical. See S100P-VPU-POC-REPAIR.md for current behavior and remaining limits.

# AINVR S100P 视频输入模块

`ai-service/src/stream/media_source.*` 封装 FFmpeg 解封装、H.264/H.265 Annex B
转换、原始 PTS 换算及中断回调。`ainvr_pipeline_probe` 已使用该模块。
输入 URL 不写入业务报告；使用网络地址时仍应避免将带密码的地址放入命令行。

实现边界：单读取线程，允许其他线程调用 Cancel；打开、探测和每次读取分别设置
超时，默认 5 秒。DNS 或第三方协议实现是否及时执行中断回调取决于 FFmpeg；
进程级测试另设外层超时。EOF 与读取失败分开处理。

源 PTS 转为纳秒，缺失时 `source_pts_ns=null`，不伪造时间戳。VPU 使用独立
数据包 token 配对；最多保留 128 个未返回项。现有路径仍有主机内存拷贝。

## 尚未解决的 B 帧时间戳问题

2026-10-11 的 12 帧 H.264 MP4 测试，启用两帧 B 帧重排时，VPU 返回的
token 为 2,3,4,5,6,7,8,9,10,11,0,0，而输入 token 为 0..11。
这不能用于显示帧与源 PTS 的可靠配对。当前探针对 codecpar.video_delay>0
的输入明确报错；不能宣称 B 帧实时业务已经支持，也不能把过去“解出相同帧数”
的测试作为时间戳正确的证据。后续需基于 SDK 显示/解码索引或 POC，验证画面与
源 PTS 的对应关系，并覆盖 GOP 切换、断流重连及参数变化。

## 复现

从 `/home/sunrise/ainvr` 执行：

```sh
python3 test/ai_port/verify_media_source.py
python3 test/ai_port/verify_native_pipeline.py
```

第一项依赖运行中的本机 SRS。使用唯一名称的短时测试流，结束后停止自己的发布进程。
覆盖 B 帧拒绝、无 B 帧 MP4 全部 12 帧 PTS、RTMP 输入三帧、HTTP 对端接受连接但
不返回数据时的读取期限。推理为 CPU SCRFD；没有完成 AI 服务上线、自动重连、
截图归档或长时间实时性能验收。结果写入 `test/results/media-source-*`。
