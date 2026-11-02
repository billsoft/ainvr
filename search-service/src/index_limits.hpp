#pragma once
#include <cstdint>
namespace ainvr::search {
// Exact in-memory projection ceiling (floats). 2048-d vectors: 62,500 samples = 512 MB.
inline constexpr uint64_t kMaxIndexFloats = 128000000ULL;
}  // namespace ainvr::search
