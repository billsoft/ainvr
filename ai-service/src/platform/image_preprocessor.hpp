// Copyright AINVR.
#pragma once
#include "gles_preprocess.hpp"
#include "pym_scaler.hpp"
#include "gdc_projector.hpp"
#include <string>
#include <thread>
namespace ainvr {
struct PreprocessedImage {
  std::vector<float> chw;
  // PYM handles resizing only; GLES still performs color/normalization/padding.
  std::string backend;
  std::vector<std::string> fallback_reasons;
  double gdc_configuration_ms=0;
  std::vector<uint8_t> jpeg_nv12; // Full-range BT.601; populated only by RunJpegNv12.
};
struct PreprocessorOptions {
  bool dedicated_hardware=true;
  bool gpu=true;
  // Explicitly opt in only for reference tests; production must fail closed.
  bool cpu_reference=false;
};
class ImagePreprocessor {
 public:
  explicit ImagePreprocessor(PreprocessorOptions options={}):options_(options){}
  // All calls on the constructing thread, like the underlying GLES context.
  PreprocessedImage RunNv12(const Nv12Frame& input,const ImageTransform& transform);
  PreprocessedImage RunJpegNv12(const Nv12Frame& input,const ImageTransform& transform);
 private:
  PreprocessedImage RunImpl(const Nv12Frame& input,const ImageTransform& transform,bool jpeg);
  PreprocessorOptions options_;
  std::thread::id owner_=std::this_thread::get_id();
  std::unique_ptr<GlesPreprocessor> gles_;
  std::unique_ptr<PymScaler> pym_;
  std::unique_ptr<GdcProjector> gdc_;
  std::array<int,4> dimensions_{};
  std::array<int,4> gdc_dimensions_{};
  std::array<float,3> gdc_angles_{};
  bool pym_failed_=false,gdc_failed_=false,gles_failed_=false;
  std::vector<std::string> failures_;
};
}
