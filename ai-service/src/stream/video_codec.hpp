// 视频编码相关的 NAL 规则:H.264 与 H.265 的差异集中在这里,其余代码只问
// "是不是 VCL / 是不是 IDR / SEI 头是什么",不各自写死 & 0x1F。
// 设计:docs/h265-codec12-support-design-2026-09-29.md §6.5。
#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace ai_service::stream {

enum class VideoCodec { kH264, kH265 };

// "h264"/"h265"(stats、日志、配置用)
const char* CodecName(VideoCodec codec);

// SRS /api/v1/streams 的 video.codec("H264"/"HEVC",大小写与 "H.265" 等写法都认)
std::optional<VideoCodec> ParseCodecName(const std::string& name);

// NAL 头长度:H.264 1 字节,H.265 2 字节
size_t NalHeaderSize(VideoCodec codec);

// 从 NAL 头首字节取类型
int NalType(VideoCodec codec, uint8_t header_byte);

bool IsVcl(VideoCodec codec, int nal_type);

// 允许切段/恢复发送的关键帧:H.264 IDR(5);H.265 只认 IDR(19/20),
// CRA/BLA 后可能跟着依赖上一 GOP 的 RASL 帧,不算(设计 D5)
bool IsIdr(VideoCodec codec, int nal_type);

// Annex-B AU(起始码分隔)里首个 VCL 是不是 IDR
bool AnnexBAuIsIdr(VideoCodec codec, const uint8_t* data, size_t size);
inline bool AnnexBAuIsIdr(VideoCodec codec, const std::vector<uint8_t>& au) {
  return AnnexBAuIsIdr(codec, au.data(), au.size());
}

// 发布支路丢帧/缓存重新对齐后能否在这个 AU 恢复发送:H.264 看 DELTA_UNIT(行为不变);
// H.265 只认首个 VCL 为 IDR 的 AU——h265parse 会把 CRA 也标成非 DELTA_UNIT,
// 从 CRA 恢复会推出缺参考的 RASL 帧(设计 §6.4)。
bool IsShedResumePoint(VideoCodec codec, bool delta_unit, const uint8_t* au, size_t size);

}  // namespace ai_service::stream
