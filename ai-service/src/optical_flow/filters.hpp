// Copyright AINVR. Hardware-only median and Gaussian spatial filtering.
#pragma once
#include <memory>
#include <vector>
namespace ainvr::flow {
class Filters {
 public:
  Filters();~Filters();
  std::vector<float> Median(const std::vector<float>& bgr);
  std::vector<float> Gaussian(const std::vector<float>& flow);
 private:
  std::vector<float> Run(const std::vector<float>& values,int channels,bool median);
  struct State;std::unique_ptr<State> state_;
};
}
