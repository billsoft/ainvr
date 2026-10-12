// sei.cpp 的单测,分两块:
// 1) escape/unescape/find_annexb_nals/inject_sei_annexb —— 手写用例,
//    纯字节操作逻辑,风险相对小。
// 2) build_result_payload/build_sei_nal/parse_sei_nal —— 对拍
//    sei_fixtures.json(真实 Python 实现跑出来的输出),逐字节比对。这是
//    和浏览器端 Encoded Transform 解码器的线上契约,必须字节级对齐,不是
//    普通单测,任何一个 case 失配都说明 C++ 移植偏离了 Python 的真实行为。
#include <gtest/gtest.h>

#include <fstream>
#include <nlohmann/json.hpp>

#include "../../src/stream/sei.hpp"

using ai_service::Detection;
namespace sei = ai_service::sei;

namespace {

std::string bytes_to_hex(const std::vector<uint8_t>& b) {
  static const char* kHexDigits = "0123456789abcdef";
  std::string s;
  s.reserve(b.size() * 2);
  for (uint8_t c : b) {
    s.push_back(kHexDigits[c >> 4]);
    s.push_back(kHexDigits[c & 0x0F]);
  }
  return s;
}

nlohmann::json load_fixtures() {
  std::ifstream f(SEI_FIXTURES_PATH);
  if (!f) {
    ADD_FAILURE() << "无法打开 fixture 文件: " << SEI_FIXTURES_PATH;
    return {};
  }
  nlohmann::json j;
  f >> j;
  return j;
}

Detection parse_detection(const nlohmann::json& jd) {
  Detection d;
  d.class_id = jd.at("class_id").get<int>();
  d.class_name = jd.at("class_name").get<std::string>();
  d.confidence = jd.at("confidence").get<double>();
  auto bbox = jd.at("bbox");
  for (int i = 0; i < 4; ++i) d.bbox[i] = bbox.at(i).get<double>();
  if (!jd.at("landmarks").is_null()) {
    std::vector<std::array<double, 2>> lm;
    for (auto& p : jd.at("landmarks")) {
      lm.push_back({p.at(0).get<double>(), p.at(1).get<double>()});
    }
    d.landmarks = std::move(lm);
  }
  return d;
}

}  // namespace

// ========== 1. 手写用例:字节操作逻辑 ==========

TEST(SeiEscape, RoundtripWithEmulationBytes) {
  std::vector<uint8_t> rbsp = {0x05, 0x01, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03,
                                0xAB, 0x00, 0x00, 0x02, 0xFF};
  auto escaped = sei::escape_emulation(rbsp);
  // 期望值经真实 Python sei.escape_emulation() 对同一输入跑出来核对过
  // (05 01 00 00 00 01 02 03 ab 00 00 02 ff -> 050100000300010203ab00000302ff),
  // 不是手推的 —— 手推曾经推错一次,靠 Python 现场核对揪出来。
  std::vector<uint8_t> expect = {0x05, 0x01, 0x00, 0x00, 0x03, 0x00, 0x01, 0x02,
                                  0x03, 0xAB, 0x00, 0x00, 0x03, 0x02, 0xFF};
  EXPECT_EQ(escaped, expect);
  EXPECT_EQ(sei::unescape_emulation(escaped), rbsp);
}

TEST(SeiEscape, NoEmulationBytesUnchanged) {
  std::vector<uint8_t> rbsp = {0x05, 0x10, 0x20, 0x30, 0x00, 0x40};
  auto escaped = sei::escape_emulation(rbsp);
  EXPECT_EQ(escaped, rbsp);
}

TEST(SeiAnnexB, FindNalsWith3And4ByteStartCodes) {
  std::vector<uint8_t> data = {
      0x00, 0x00, 0x00, 0x01, 0x67, 0xAA,        // 4字节起始码 + SPS(type=7&0x1F... 这里随便填)
      0x00, 0x00, 0x01, 0x65, 0xBB, 0xCC,        // 3字节起始码 + IDR slice(type=5)
  };
  auto nals = sei::find_annexb_nals(data);
  ASSERT_EQ(nals.size(), 2u);
  EXPECT_EQ(nals[0].first, 4u);
  EXPECT_EQ(nals[0].second, 4);
  EXPECT_EQ(nals[1].first, 9u);
  EXPECT_EQ(nals[1].second, 3);
}

TEST(SeiAnnexB, InjectBeforeFirstVclNal) {
  std::vector<uint8_t> au = {
      0x00, 0x00, 0x00, 0x01, 0x67, 0xAA,  // SPS (type 7, 非 VCL)
      0x00, 0x00, 0x01, 0x65, 0xBB, 0xCC,  // IDR slice (type 5, VCL)
  };
  std::vector<uint8_t> sei_nal = {0x06, 0x05, 0x02, 0xDE, 0xAD, 0x80};
  auto out = sei::inject_sei_annexb(au, sei_nal);

  // 期望:SPS 原样保留,SEI(带 4 字节起始码)插在 IDR 的起始码之前
  std::vector<uint8_t> expect = {
      0x00, 0x00, 0x00, 0x01, 0x67, 0xAA,
      0x00, 0x00, 0x00, 0x01,              // 注入用的 4 字节起始码
      0x06, 0x05, 0x02, 0xDE, 0xAD, 0x80,  // sei_nal
      0x00, 0x00, 0x01, 0x65, 0xBB, 0xCC,  // 原 IDR slice(起始码原样保留)
  };
  EXPECT_EQ(out, expect);
}

