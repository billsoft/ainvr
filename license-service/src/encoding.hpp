// 编码工具：hex / base64url / Crockford Base32 / 随机数。
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace ainvr_license {

std::string HexEncode(const unsigned char* data, size_t len);
std::string HexEncode(const std::vector<unsigned char>& data);
template <size_t N>
std::string HexEncode(const std::array<unsigned char, N>& a) {
  return HexEncode(a.data(), N);
}
std::optional<std::vector<unsigned char>> HexDecode(std::string_view s);

// 无填充的 URL-safe base64（注册密钥在线传输用）。
std::string B64UrlEncode(const unsigned char* data, size_t len);
std::string B64UrlEncode(const std::vector<unsigned char>& data);
std::optional<std::vector<unsigned char>> B64UrlDecode(std::string_view s);

// Crockford Base32：字母表 0123456789ABCDEFGHJKMNPQRSTVWXYZ（无 I/L/O/U）。
// 申请码专用；输入字节数不要求整 5，输出按 ceil(n*8/5) 截断。
std::string CrockfordEncode(const unsigned char* data, size_t len);
// 规整用户输入：去空白与连字符、大写、O→0、I/L→1。
std::string CrockfordNormalize(std::string_view s);

// 申请码分组展示：每 4 个字符一组，'-' 连接。
std::string GroupCode(std::string_view normalized);

std::vector<unsigned char> RandomBytes(size_t n);

}  // namespace ainvr_license
