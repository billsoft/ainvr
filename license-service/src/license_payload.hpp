#pragma once
#include <cstdint>
#include <string>
namespace ainvr_license {
inline constexpr int64_t kMaxMinutes = 5256000;
inline constexpr int64_t kMaxSequence = 9007199254740991LL;
struct LicensePayload {
  int v=3;
  std::string fp,license_id;
  int64_t grant_seq=0,ttl_min=0,issued_at=0;
};
}
