// Copyright AINVR. Text and RepRTA neural networks execute native HBM on BPU.
#pragma once
#include "bpu.hpp"
#include <array>
namespace ainvr {
struct BpuPromptResources {
  std::string text_hbm,reprta_hbm,tokenizer_python,tokenizer_helper,tokenizer_assets;
};
class BpuPromptEngine {
 public:
  explicit BpuPromptEngine(BpuPromptResources resources);
  static void ValidatePhrases(const BpuPromptResources& resources,
                              const std::vector<std::string>& phrases);
  // Returns 8 or 32 final prompt slots; unused slots are zero after RepRTA.
  std::vector<float> Encode(const std::vector<std::string>& phrases, size_t slots=8);
 private:
  BpuPromptResources resources_;
  BpuModel text_,reprta_;
  nlohmann::json text_description_,reprta_description_;
};
}
