// Copyright AINVR. Hardware image adapter; channel business stays in the reused worker.
#pragma once
#include "bpu.hpp"
#include "image_preprocessor.hpp"
#include <map>
namespace ainvr {
enum class BpuImageContract { FloatNchw, Nv12EmbeddedPreprocess };
struct BpuImageResult {
  std::vector<std::vector<float>> outputs;
  std::string image_backend;
  double preprocess_ms=0,inference_ms=0,output_decode_ms=0;
};
class BpuImageRunner {
 public:
  BpuImageRunner(const std::string& model_path,BpuImageContract contract,
                 const std::string& image_input_name="");
  BpuImageResult Run(const Nv12Frame& frame,const ImageTransform& transform,
                    const std::map<std::string,std::vector<float>>& auxiliary={});
  const nlohmann::json& Description() const { return description_; }
 private:
  BpuModel model_;
  BpuImageContract contract_;
  nlohmann::json description_;
  std::string image_input_name_;
  size_t image_input_index_=0;
  ImagePreprocessor images_;
  std::thread::id owner_=std::this_thread::get_id();
};
}
