// Copyright AINVR. Explicit CPU fallback; never reports a BPU provider.
#pragma once
#include "adapters/detection_decode.hpp"
#include <memory>
namespace ainvr {
class OnnxModel {
 public:
  explicit OnnxModel(const std::string& path,int threads=2);
  ~OnnxModel();
  OnnxModel(const OnnxModel&)=delete;
  OnnxModel& operator=(const OnnxModel&)=delete;
  std::vector<int64_t> InputShape() const;
  std::vector<DenseTensor> Run(const std::vector<float>& input);
 private:
  struct State;std::unique_ptr<State> state_;
};
}
