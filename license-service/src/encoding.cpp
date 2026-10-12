#include "encoding.hpp"

#include <openssl/rand.h>

#include <array>
#include <cctype>
#include <stdexcept>

namespace ainvr_license {

namespace {
constexpr char kHex[] = "0123456789abcdef";
constexpr char kB64Url[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
constexpr char kCrockford[] = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

int HexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
}  // namespace

std::string HexEncode(const unsigned char* data, size_t len) {
  std::string out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; ++i) {
    out.push_back(kHex[data[i] >> 4]);
    out.push_back(kHex[data[i] & 0xF]);
  }
  return out;
}

std::string HexEncode(const std::vector<unsigned char>& data) {
  return HexEncode(data.data(), data.size());
}

std::optional<std::vector<unsigned char>> HexDecode(std::string_view s) {
  if (s.size() % 2 != 0) return std::nullopt;
  std::vector<unsigned char> out;
  out.reserve(s.size() / 2);
  for (size_t i = 0; i < s.size(); i += 2) {
    int hi = HexVal(s[i]);
    int lo = HexVal(s[i + 1]);
    if (hi < 0 || lo < 0) return std::nullopt;
    out.push_back(static_cast<unsigned char>((hi << 4) | lo));
  }
  return out;
}

std::string B64UrlEncode(const unsigned char* data, size_t len) {
  std::string out;
  int val = 0, bits = 0;
  for (size_t i = 0; i < len; ++i) {
    val = (val << 8) | data[i];
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out.push_back(kB64Url[(val >> bits) & 0x3F]);
    }
  }
  if (bits > 0) {
    out.push_back(kB64Url[(val << (6 - bits)) & 0x3F]);
  }
  return out;
}

std::string B64UrlEncode(const std::vector<unsigned char>& data) {
  return B64UrlEncode(data.data(), data.size());
}

std::optional<std::vector<unsigned char>> B64UrlDecode(std::string_view s) {
  std::array<int, 256> tab;
  tab.fill(-1);
  for (int i = 0; i < 64; ++i) tab[static_cast<unsigned char>(kB64Url[i])] = i;
  std::vector<unsigned char> out;
  int val = 0, bits = 0;
  for (char c : s) {
    int v = tab[static_cast<unsigned char>(c)];
    if (v < 0) return std::nullopt;
    val = (val << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push_back(static_cast<unsigned char>((val >> bits) & 0xFF));
    }
  }
  return out;
}

std::string CrockfordEncode(const unsigned char* data, size_t len) {
  std::string out;
  int val = 0, bits = 0;
  for (size_t i = 0; i < len; ++i) {
    val = (val << 8) | data[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push_back(kCrockford[(val >> bits) & 0x1F]);
    }
  }
  if (bits > 0) {
    out.push_back(kCrockford[(val << (5 - bits)) & 0x1F]);
  }
  return out;
}

std::string CrockfordNormalize(std::string_view s) {
  std::string out;
  out.reserve(s.size());
  for (char c : s) {
    if (c == '-' || c == ' ' || c == '\t' || c == '\n' || c == '\r') continue;
    char u = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    if (u == 'O') u = '0';
    if (u == 'I' || u == 'L') u = '1';
    out.push_back(u);
  }
  return out;
}

std::string GroupCode(std::string_view normalized) {
  std::string out;
  for (size_t i = 0; i < normalized.size(); i += 4) {
    if (!out.empty()) out.push_back('-');
    out.append(normalized.substr(i, 4));
  }
  return out;
}

std::vector<unsigned char> RandomBytes(size_t n) {
  std::vector<unsigned char> out(n);
  if (RAND_bytes(out.data(), static_cast<int>(n)) != 1) {
    throw std::runtime_error("RAND_bytes 失败");
  }
  return out;
}

}  // namespace ainvr_license
