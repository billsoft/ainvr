// AINVR. One HBM file, several programs sharing a single weight load (S100P).
// BpuModel opens one program per file handle; multi-profile HBMs (s1 + s256) would load
// their weights once per program and double the ION use. BpuPack loads the file once and
// BpuProgram instances borrow it. Float32 tensors only (quantization NONE), zero-copy
// into/out of the SDK buffers, same fault/quarantine rules as BpuModel.
#pragma once
#include <hobot/dnn/hb_dnn.h>
#include <hobot/hb_ucp.h>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace ainvr {

// Latch the process-wide fault (same latch as BpuModel); the watchdog restarts the service.
void BpuMarkRuntimeFault() noexcept;

class BpuPack {
 public:
  static std::shared_ptr<BpuPack> Load(const std::string& path);
  ~BpuPack();
  BpuPack(const BpuPack&) = delete;
  BpuPack& operator=(const BpuPack&) = delete;
  const std::vector<std::string>& ModelNames() const { return names_; }
  // After an unconfirmed task the SDK may still touch the weights: never release them.
  void Quarantine() noexcept { leaked_.store(true); }
  bool Leaked() const noexcept { return leaked_.load(); }
 private:
  BpuPack() = default;
  friend class BpuProgram;
  hbDNNPackedHandle_t packed_ = nullptr;
  std::vector<std::string> names_;
  std::atomic<bool> leaked_{false};
};

struct BpuTensorInfo {
  std::string name;
  std::vector<int64_t> shape, strides;
  int32_t dtype = 0;
  int64_t aligned_bytes = 0;
  int64_t Elements() const;
};

class BpuProgram {
 public:
  BpuProgram(std::shared_ptr<BpuPack> pack, const std::string& model_name);
  ~BpuProgram();
  BpuProgram(const BpuProgram&) = delete;
  BpuProgram& operator=(const BpuProgram&) = delete;
  const std::string& Name() const { return name_; }
  const std::vector<BpuTensorInfo>& Inputs() const { return input_info_; }
  const std::vector<BpuTensorInfo>& Outputs() const { return output_info_; }
  // `packed` is tightly packed row-major float32 with Elements() values.
  void SetInput(size_t index, const float* packed);
  void Run();
  void GetOutput(size_t index, float* packed) const;
  // Direct access for tensors whose byte strides are exactly row-major packed.
  bool InputPacked(size_t index) const;
  bool OutputPacked(size_t index) const;
  float* InputData(size_t index);
  void FlushInput(size_t index);
  const float* OutputData(size_t index) const;
 private:
  void Release() noexcept;
  std::shared_ptr<BpuPack> pack_;
  std::string name_;
  hbDNNHandle_t model_ = nullptr;
  std::vector<hbDNNTensor> inputs_, outputs_;
  std::vector<BpuTensorInfo> input_info_, output_info_;
  hbUCPTaskHandle_t inflight_ = nullptr;
  std::mutex mutex_;
};

}  // namespace ainvr
