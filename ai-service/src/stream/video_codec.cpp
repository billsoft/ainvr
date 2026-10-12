#include "video_codec.hpp"

#include <algorithm>
#include <cctype>

namespace ai_service::stream {

const char* CodecName(VideoCodec codec) { return codec == VideoCodec::kH265 ? "h265" : "h264"; }

std::optional<VideoCodec> ParseCodecName(const std::string& name) {
  std::string s;
  for (char c : name) {
    if (c != '.' && c != '-' && c != ' ') s.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
  }
  if (s == "h264" || s == "avc") return VideoCodec::kH264;
  if (s == "h265" || s == "hevc") return VideoCodec::kH265;
  return std::nullopt;
}

size_t NalHeaderSize(VideoCodec codec) { return codec == VideoCodec::kH265 ? 2 : 1; }

int NalType(VideoCodec codec, uint8_t header_byte) {
  return codec == VideoCodec::kH265 ? (header_byte >> 1) & 0x3F : header_byte & 0x1F;
}

bool IsVcl(VideoCodec codec, int nal_type) {
  return codec == VideoCodec::kH265 ? (nal_type >= 0 && nal_type <= 31)
                                    : (nal_type >= 1 && nal_type <= 5);
}

bool IsIdr(VideoCodec codec, int nal_type) {
  return codec == VideoCodec::kH265 ? (nal_type == 19 || nal_type == 20) : nal_type == 5;
}

bool AnnexBAuIsIdr(VideoCodec codec, const uint8_t* d, size_t n) {
  for (size_t p = 0; p + 3 < n; ++p) {
    if (d[p] == 0x00 && d[p + 1] == 0x00 && d[p + 2] == 0x01) {
      int t = NalType(codec, d[p + 3]);
      if (IsVcl(codec, t)) return IsIdr(codec, t);
      p += 2;
    }
  }
  return false;
}

bool IsShedResumePoint(VideoCodec codec, bool delta_unit, const uint8_t* au, size_t size) {
  if (codec == VideoCodec::kH265) return AnnexBAuIsIdr(codec, au, size);
  return !delta_unit;
}

}  // namespace ai_service::stream
