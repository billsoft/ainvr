// FLV 里的 H.265:tag 拆包/粘包/重同步、codec12 与 Enhanced RTMP 两种写法的解析与
// 封装、hvcC 校验。纯 C++、不依赖 GStreamer——GStreamer 1.20 的 flvdemux/flvmux 不认
// HEVC,但 rtmpsrc/rtmp2sink 本身与编码无关(实测),缺的就是这一层;GStreamer 元件
// (flv_hevc_elements)只是它外面的薄壳。
//
// 两种写法(视频 tag body):
//   codec12  :b0 = FrameType<<4 | 12;b1 = AVCPacketType(0 序列头/1 帧/2 结束);
//              b2..b4 = 有符号 24 位 CTS;其后为 hvcC 或长度前缀 NAL
//   Enhanced :b0 = 0x80 | FrameType<<4 | PacketType;b1..b4 = FourCC 'hvc1';
//              PacketType 0 序列头(hvcC)/1 带 CTS 的帧/3 CTS=0 的帧/2 结束
// 设计:docs/h265-codec12-support-design-2026-09-29.md §6.2/§6.3。
#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "video_codec.hpp"

namespace ai_service::stream::flv {

constexpr uint8_t kTagAudio = 8;
constexpr uint8_t kTagVideo = 9;
constexpr uint8_t kTagScript = 18;
constexpr size_t kDefaultMaxTagSize = 16u << 20;  // 16 MiB:超出即视为损坏

struct Tag {
  uint8_t type = 0;
  uint32_t timestamp_ms = 0;  // 含扩展字节的 32 位时间戳(DTS)
  std::vector<uint8_t> body;
};

// 增量读取 FLV 字节流(可有也可没有 FLV 头),产出完整 tag。任意切分、粘包都行;
// 遇到不合法的 tag 头(类型不对、stream id 非 0、超长、PreviousTagSize 不自洽)
// 按字节向前重新同步,跳过的字节计入 skipped_bytes。
class TagReader {
 public:
  explicit TagReader(size_t max_tag_size = kDefaultMaxTagSize);
  void Push(const uint8_t* data, size_t n);
  std::optional<Tag> Next();
  void Reset();

  int64_t resyncs() const { return resyncs_; }
  int64_t skipped_bytes() const { return skipped_bytes_; }
  // 自上次成功读出 tag 以来的连续错误次数(元件据此判定输入已不可用)
  int consecutive_errors() const { return consecutive_errors_; }
  // 当前这次重同步已跳过的字节(找到合法 tag 即清零):持续垃圾输入据此判定为错误
  int64_t episode_skipped() const { return episode_skipped_; }

 private:
  enum class Check { kOk, kNeedMore, kBad };
  Check CheckTagAt(size_t pos, uint32_t* size_out) const;
  void Compact();

  size_t max_tag_size_;
  std::vector<uint8_t> buf_;
  size_t pos_ = 0;
  bool header_checked_ = false;
  bool in_resync_ = false;
  int64_t resyncs_ = 0;
  int64_t skipped_bytes_ = 0;
  int consecutive_errors_ = 0;
  int64_t episode_skipped_ = 0;
};

enum class HevcFlvFormat { kCodec12, kEnhanced };

const char* FormatName(HevcFlvFormat f);
std::optional<HevcFlvFormat> ParseFormatName(const std::string& name);

struct VideoPacket {
  enum class Kind { kSequenceHeader, kFrame, kEndOfSequence };
  Kind kind = Kind::kFrame;
  HevcFlvFormat format = HevcFlvFormat::kCodec12;
  bool keyframe_flag = false;  // FLV FrameType==1,仅作提示;IDR 以 NAL 为准
  int32_t cts_ms = 0;          // PTS - DTS(毫秒,有符号)
  std::vector<uint8_t> data;   // 序列头:hvcC;帧:长度前缀 NAL 序列
};

enum class ParseResult {
  kOk,
  kNotHevc,      // 其他编码(AVC、AV1…):调用方按"不支持的封装"处理
  kUnsupported,  // HEVC 但本版不处理的包(命令帧、元数据包、多轨):跳过
  kMalformed,    // 截断/字段非法:丢弃并计数
};

ParseResult ParseHevcVideoTag(const uint8_t* body, size_t n, VideoPacket* out, std::string* err);

struct HvccInfo {
  int length_size = 4;
  int general_profile_idc = 0;
  // Header metadata corrected from the actual SPS; NAL arrays are unchanged.
  std::vector<uint8_t> normalized;
  std::vector<std::vector<uint8_t>> vps, sps, pps;
};

// 校验 hvcC 与实际 SPS（Main / 8 bit / 4:2:0），修正相机不一致的头字段。
bool ParseHvcc(const uint8_t* d, size_t n, HvccInfo* out, std::string* err);

// 长度前缀 NAL 序列的每个长度都不越界、恰好铺满
bool LengthPrefixedValid(const uint8_t* d, size_t n, int length_size);
// 首个 VCL 是 IDR(19/20)
bool LengthPrefixedIsIdr(const uint8_t* d, size_t n, int length_size);

// ---- 按码流字节认编码(设计 §6.1:码流本身是真相,SRS 查询只是提示)----

// 单个视频 tag body 的编码:经典写法 CodecID 7=H.264、12=H.265;Enhanced RTMP 按 FourCC
// (avc1/hvc1)。其他编码或截断返回 nullopt——不猜。
std::optional<VideoCodec> VideoTagCodec(const uint8_t* body, size_t n);

// 从 FLV 字节流(任意切分)认出首个视频 tag 的编码。认出后恒返回该值且不再缓存数据;
// 1 MiB 内仍没有可识别的视频 tag 就放弃(GaveUp),不无限累积。
class VideoCodecSniffer {
 public:
  std::optional<VideoCodec> Push(const uint8_t* data, size_t n);
  bool GaveUp() const { return gave_up_; }

 private:
  TagReader reader_;
  std::optional<VideoCodec> found_;
  size_t fed_ = 0;
  bool gave_up_ = false;
};

// ---- 封装(每个函数产出一个完整 tag:11 字节头 + body + 4 字节 PreviousTagSize)----
std::vector<uint8_t> BuildFlvHeader();  // 13 字节:FLV 头 + PreviousTagSize0
std::vector<uint8_t> BuildMetadataTag(double width, double height, double fps, HevcFlvFormat fmt);
std::vector<uint8_t> BuildVideoTag(HevcFlvFormat fmt, VideoPacket::Kind kind, bool keyframe,
                                   uint32_t dts_ms, int32_t cts_ms, const uint8_t* data, size_t n);

}  // namespace ai_service::stream::flv
