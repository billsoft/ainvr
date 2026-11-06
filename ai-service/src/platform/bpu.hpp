// Copyright AINVR. S100P native HBM execution; no CUDA or OpenCV dependency.
#pragma once
#include <hobot/dnn/hb_dnn.h>
#include <hobot/hb_ucp.h>
#include <nlohmann/json.hpp>
#include <mutex>
#include "shared_runtime.hpp"
#include "configured_residency.hpp"
#include <memory>
#include <string>
#include <vector>

namespace ainvr {
// Failed waits latch a process fault; the watchdog must restart the service.
bool BpuRuntimeHealthy() noexcept;
// Latch the process-wide fault (same latch as failed BpuModel waits).
void BpuMarkRuntimeFault() noexcept;
uint64_t BpuQuarantinedBytes() noexcept;
class BpuModel {
 public:
  static std::shared_ptr<BpuModel> Acquire(const std::string& path, const std::string& name = "");
  static nlohmann::json SharedStatus();
  uint64_t ActiveAndWaitingCalls(){return mutex_.Waiting();}
  using Demand = ConfiguredResidency<BpuModel>::Demand;
  static std::string ResidencyKey(const std::string& path, const std::string& name = "");
  static void ConfigureResidency(Demand demand);
  ~BpuModel();
  BpuModel(const BpuModel&) = delete;
  BpuModel& operator=(const BpuModel&) = delete;
  nlohmann::json Describe() const;
  // Inputs/outputs use SDK aligned storage, not packed host tensors. Callers
  // must honor the reported shape, dtype and byte strides. All inputs required.
  std::vector<std::vector<unsigned char>> Run(
      const std::vector<std::vector<unsigned char>>& inputs);
 private:
  explicit BpuModel(const std::string& path, const std::string& name = "");
  void Clear() noexcept;
  struct Quarantine;
  std::unique_ptr<Quarantine> quarantine_;
  hbUCPTaskHandle_t inflight_ = nullptr;
  hbDNNPackedHandle_t packed_ = nullptr;
  hbDNNHandle_t model_ = nullptr;
  std::string name_;
  std::vector<hbDNNTensor> inputs_, outputs_;
  std::vector<std::string> input_names_, output_names_;
  FifoMutex mutex_;
};
}