TEST(SeiAnnexB, NoVclNalReturnsUnchanged) {
  std::vector<uint8_t> au = {0x00, 0x00, 0x00, 0x01, 0x67, 0xAA};  // 只有 SPS
  auto out = sei::inject_sei_annexb(au, {0x06, 0x05});
  EXPECT_EQ(out, au);
}

// ========== 2. 对拍真实 Python 输出的字节级回归 ==========

TEST(SeiFixtures, UuidMatchesPython) {
  auto fixtures = load_fixtures();
  std::vector<uint8_t> uuid_vec(sei::SEI_UUID.begin(), sei::SEI_UUID.end());
  EXPECT_EQ(bytes_to_hex(uuid_vec), fixtures.at("sei_uuid_hex").get<std::string>());
  EXPECT_EQ(sei::SEI_PAYLOAD_TYPE, fixtures.at("sei_payload_type").get<int>());
  EXPECT_EQ(sei::SEI_PAYLOAD_BUDGET, fixtures.at("default_budget").get<int>());
}

TEST(SeiFixtures, AllCasesByteExactMatch) {
  auto fixtures = load_fixtures();
  for (auto& c : fixtures.at("cases")) {
    std::string name = c.at("name").get<std::string>();
    SCOPED_TRACE(name);
    auto& input = c.at("input");

    std::vector<Detection> dets;
    for (auto& jd : input.at("detections")) dets.push_back(parse_detection(jd));
    // Legacy Python omitted zero-target inference. The explicit-empty contract
    // is tested separately below; retain byte parity for nonempty detections.
    if (dets.empty()) continue;

    if (c.contains("expect_exception")) {
      auto expect = c.at("expect_exception");
      bool should_raise = expect.at("raised").get<bool>();
      bool threw = false;
      std::string msg;
      try {
        sei::build_result_payload(input.at("channel_id").get<std::string>(),
                                   input.at("pts_ns").get<int64_t>(),
                                   input.at("age_ms").get<double>(), dets,
                                   input.at("budget").get<int>());
      } catch (const std::runtime_error& e) {
        threw = true;
        msg = e.what();
      }
      EXPECT_EQ(threw, should_raise);
      if (should_raise) {
        EXPECT_EQ(msg, expect.at("message").get<std::string>());
      }
      continue;
    }

    auto payload = sei::build_result_payload(
        input.at("channel_id").get<std::string>(), input.at("pts_ns").get<int64_t>(),
        input.at("age_ms").get<double>(), dets, input.at("budget").get<int>());

    EXPECT_EQ(payload.size(), c.at("payload_len").get<size_t>());
    EXPECT_EQ(bytes_to_hex(payload), c.at("payload_hex").get<std::string>());

    std::vector<uint8_t> nal;
    if (!payload.empty()) nal = sei::build_sei_nal(payload);
    EXPECT_EQ(nal.size(), c.at("nal_len").get<size_t>());
    EXPECT_EQ(bytes_to_hex(nal), c.at("nal_hex").get<std::string>());

    if (!nal.empty()) {
      auto parsed = sei::parse_sei_nal(nal);
      ASSERT_EQ(parsed.size(), 1u);
      EXPECT_EQ(parsed[0].first, sei::SEI_PAYLOAD_TYPE);
      std::vector<uint8_t> expect_inner(sei::SEI_UUID.begin(), sei::SEI_UUID.end());
      expect_inner.insert(expect_inner.end(), payload.begin(), payload.end());
      EXPECT_EQ(parsed[0].second, expect_inner)
          << "parse_sei_nal 往返不等于原 payload(说明 roundtrip 有问题)";
    }
  }
}

// v1 用真值判断 `if d.landmarks:`,空列表同样省略 "k";API(ToDict)与 Mongo
// 文档也都是"空即当作没有",SEI 必须同一规则。
TEST(SeiPayload, EmptyLandmarksOmitsKey) {
  Detection d;
  d.class_id = 0;
  d.class_name = "face";
  d.confidence = 0.9;
  d.bbox = {1, 2, 3, 4};
  d.landmarks = std::vector<std::array<double, 2>>{};
  auto payload = sei::build_result_payload("ch", 1, 0.0, {d}, 1024);
  std::string s(payload.begin(), payload.end());
  EXPECT_EQ(s.find("\"k\""), std::string::npos) << s;
}

TEST(SeiPayload, EmptyInferenceIsExplicitButBudgetLossIsNotEmptyInference) {
  const auto empty = sei::build_result_payload("ch", 123, 0.0, {}, 1024);
  ASSERT_FALSE(empty.empty());
  auto parsed = nlohmann::json::parse(empty);
  EXPECT_EQ(parsed.at("pts"), 123);
  EXPECT_TRUE(parsed.at("det").empty());
  Detection d; d.class_name = std::string(200, 'x'); d.bbox = {1, 2, 3, 4};
  EXPECT_TRUE(sei::build_result_payload("ch", 123, 0.0, {d}, 100).empty());
  EXPECT_THROW(sei::build_result_payload("ch", 123, 0.0, {}, 1), std::runtime_error);
}
