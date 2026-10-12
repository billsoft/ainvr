// Copyright AINVR.
#include "frame_processor.hpp"
#include "model_transform.hpp"
#include <chrono>
#include <cmath>
#include <filesystem>
#include <stdexcept>

namespace ainvr {
namespace {
FrameProcessorOptions Validate(FrameProcessorOptions options) {
  if (options.model_path.empty()) throw std::invalid_argument("Empty model path");
  if (options.contract != DetectionContract::Scrfd &&
      options.contract != DetectionContract::EndToEnd)
    throw std::invalid_argument("Unsupported detection contract");
  if (options.contract == DetectionContract::EndToEnd && options.classes.empty())
    throw std::invalid_argument("End-to-end model requires explicit class names");
  const auto& d = options.detection;
  if (!std::isfinite(d.confidence) || d.confidence < 0 || d.confidence > 1 ||
      !std::isfinite(d.iou) || d.iou < 0 || d.iou > 1 || d.maximum < 1)
    throw std::invalid_argument("Invalid detection thresholds");
  ModelTransform(options.preprocess, options.contract == DetectionContract::Scrfd);
  return options;
}
double Ms(std::chrono::steady_clock::duration value) {
  return std::chrono::duration<double, std::milli>(value).count();
}
}
OnnxFrameProcessor::OnnxFrameProcessor(FrameProcessorOptions options)
    : options_(Validate(std::move(options))), model_(options_.model_path),
      preprocessor_(options_.hardware) {
  const auto shape = model_.InputShape();
  if (shape.size() != 4 || shape[0] != 1 || shape[1] != 3 ||
      shape[2] < 1 || shape[3] < 1 || shape[2] > 8192 || shape[3] > 8192)
    throw std::invalid_argument("Expected static NCHW RGB model");
  transform_ = ModelTransform(options_.preprocess, IsFaceDetection());
  transform_.width = static_cast<int>(shape[3]);
  transform_.height = static_cast<int>(shape[2]);
  if (options_.expected_input_size &&
      *options_.expected_input_size != std::array<int,2>{transform_.height,transform_.width})
    throw std::invalid_argument("Configured model input size differs from ONNX input");
}
bool OnnxFrameProcessor::IsFaceDetection() const noexcept {
  return options_.contract == DetectionContract::Scrfd;
}
ProcessedFrame OnnxFrameProcessor::Process(const Nv12Frame& frame,
                                          const FrameContext& context) {
  if (owner_ != std::this_thread::get_id())
    throw std::logic_error("Frame processor called outside owner thread");
  if (context.channel_id.empty() || context.index < 0 ||
      !std::isfinite(context.received_at) || context.received_at <= 0 ||
      !std::isfinite(context.decode_ms) || context.decode_ms < 0)
    throw std::invalid_argument("Invalid frame context");
  transform_.yuv_bt709 = context.bt709;
  transform_.yuv_full_range = context.full_range;
  const auto begin = std::chrono::steady_clock::now();
  auto prepared = preprocessor_.RunNv12(frame, transform_);
  const auto after_preprocess = std::chrono::steady_clock::now();
  auto outputs = model_.Run(prepared.chw);
  const auto after_inference = std::chrono::steady_clock::now();
  const auto scale = ai_service::pipeline::compute_scale(
      frame.width, frame.height, transform_.width, transform_.height);
  auto detections = IsFaceDetection()
      ? DecodeScrfd(outputs, scale, options_.detection)
      : DecodeEndToEnd(outputs.at(0), scale, options_.classes, options_.detection);
  const auto end = std::chrono::steady_clock::now();
  ProcessedFrame processed;
  auto& result = processed.result;
  result.channel_id = context.channel_id;
  result.stream_url = context.stream_url;
  result.stream_protocol = context.stream_protocol;
  result.frame_index = context.index;
  result.frame_pts_ns = context.source_pts_ns.value_or(-1);
  result.timestamp = context.received_at;
  result.frame_width = frame.width;
  result.frame_height = frame.height;
  result.model_name = std::filesystem::path(options_.model_path).filename().string();
  result.model_format = "onnx";
  result.model_provider = "cpu";
  result.model_end2end = !IsFaceDetection();
  result.model_input_size = {transform_.height, transform_.width};
  result.task_type = IsFaceDetection() ? "face_detection" : "object_detection";
  result.detections = std::move(detections);
  result.time_decode_ms = context.decode_ms;
  result.time_preprocess_ms = Ms(after_preprocess - begin);
  result.time_inference_ms = Ms(after_inference - after_preprocess);
  result.time_postprocess_ms = Ms(end - after_inference);
  processed.preprocess_backend = std::move(prepared.backend);
  processed.fallback_reasons = std::move(prepared.fallback_reasons);
  return processed;
}
}
