# AINVR S100P 显示帧时间戳修复

2026-10-11：POC 配对已接入 `ai-service/src/platform/vpu_decoder.cpp`。
正式解码器对每个完整 H.264/H.265 access unit 使用 FFmpeg parser 记录 POC
和调用者 token，在 SDK 返回显示图像时按 display_poc 找回 token。
JPEG 路径保留 SDK 标记。EOS 不进入帧映射，避免尾帧错用 EOS 标记。

GOP 重置导致 POC 重复时取最早尚未返回的匹配项。等待项最多 128 个；解析不完整、
图像损坏、无法配对或解码操作异常时拒绝继续，调用方必须销毁并重建解码器。
不通过推算帧率或回退到 SDK 原始 token 掩盖错误。

测试脚本位于 `/home/sunrise/ainvr/test/ai_port/`：

- `verify_media_source.py`：含 B 帧 MP4 进入完整 VPU→预处理→CPU SCRFD 流程，
  校验 12 帧源 PTS；同时覆盖无 B 帧输入、RTMP 输入和网络超时。
- `verify_vpu_poc.py`：直接调用正式 VPU 封装，分别测试 H.264/H.265、开放/关闭 GOP，
  每个样本 36 帧、不等间隔源 PTS，并对照 FFmpeg 软件解码的逐帧 NV12 和显示时间戳。
  使用 `test/runtime/model-audit-20261011/venv/bin/python` 执行，需要 numpy。

这些样本不代表所有合法码流均已兼容。损坏帧恢复、丢包、分辨率变化、长时运行和
实时服务自动重连仍需独立验收。SDK 头文件对 H.264 POC 的描述与本机实测有差异，
升级 SDK 必须重跑板端测试。当前完整 AI 服务与截图归档尚未上线。
