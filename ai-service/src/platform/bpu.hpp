// Copyright AINVR. S100P native HBM execution; no CUDA or OpenCV dependency.
#pragma once
#include <hobot/dnn/hb_dnn.h>
#include <hobot/hb_ucp.h>
#include <nlohmann/json.hpp>
#include <mutex>
#include <string>
#include <vector>

namespace ainvr {
class BpuModel {
 public:
  explicit BpuModel(const std::string& path, const std::string& name = "");
  ~BpuModel();
  BpuModel(const BpuModel&) = delete;
  BpuModel& operator=(const BpuModel&) = delete;
  nlohmann::json Describe() const;
  // Inputs/outputs use SDK aligned storage, not packed host tensors. Callers
  // must honor the reported shape, dtype and byte strides. All inputs required.
  std::vector<std::vector<unsigned char>> Run(
      const std::vector<std::vector<unsigned char>>& inputs);
 private:
  void Clear() noexcept;
  hbDNNPackedHandle_t packed_ = nullptr;
  hbDNNHandle_t model_ = nullptr;
  std::string name_;
  std::vector<hbDNNTensor> inputs_, outputs_;
  std::vector<std::string> input_names_, output_names_;
  std::mutex mutex_;
};
}
