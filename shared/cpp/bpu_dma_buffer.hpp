#pragma once
#include <hobot/hb_ucp.h>
#include <cstddef>
#include <stdexcept>
#include <string>

namespace ainvr {
// Existing Qwen cached-DMA RAII, shared with the search load-time headroom
// probe. This allocates actual SDK memory; it is never invoked by software-only
// contract tests and is not a free-memory measurement or future-capacity claim.
struct BpuDmaBuffer {
  hbUCPSysMem memory{};
  explicit BpuDmaBuffer(size_t bytes) {
    const int rc = hbUCPMallocCached(&memory, bytes, 0);
    if (rc) throw std::runtime_error("allocate DMA: " + std::to_string(rc));
  }
  ~BpuDmaBuffer() { if (memory.virAddr) hbUCPFree(&memory); }
  BpuDmaBuffer(const BpuDmaBuffer&) = delete;
  BpuDmaBuffer& operator=(const BpuDmaBuffer&) = delete;
};
}  // namespace ainvr
