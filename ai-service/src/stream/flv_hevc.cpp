#include "flv_hevc.hpp"

#include <cstring>
#include <array>
#include <stdexcept>

namespace ai_service::stream::flv {

namespace {

constexpr uint32_t kHvc1 = 0x68766331;  // 'hvc1'
constexpr size_t kTagHeader = 11;
constexpr size_t kPrevSize = 4;
constexpr uint32_t kMaxHeaderSize = 1024;  // FLV 头 DataOffset 上限(规范值为 9,留扩展余量)

uint32_t Be24(const uint8_t* p) { return (uint32_t(p[0]) << 16) | (uint32_t(p[1]) << 8) | p[2]; }
uint32_t Be32(const uint8_t* p) { return (uint32_t(p[0]) << 24) | Be24(p + 1); }
int32_t Si24(const uint8_t* p) {
  int32_t v = static_cast<int32_t>(Be24(p));
  return (v & 0x800000) ? v - 0x1000000 : v;
}

void PutBe(std::vector<uint8_t>& v, uint32_t x, int bytes) {
  for (int i = bytes - 1; i >= 0; --i) v.push_back(static_cast<uint8_t>((x >> (8 * i)) & 0xFF));
}

std::vector<uint8_t> WrapTag(uint8_t type, uint32_t ts, const std::vector<uint8_t>& body) {
  std::vector<uint8_t> t;
  t.reserve(kTagHeader + body.size() + kPrevSize);
  t.push_back(type);
  PutBe(t, static_cast<uint32_t>(body.size()), 3);
  PutBe(t, ts & 0xFFFFFF, 3);
  t.push_back(static_cast<uint8_t>((ts >> 24) & 0xFF));
  PutBe(t, 0, 3);  // stream id
  t.insert(t.end(), body.begin(), body.end());
  PutBe(t, static_cast<uint32_t>(body.size() + kTagHeader), 4);
  return t;
}

int HevcNalType(uint8_t b) { return (b >> 1) & 0x3F; }

// Read only the SPS prefix required for hvcC metadata. Never trust the camera's
// duplicated hvcC profile/bit-depth fields over the actual elementary stream.
class SpsBits {
 public:
  explicit SpsBits(const std::vector<uint8_t>& nal) {
    if (nal.size() < 3 || (nal[0] & 0x80) || HevcNalType(nal[0]) != 33 ||
        (nal[1] & 7) == 0) throw std::runtime_error("invalid SPS NAL");
    int zeros = 0;
    for (size_t i = 2; i < nal.size(); ++i) {
      uint8_t b = nal[i];
      if (zeros >= 2 && b == 3) {
        if (i + 1 == nal.size() || nal[i + 1] > 3)
          throw std::runtime_error("invalid SPS escape");
        zeros = 0;
        continue;
      }
      bytes_.push_back(b);
      zeros = b == 0 ? zeros + 1 : 0;
    }
  }
  uint32_t Read(unsigned n) {
    if (n > 32 || pos_ + n > bytes_.size() * 8)
      throw std::runtime_error("truncated SPS");
    uint32_t v = 0;
    for (unsigned i = 0; i < n; ++i, ++pos_)
      v = (v << 1) | ((bytes_[pos_ / 8] >> (7 - pos_ % 8)) & 1);
    return v;
  }
  void Skip(unsigned n) {
    while (n > 32) { Read(32); n -= 32; }
    Read(n);
  }
  uint32_t Ue() {
    unsigned zeros = 0;
    while (Read(1) == 0) {
      if (++zeros > 30) throw std::runtime_error("SPS Exp-Golomb overflow");
    }
    return ((uint32_t{1} << zeros) - 1) + Read(zeros);
  }
 private:
  std::vector<uint8_t> bytes_;
  size_t pos_ = 0;
};

struct SpsHeader {
  std::array<uint8_t, 12> ptl{};
  uint32_t chroma = 0, luma_depth = 0, chroma_depth = 0;
  unsigned layers = 0, nested = 0;
};

SpsHeader ReadSpsHeader(const std::vector<uint8_t>& nal) {
  SpsBits b(nal);
  SpsHeader s;
  b.Skip(4);  // sps_video_parameter_set_id
  s.layers = b.Read(3);
  if (s.layers > 6) throw std::runtime_error("invalid SPS sublayers");
  s.nested = b.Read(1);
  for (auto& byte : s.ptl) byte = static_cast<uint8_t>(b.Read(8));
  std::array<unsigned, 7> profiles{}, levels{};
  for (unsigned i = 0; i < s.layers; ++i) {
    profiles[i] = b.Read(1);
    levels[i] = b.Read(1);
  }
  if (s.layers > 0) b.Skip((8 - s.layers) * 2);
  for (unsigned i = 0; i < s.layers; ++i) {
    if (profiles[i]) b.Skip(88);
    if (levels[i]) b.Skip(8);
  }
  if (b.Ue() > 15) throw std::runtime_error("invalid SPS id");
  s.chroma = b.Ue();
  if (s.chroma > 3) throw std::runtime_error("invalid SPS chroma");
  if (s.chroma == 3) b.Skip(1);
  if (b.Ue() == 0 || b.Ue() == 0) throw std::runtime_error("invalid SPS dimensions");
  if (b.Read(1)) for (int i = 0; i < 4; ++i) b.Ue();
  s.luma_depth = b.Ue();
  s.chroma_depth = b.Ue();
  return s;
}

}  // namespace

// ========== TagReader ==========

TagReader::TagReader(size_t max_tag_size) : max_tag_size_(max_tag_size) {}

void TagReader::Reset() {
  buf_.clear();
  pos_ = 0;
  header_checked_ = false;
  in_resync_ = false;
  consecutive_errors_ = 0;
  episode_skipped_ = 0;
}

void TagReader::Push(const uint8_t* data, size_t n) {
  Compact();
  buf_.insert(buf_.end(), data, data + n);
}

void TagReader::Compact() {
  if (pos_ > 0 && (pos_ >= buf_.size() || pos_ > (1u << 20))) {
    buf_.erase(buf_.begin(), buf_.begin() + static_cast<std::ptrdiff_t>(pos_));
    pos_ = 0;
  }
}

TagReader::Check TagReader::CheckTagAt(size_t pos, uint32_t* size_out) const {
  if (pos > buf_.size() || buf_.size() - pos < kTagHeader) return Check::kNeedMore;
  size_t avail = buf_.size() - pos;
  const uint8_t* h = buf_.data() + pos;
  uint8_t type = h[0] & 0x1F;  // 高 3 位是保留/加密标志
  if ((h[0] & 0xE0) != 0 || (type != kTagAudio && type != kTagVideo && type != kTagScript)) {
    return Check::kBad;
  }
  uint32_t size = Be24(h + 1);
  if (size == 0 || size > max_tag_size_ || h[8] != 0 || h[9] != 0 || h[10] != 0) return Check::kBad;
  if (avail < kTagHeader + size + kPrevSize) return Check::kNeedMore;
  if (Be32(h + kTagHeader + size) != size + kTagHeader) return Check::kBad;
  *size_out = size;
  return Check::kOk;
}

std::optional<Tag> TagReader::Next() {
  if (!header_checked_) {
    if (buf_.size() - pos_ < 3) return std::nullopt;
    if (std::memcmp(buf_.data() + pos_, "FLV", 3) == 0) {
      if (buf_.size() - pos_ < 9) return std::nullopt;
      const uint32_t hdr = Be32(buf_.data() + pos_ + 5);
      if (hdr >= 9 && hdr <= kMaxHeaderSize) {
        // 头(含扩展字节)+ PreviousTagSize0 收齐之前绝不挪游标:游标永远 <= 缓冲区长度
        if (buf_.size() - pos_ < hdr + kPrevSize) return std::nullopt;
        pos_ += hdr + kPrevSize;
      } else {
        // 非法 DataOffset:不信它,当一段损坏数据,交给下面的逐字节重同步
        in_resync_ = true;
        resyncs_++;
        consecutive_errors_++;
      }
    }
    header_checked_ = true;
  }
  while (true) {
    uint32_t size = 0;
    Check c = CheckTagAt(pos_, &size);
    if (c == Check::kNeedMore) return std::nullopt;
    if (c == Check::kBad) {
      if (!in_resync_) {
        in_resync_ = true;
        resyncs_++;
        consecutive_errors_++;
      }
      pos_++;
      skipped_bytes_++;
      episode_skipped_++;
      if (buf_.size() - pos_ < kTagHeader) return std::nullopt;
      continue;
    }
    in_resync_ = false;
    consecutive_errors_ = 0;
    episode_skipped_ = 0;
    const uint8_t* h = buf_.data() + pos_;
    Tag t;
    t.type = h[0] & 0x1F;
    t.timestamp_ms = Be24(h + 4) | (uint32_t(h[7]) << 24);
    t.body.assign(h + kTagHeader, h + kTagHeader + size);
    pos_ += kTagHeader + size + kPrevSize;
    return t;
  }
}

// ========== 按码流认编码 ==========

std::optional<VideoCodec> VideoTagCodec(const uint8_t* b, size_t n) {
  if (!b || n < 1) return std::nullopt;
  if (b[0] & 0x80) {  // Enhanced RTMP:ExHeader + FourCC
    if (n < 5) return std::nullopt;
    const uint32_t fourcc = Be32(b + 1);
    if (fourcc == kHvc1) return VideoCodec::kH265;
    if (fourcc == 0x61766331) return VideoCodec::kH264;  // 'avc1'
    return std::nullopt;
  }
  switch (b[0] & 0x0F) {
    case 7: return VideoCodec::kH264;
    case 12: return VideoCodec::kH265;
    default: return std::nullopt;
  }
}

std::optional<VideoCodec> VideoCodecSniffer::Push(const uint8_t* data, size_t n) {
  if (found_ || gave_up_) return found_;
  constexpr size_t kGiveUpBytes = 1u << 20;
  reader_.Push(data, n);
  fed_ += n;
  while (auto tag = reader_.Next()) {
    if (tag->type != kTagVideo) continue;
    found_ = VideoTagCodec(tag->body.data(), tag->body.size());
    if (!found_) gave_up_ = true;  // 首个视频 tag 就是不认识的编码:不猜
    reader_.Reset();
    return found_;
  }
  if (fed_ > kGiveUpBytes) {
    gave_up_ = true;
    reader_.Reset();
  }
  return std::nullopt;
}

// ========== 解析 ==========

const char* FormatName(HevcFlvFormat f) { return f == HevcFlvFormat::kEnhanced ? "enhanced" : "codec12"; }

std::optional<HevcFlvFormat> ParseFormatName(const std::string& name) {
  if (name == "codec12") return HevcFlvFormat::kCodec12;
  if (name == "enhanced") return HevcFlvFormat::kEnhanced;
  return std::nullopt;
}

ParseResult ParseHevcVideoTag(const uint8_t* b, size_t n, VideoPacket* out, std::string* err) {
  if (n < 1) {
    if (err) *err = "空视频 tag";
    return ParseResult::kMalformed;
  }
  if (b[0] & 0x80) {  // Enhanced RTMP
    if (n < 5) {
      if (err) *err = "Enhanced 视频 tag 过短";
      return ParseResult::kMalformed;
    }
    if (Be32(b + 1) != kHvc1) {
      if (err) *err = "Enhanced RTMP 非 HEVC(FourCC 不是 hvc1)";
      return ParseResult::kNotHevc;
    }
    int frame_type = (b[0] >> 4) & 0x07;
    int ptype = b[0] & 0x0F;
    out->format = HevcFlvFormat::kEnhanced;
    out->keyframe_flag = frame_type == 1;
    out->cts_ms = 0;
    size_t off = 5;
    switch (ptype) {
      case 0:
        out->kind = VideoPacket::Kind::kSequenceHeader;
        break;
      case 1:
        if (n < 8) {
          if (err) *err = "Enhanced CodedFrames 缺 CTS";
          return ParseResult::kMalformed;
        }
        out->kind = VideoPacket::Kind::kFrame;
        out->cts_ms = Si24(b + 5);
        off = 8;
        break;
      case 3:
        out->kind = VideoPacket::Kind::kFrame;
        break;
      case 2:
        out->kind = VideoPacket::Kind::kEndOfSequence;
        out->data.clear();
        return ParseResult::kOk;
      default:
        if (err) *err = "Enhanced PacketType " + std::to_string(ptype) + " 不处理";
        return ParseResult::kUnsupported;
    }
    if (frame_type == 5) return ParseResult::kUnsupported;  // 命令帧
    out->data.assign(b + off, b + n);
    if (out->data.empty()) {
      if (err) *err = "Enhanced 视频 tag 无数据";
      return ParseResult::kMalformed;
    }
    return ParseResult::kOk;
  }
  int codec_id = b[0] & 0x0F;
  if (codec_id != 12) {
    if (err) *err = "FLV 视频 CodecID " + std::to_string(codec_id) + " 不是 HEVC(12)";
    return ParseResult::kNotHevc;
  }
  if (n < 5) {
    if (err) *err = "codec12 视频 tag 过短";
    return ParseResult::kMalformed;
  }
  int frame_type = (b[0] >> 4) & 0x0F;
  if (frame_type == 5) return ParseResult::kUnsupported;
  out->format = HevcFlvFormat::kCodec12;
  out->keyframe_flag = frame_type == 1;
  out->cts_ms = Si24(b + 2);
  switch (b[1]) {
    case 0:
      out->kind = VideoPacket::Kind::kSequenceHeader;
      break;
    case 1:
      out->kind = VideoPacket::Kind::kFrame;
      break;
    case 2:
      out->kind = VideoPacket::Kind::kEndOfSequence;
      out->data.clear();
      return ParseResult::kOk;
    default:
      if (err) *err = "codec12 AVCPacketType " + std::to_string(b[1]) + " 非法";
      return ParseResult::kMalformed;
  }
  out->data.assign(b + 5, b + n);
  if (out->data.empty()) {
    if (err) *err = "codec12 视频 tag 无数据";
    return ParseResult::kMalformed;
  }
  return ParseResult::kOk;
}

bool ParseHvcc(const uint8_t* d, size_t n, HvccInfo* out, std::string* err) {
  auto fail = [&](const std::string& m) {
    if (err) *err = m;
    return false;
  };
  if (n < 23) return fail("hvcC 过短");
  if (d[0] != 1) return fail("hvcC configurationVersion 不是 1");
  HvccInfo info;
  int lsm1 = d[21] & 0x03;
  if (lsm1 == 2) return fail("hvcC lengthSizeMinusOne=2 非法");
  info.length_size = lsm1 + 1;
  size_t pos = 23;
  for (int a = 0, arrays = d[22]; a < arrays; ++a) {
    if (pos + 3 > n) return fail("hvcC 数组头越界");
    int type = d[pos] & 0x3F;
    int count = (d[pos + 1] << 8) | d[pos + 2];
    pos += 3;
    for (int i = 0; i < count; ++i) {
      if (pos + 2 > n) return fail("hvcC NAL 长度越界");
      size_t len = (size_t(d[pos]) << 8) | d[pos + 1];
      pos += 2;
      if (len == 0 || pos + len > n) return fail("hvcC NAL 数据越界");
      std::vector<uint8_t> nal(d + pos, d + pos + len);
      if (type == 32) info.vps.push_back(std::move(nal));
      else if (type == 33) info.sps.push_back(std::move(nal));
      else if (type == 34) info.pps.push_back(std::move(nal));
      pos += len;
    }
  }
  if (info.vps.empty() || info.sps.empty() || info.pps.empty()) {
    return fail("hvcC 缺少 VPS/SPS/PPS");
  }
  if (pos != n) return fail("hvcC 数组后有多余数据");
  info.normalized.assign(d, d + n);
  try {
    bool first = true;
    for (const auto& nal : info.sps) {
      auto s = ReadSpsHeader(nal);
      const int profile = s.ptl[0] & 0x1F;
      if (profile != 1 || s.chroma != 1 || s.luma_depth != 0 || s.chroma_depth != 0)
        return fail("实际 SPS 不支持(只支持 HEVC Main,8 bit 4:2:0)");
      auto corrected = info.normalized;
      std::copy(s.ptl.begin(), s.ptl.end(), corrected.begin() + 1);
      corrected[16] = 0xFC | s.chroma;
      corrected[17] = 0xF8 | s.luma_depth;
      corrected[18] = 0xF8 | s.chroma_depth;
      corrected[21] = (d[21] & 0xC3) | ((s.layers + 1) << 3) | (s.nested << 2);
      if (!first && corrected != info.normalized)
        return fail("hvcC 内多个 SPS 编码参数不一致");
      info.normalized = std::move(corrected);
      info.general_profile_idc = profile;
      first = false;
    }
  } catch (const std::exception&) {
    return fail("实际 SPS 无效或截断");
  }
  *out = std::move(info);
  return true;
}

bool LengthPrefixedValid(const uint8_t* d, size_t n, int ls) {
  if (n == 0 || (ls != 1 && ls != 2 && ls != 4)) return false;
  size_t pos = 0;
  while (pos < n) {
    if (pos + static_cast<size_t>(ls) > n) return false;
    size_t len = 0;
    for (int i = 0; i < ls; ++i) len = (len << 8) | d[pos + static_cast<size_t>(i)];
    pos += static_cast<size_t>(ls);
    if (len == 0 || pos + len > n) return false;
    pos += len;
  }
  return true;
}

bool LengthPrefixedIsIdr(const uint8_t* d, size_t n, int ls) {
  size_t pos = 0;
  while (pos + static_cast<size_t>(ls) < n) {
    size_t len = 0;
    for (int i = 0; i < ls; ++i) len = (len << 8) | d[pos + static_cast<size_t>(i)];
    pos += static_cast<size_t>(ls);
    if (len == 0 || pos + len > n) return false;
    int t = HevcNalType(d[pos]);
    if (t <= 31) return t == 19 || t == 20;
    pos += len;
  }
  return false;
}

// ========== 封装 ==========

std::vector<uint8_t> BuildFlvHeader() {
  return {'F', 'L', 'V', 1, 0x01, 0, 0, 0, 9, 0, 0, 0, 0};
}

std::vector<uint8_t> BuildMetadataTag(double width, double height, double fps, HevcFlvFormat fmt) {
  auto amf_str = [](std::vector<uint8_t>& v, const std::string& s) {
    PutBe(v, static_cast<uint32_t>(s.size()), 2);
    v.insert(v.end(), s.begin(), s.end());
  };
  auto amf_num = [](std::vector<uint8_t>& v, double x) {
    v.push_back(0x00);
    uint64_t bits;
    std::memcpy(&bits, &x, sizeof(bits));
    for (int i = 7; i >= 0; --i) v.push_back(static_cast<uint8_t>((bits >> (8 * i)) & 0xFF));
  };
  std::vector<uint8_t> body = {0x02};
  amf_str(body, "onMetaData");
  body.push_back(0x08);
  PutBe(body, 4, 4);
  const double codec_id = fmt == HevcFlvFormat::kCodec12 ? 12.0 : static_cast<double>(kHvc1);
  for (auto& [k, v] : {std::pair<std::string, double>{"width", width}, {"height", height},
                       {"framerate", fps}, {"videocodecid", codec_id}}) {
    amf_str(body, k);
    amf_num(body, v);
  }
  body.insert(body.end(), {0x00, 0x00, 0x09});
  return WrapTag(kTagScript, 0, body);
}

std::vector<uint8_t> BuildVideoTag(HevcFlvFormat fmt, VideoPacket::Kind kind, bool keyframe,
                                   uint32_t dts_ms, int32_t cts_ms, const uint8_t* data, size_t n) {
  const uint8_t ft = (keyframe || kind != VideoPacket::Kind::kFrame) ? 1 : 2;
  std::vector<uint8_t> body;
  body.reserve(n + 8);
  auto put_cts = [&] { PutBe(body, static_cast<uint32_t>(cts_ms) & 0xFFFFFF, 3); };
  if (fmt == HevcFlvFormat::kCodec12) {
    body.push_back(static_cast<uint8_t>((ft << 4) | 12));
    body.push_back(kind == VideoPacket::Kind::kSequenceHeader ? 0
                   : kind == VideoPacket::Kind::kFrame        ? 1
                                                               : 2);
    put_cts();
  } else {
    uint8_t ptype = kind == VideoPacket::Kind::kSequenceHeader ? 0
                    : kind == VideoPacket::Kind::kEndOfSequence ? 2
                    : cts_ms != 0                               ? 1
                                                                : 3;
    body.push_back(static_cast<uint8_t>(0x80 | (ft << 4) | ptype));
    PutBe(body, kHvc1, 4);
    if (ptype == 1) put_cts();
  }
  if (kind != VideoPacket::Kind::kEndOfSequence && data) body.insert(body.end(), data, data + n);
  return WrapTag(kTagVideo, dts_ms, body);
}

}  // namespace ai_service::stream::flv
