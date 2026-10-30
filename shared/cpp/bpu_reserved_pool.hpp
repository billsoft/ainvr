#pragma once
#include <hb_mem_mgr.h>
#include <cstdint>
#include <stdexcept>

namespace ainvr {
// Size of the ION memory the BPU model loader and hbUCPMalloc draw from: the main pool plus the carveout. Measured on the
// 12 GiB layout: with default flags the allocator fills both (7680 + 4480 MiB), and a model loaded while the pool was full ran
// bit-identically from the carveout. The 128 MiB cma stays out of the budget, kernel drivers need it. Read from the SDK, so the
// number follows the device tree and nothing here caps it.
// Call only from an explicitly authorized hardware load path, not software contract tests. A successful query does not
// reserve or certify free space.
inline uint64_t ReadBpuIonBudgetBytes() {
  uint64_t pool = 0, carveout = 0;
  if (hb_mem_module_open() != 0) throw std::runtime_error("memory_module_unavailable");
  const int rc_pool = hb_mem_get_heap_size(HB_MEM_USAGE_PRIV_HEAP_2_RESERVED, &pool);
  const int rc_carveout = hb_mem_get_heap_size(HB_MEM_USAGE_PRIV_HEAP_RESERVED, &carveout);
  hb_mem_module_close();
  if (rc_pool != 0 || rc_carveout != 0 || pool == 0) throw std::runtime_error("memory_pool_unknown");
  return pool + carveout;
}
}  // namespace ainvr
