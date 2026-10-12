// OpenSSL 3.0 薄封装：SHA-256 / HMAC-SHA256 / HKDF / AES-256-GCM。
#pragma once

#include <array>
#include <string>
#include <string_view>
#include <vector>

namespace ainvr_license {

using Key32 = std::array<unsigned char, 32>;

std::vector<unsigned char> Sha256(const unsigned char* data, size_t len);
std::vector<unsigned char> Sha256(std::string_view s);

std::vector<unsigned char> HmacSha256(const Key32& key,
                                      const unsigned char* data, size_t len);
std::vector<unsigned char> HmacSha256(const Key32& key, std::string_view s);
std::string HmacSha256Hex(const Key32& key, std::string_view s);

// RFC 5869 HKDF-Expand（单块，L<=32 足够本工程使用），内部先做 Extract。
Key32 Hkdf(const Key32& ikm, std::string_view salt, std::string_view info);

// AES-256-GCM。Seal 返回 ciphertext||tag(16B)；Open 输入同样布局，
// 认证失败抛 std::runtime_error（调用方映射为 LICENSE_INVALID_KEY）。
std::vector<unsigned char> AesGcmSeal(const Key32& key,
                                      const unsigned char iv[12],
                                      std::string_view plaintext,
                                      std::string_view aad);
std::vector<unsigned char> AesGcmOpen(const Key32& key,
                                      const unsigned char iv[12],
                                      const unsigned char* blob, size_t blob_len,
                                      std::string_view aad);

}  // namespace ainvr_license
