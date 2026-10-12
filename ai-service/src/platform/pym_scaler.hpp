// Copyright AINVR. NV12 hardware downscale; host copies are explicit.
#pragma once
#include "vpu_decoder.hpp"
namespace ainvr {
class PymScaler {
 public:
  static bool Supports(int width,int height,int output_width,int output_height);
  PymScaler(int width,int height,int output_width,int output_height,int hardware_id=0);
  ~PymScaler();
  PymScaler(const PymScaler&)=delete;
  PymScaler& operator=(const PymScaler&)=delete;
  // Serialized per instance. A failed hardware operation poisons this instance;
  // construct a new one instead of matching stale queued output to new input.
  Nv12Frame Run(const Nv12Frame& input);
 private:
  struct State;
  std::unique_ptr<State> state_;
};
}
