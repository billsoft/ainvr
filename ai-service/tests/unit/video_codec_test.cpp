// video_codec 与 SEI 的 H.265 支持:NAL 规则、IDR 判定、前缀 SEI(类型 39)构造/解析/注入。
#include <gtest/gtest.h>

#include "../../src/stream/sei.hpp"
#include "../../src/stream/video_codec.hpp"

using namespace ai_service::stream;
namespace sei = ai_service::sei;

namespace {

std::vector<uint8_t> Nal265(int type, size_t size, uint8_t fill = 0x55) {
  std::vector<uint8_t> v = {0, 0, 0, 1, static_cast<uint8_t>(type << 1), 1};
  v.insert(v.end(), size, fill);
  return v;
}

std::vector<uint8_t> Cat(std::initializer_list<std::vector<uint8_t>> parts) {
  std::vector<uint8_t> out;
  for (auto& p : parts) out.insert(out.end(), p.begin(), p.end());
  return out;
}

}  // namespace

TEST(VideoCodec, ParsesSrsCodecNamesLeniently) {
  EXPECT_EQ(ParseCodecName("H264"), VideoCodec::kH264);
  EXPECT_EQ(ParseCodecName("HEVC"), VideoCodec::kH265);  // SRS 7 实测值
  EXPECT_EQ(ParseCodecName("h.265"), VideoCodec::kH265);
  EXPECT_EQ(ParseCodecName("H-265"), VideoCodec::kH265);
  EXPECT_FALSE(ParseCodecName("").has_value());
  EXPECT_FALSE(ParseCodecName("VP9").has_value());
  EXPECT_STREQ(CodecName(VideoCodec::kH265), "h265");
}

TEST(VideoCodec, NalRulesDifferPerCodec) {
  EXPECT_EQ(NalType(VideoCodec::kH264, 0x65), 5);
  EXPECT_EQ(NalType(VideoCodec::kH265, 0x26), 19);  // IDR_W_RADL
  EXPECT_EQ(NalHeaderSize(VideoCodec::kH265), 2u);
  EXPECT_TRUE(IsVcl(VideoCodec::kH265, 0));
  EXPECT_FALSE(IsVcl(VideoCodec::kH265, 39));  // 前缀 SEI
  EXPECT_TRUE(IsIdr(VideoCodec::kH265, 19));
  EXPECT_TRUE(IsIdr(VideoCodec::kH265, 20));
  EXPECT_FALSE(IsIdr(VideoCodec::kH265, 21));  // CRA 不是安全切点
  EXPECT_TRUE(IsIdr(VideoCodec::kH264, 5));
}

TEST(VideoCodec, AnnexBAuIdrLooksAtFirstVclOnly) {
  auto idr = Cat({Nal265(35, 1), Nal265(32, 20), Nal265(33, 30), Nal265(34, 6), Nal265(39, 40), Nal265(19, 50)});
  auto cra = Cat({Nal265(32, 20), Nal265(21, 50)});
  auto trail = Cat({Nal265(39, 40), Nal265(1, 50)});
  EXPECT_TRUE(AnnexBAuIsIdr(VideoCodec::kH265, idr));
  EXPECT_FALSE(AnnexBAuIsIdr(VideoCodec::kH265, cra));
  EXPECT_FALSE(AnnexBAuIsIdr(VideoCodec::kH265, trail));
  std::vector<uint8_t> h264_idr = {0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x65, 9, 9};
  EXPECT_TRUE(AnnexBAuIsIdr(VideoCodec::kH264, h264_idr));
}

TEST(SeiHevc, BuildsPrefixSeiType39WithTwoByteHeader) {
  std::vector<uint8_t> user = {'{', '}'};
  auto nal = sei::build_sei_nal(user, VideoCodec::kH265);
  ASSERT_GE(nal.size(), 3u);
  EXPECT_EQ(nal[0], 0x4E);  // type 39 << 1
  EXPECT_EQ(nal[1], 0x01);  // layer 0, tid+1 = 1
  // H.264 默认行为不变:1 字节头 0x06
  EXPECT_EQ(sei::build_sei_nal(user)[0], 0x06);
  // 载荷(UUID+用户数据)在两种编码下完全一致:浏览器按 UUID 扫描,不用改
  auto h264 = sei::build_sei_nal(user);
  EXPECT_TRUE(std::equal(h264.begin() + 1, h264.end(), nal.begin() + 2, nal.end()));
}

TEST(SeiHevc, ParseRoundTripsAndRejectsWrongType) {
  std::vector<uint8_t> user = {'{', '"', 'v', '"', ':', '1', '}'};
  auto nal = sei::build_sei_nal(user, VideoCodec::kH265);
  auto msgs = sei::parse_sei_nal(nal, VideoCodec::kH265);
  ASSERT_EQ(msgs.size(), 1u);
  EXPECT_EQ(msgs[0].first, 5);
  std::vector<uint8_t> expect(sei::SEI_UUID);
  expect.insert(expect.end(), user.begin(), user.end());
  EXPECT_EQ(msgs[0].second, expect);
  std::vector<uint8_t> vcl = {0x26, 0x01, 0xAA};
  EXPECT_THROW(sei::parse_sei_nal(vcl, VideoCodec::kH265), std::invalid_argument);
}

TEST(SeiHevc, InjectsBeforeFirstVclAfterParameterSets) {
  auto au = Cat({Nal265(35, 1), Nal265(32, 20), Nal265(33, 30), Nal265(34, 6), Nal265(19, 50)});
  auto sei_nal = sei::build_sei_nal({'{', '}'}, VideoCodec::kH265);
  auto out = sei::inject_sei_annexb(au, sei_nal, VideoCodec::kH265);
  ASSERT_EQ(out.size(), au.size() + 4 + sei_nal.size());
  auto nals = sei::find_annexb_nals(out);
  std::vector<int> types;
  for (auto& [off, sc] : nals) types.push_back(NalType(VideoCodec::kH265, out[off]));
  EXPECT_EQ(types, (std::vector<int>{35, 32, 33, 34, 39, 19}));
}

TEST(SeiHevc, NoVclReturnsUnchanged) {
  auto au = Cat({Nal265(32, 20), Nal265(33, 30)});
  EXPECT_EQ(sei::inject_sei_annexb(au, sei::build_sei_nal({'x'}, VideoCodec::kH265), VideoCodec::kH265), au);
}
