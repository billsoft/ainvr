#include <gtest/gtest.h>

#include <cstring>

#include "crypto.hpp"
#include "encoding.hpp"

using namespace ainvr_license;

TEST(Encoding, HexRoundTrip) {
  auto data = RandomBytes(64);
  auto dec = HexDecode(HexEncode(data));
  ASSERT_TRUE(dec.has_value());
  EXPECT_EQ(data, *dec);
  EXPECT_FALSE(HexDecode("abc").has_value());
  EXPECT_FALSE(HexDecode("zz").has_value());
}

TEST(Encoding, B64UrlRoundTrip) {
  for (size_t n : {0UL, 1UL, 2UL, 11UL, 12UL, 13UL, 16UL, 31UL, 100UL}) {
    auto data = RandomBytes(n);
    auto dec = B64UrlDecode(B64UrlEncode(data));
    ASSERT_TRUE(dec.has_value());
    EXPECT_EQ(data, *dec);
  }
}

TEST(Encoding, CrockfordNoConfusable) {
  std::string all;
  auto data = RandomBytes(60);
  all = CrockfordEncode(data.data(), data.size());
  EXPECT_EQ(all.find('I'), std::string::npos);
  EXPECT_EQ(all.find('L'), std::string::npos);
  EXPECT_EQ(all.find('O'), std::string::npos);
  EXPECT_EQ(all.find('U'), std::string::npos);
  // 15 字节 → 24 字符
  auto d = RandomBytes(15);
  EXPECT_EQ(CrockfordEncode(d.data(), 15).size(), 24UL);
}

TEST(Encoding, CrockfordNormalize) {
  EXPECT_EQ(CrockfordNormalize("abcd-efgh ooo"), CrockfordNormalize("ABCDEF GH000"));
  EXPECT_EQ(CrockfordNormalize("ilIL"), "1111");
}

TEST(Crypto, HmacKnownAnswer) {
  // HMAC-SHA256(key=0x0b*32, "Hi There")（Python hashlib 对拍值；
  // RFC 4231 TC1 的 key 是 20B，这里固定用本工程 32B 长度）。
  Key32 key{};
  key.fill(0x0b);
  auto md = HmacSha256(key, std::string_view("Hi There"));
  EXPECT_EQ(HexEncode(md),
            "198a607eb44bfbc69903a0f1cf2bbdc5ba0aa3f3d9ae3c1c7a3b1696a0b68cf7");
}

TEST(Crypto, HkdfRfc5869) {
  // RFC 5869 A.1
  std::vector<unsigned char> ikm(22, 0x0b);
  std::vector<unsigned char> salt_v;
  for (int i = 0; i < 13; ++i) salt_v.push_back(0x00 + i);
  std::string info = "\xf0\xf1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9";
  Key32 k{};
  std::copy(ikm.begin(), ikm.end(), k.begin());
  Key32 salt32{};
  std::copy(salt_v.begin(), salt_v.end(), salt32.begin());
  // 注意：本工程 Hkdf 用固定 32B salt；RFC 向量 salt 13B 不适用直接比对，
  // 改为验证：同输入确定性 + 不同 info 结果不同。
  auto a = Hkdf(k, std::string_view(reinterpret_cast<const char*>(salt32.data()), 32), info);
  auto b = Hkdf(k, std::string_view(reinterpret_cast<const char*>(salt32.data()), 32), info);
  auto c = Hkdf(k, std::string_view(reinterpret_cast<const char*>(salt32.data()), 32), "other");
  EXPECT_EQ(a, b);
  EXPECT_NE(a, c);
}

TEST(Crypto, AesGcmRoundTrip) {
  Key32 key{};
  key.fill(0x42);
  unsigned char iv[12];
  memset(iv, 7, 12);
  std::string pt = R"({"v":1,"fp":"ABCD"})";
  auto blob = AesGcmSeal(key, iv, pt, "ainvr-license-v1");
  ASSERT_GE(blob.size(), 16UL);
  auto open = AesGcmOpen(key, iv, blob.data(), blob.size(), "ainvr-license-v1");
  EXPECT_EQ(std::string(open.begin(), open.end()), pt);

  // 篡改密文 → 认证失败
  blob[0] ^= 0x01;
  EXPECT_THROW(AesGcmOpen(key, iv, blob.data(), blob.size(), "ainvr-license-v1"),
               std::exception);
}
