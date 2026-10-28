#pragma once
#include <hb_mem_mgr.h>
#include <cstdint>
#include <stdexcept>

namespace ainvr {
// Existing Qwen pool query, shared without debugfs or a free-memory estimate.
// Call only from an explicitly authorized hardware load path, not software
// contract tests. A successful query does not reserve or certify free space.
inline uint64_t ReadBpuReservedPoolBytes() {
  uint64_t total = 0;
  if (hb_mem_module_open() != 0) throw std::runtime_error("memory_module_unavailable");
  const int rc = hb_mem_get_heap_size(HB_MEM_USAGE_PRIV_HEAP_2_RESERVED, &total);
  hb_mem_module_close();
  if (rc != 0 || total == 0) throw std::runtime_error("memory_pool_unknown");
  return total;
}
}  // namespace ainvr
