#pragma once
#include <hobot/dnn/hb_dnn.h>
#include <hobot/hb_ucp.h>
#include <nlohmann/json.hpp>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace ainvr::llm {
struct DmaBuffer {
  hbUCPSysMem memory{};
  explicit DmaBuffer(size_t bytes);
  ~DmaBuffer();
  DmaBuffer(const DmaBuffer&) = delete;
  DmaBuffer& operator=(const DmaBuffer&) = delete;
};
struct Tensor {
  hbDNNTensor descriptor{};
  std::shared_ptr<DmaBuffer> buffer;
  std::string name;
  size_t elements() const;
  void Write(const float* data, size_t elements);
  std::vector<float> Read() const;
};
// Cache only explicitly named inputs with identical byte size and layout.
using BufferPool = std::map<std::string, std::shared_ptr<DmaBuffer>>;
extern thread_local std::function<void(double)> task_time_observer;
class BpuProgram {
 public:
  BpuProgram(const std::string& file, const nlohmann::json& profiles,
             const std::string& root, BufferPool& pool);
  ~BpuProgram();
  BpuProgram(const BpuProgram&) = delete;
  BpuProgram& operator=(const BpuProgram&) = delete;
  std::vector<std::vector<float>> Run(const std::string& profile,
                                     const std::vector<std::vector<float>>& values,
                                     const std::function<void()>& before_submit = {});
 private:
  struct Profile { hbDNNHandle_t model{}; std::vector<Tensor> inputs, outputs; };
  hbDNNPackedHandle_t packed_{};
  std::map<std::string, Profile> profiles_;
};
} // namespace ainvr::llm
