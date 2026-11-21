// Copyright AINVR. Hardware-only median and Gaussian spatial filtering.
#pragma once
#include <memory>
#include <cstdint>
#include <cstddef>
#include <vector>
namespace ainvr::flow {
class Filters {
 public:
  Filters();~Filters();
  std::vector<float> Median(const std::vector<float>& bgr);
  std::vector<float> Gaussian(const std::vector<float>& flow);
  // Two planes of 32 rank comparisons over a 9x9 green-channel patch.
  std::vector<uint32_t> SceneDescriptors(const std::vector<float>& bgr);
 private:
  void Dispatch(const std::vector<float>& values,int planes,int operation,void* output,size_t bytes);
  struct State;std::unique_ptr<State> state_;
};
}
