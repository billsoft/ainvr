// Copyright AINVR. Reusable single-thread frame inference for channel workers.
#pragma once
#include "platform/image_preprocessor.hpp"
#include "platform/onnx_model.hpp"
#include "preprocess_config.hpp"
#include <thread>

namespace ainvr {
enum class DetectionContract { Scrfd, EndToEnd };
struct FrameProcessorOptions {
  std::string model_path;
  DetectionContract contract = DetectionContract::EndToEnd;
  std::vector<std::string> classes;
  DetectionOptions detection;
  PreprocessorOptions hardware;
  ai_service::pipeline::PreprocessConfig preprocess;
  std::optional<std::array<int,2>> expected_input_size; // configured [height,width]
};
struct FrameContext {
  std::string channel_id, stream_url, stream_protocol;
  int64_t index = 0;
  std::optional<int64_t> source_pts_ns;
  double received_at = 0, decode_ms = 0;
  bool bt709 = true, full_range = false;
};
struct ProcessedFrame {
  ai_service::FrameResult result;
  std::string preprocess_backend;
  std::vector<std::string> fallback_reasons;
};

// Explicit CPU ONNX model backend, hardware-first preprocessing. Construct, run,
// and destroy on the inference thread. Does not own decoder frames or timestamps.
// Licensing, capture scheduling, and durable acceptance belong to the worker.
class OnnxFrameProcessor {
 public:
  explicit OnnxFrameProcessor(FrameProcessorOptions options);
  ProcessedFrame Process(const Nv12Frame& frame, const FrameContext& context);
  bool IsFaceDetection() const noexcept;
 private:
  FrameProcessorOptions options_;
  OnnxModel model_;
  ImagePreprocessor preprocessor_;
  ImageTransform transform_;
  std::thread::id owner_ = std::this_thread::get_id();
};
}
