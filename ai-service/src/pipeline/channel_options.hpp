// Copyright AINVR. Configuration boundary for the explicit ONNX worker.
#pragma once
#include "channel_worker.hpp"
#include "model_transform.hpp"
#include "config/config.hpp"
#include "utils/coco.hpp"
#include <filesystem>

namespace ainvr {
// Caller parses with ChannelConfigFromJson first. This capability gate runs
// before opening a source. BPU selection belongs to the future runtime factory;
// this function must never silently substitute CPU for a requested BPU model.
inline ChannelWorkerOptions OnnxOptions(
    const ai_service::config::ChannelConfig& cfg,
    const std::filesystem::path& model_root) {
  auto reject=[](const char* text){throw std::invalid_argument(text);};
  if (cfg.model.provider!="cpu" || cfg.model.adapter!="yolo26_end2end")
    reject("ONNX channel requires the implemented cpu/yolo26_end2end contract");
  if (cfg.snapshot.enabled || cfg.publish.enabled)
    reject("Online snapshot admission and SEI output are not connected yet");
  if (cfg.stream.codec_override)
    reject("Codec override is not implemented by the native demuxer");
  if (cfg.stream.reconnect.backoff_factor!=2.0)
    reject("Native reconnect currently requires backoff_factor=2");
  if (cfg.deletion_pending || cfg.manually_stopped || !cfg.enabled)
    reject("Channel lifecycle does not permit startup");
  const bool rtmp=cfg.stream.url.starts_with("rtmp://");
  const bool http=cfg.stream.url.starts_with("http://") || cfg.stream.url.starts_with("https://");
  if ((!rtmp&&!http) || (cfg.stream.protocol=="rtmp"&&!rtmp) ||
      (cfg.stream.protocol=="flv"&&!http))
    reject("Stream URL does not match its configured protocol");
  auto milliseconds=[](double value) {
    if (!std::isfinite(value) || value<.1 || value>60)
      throw std::invalid_argument("Native timeout/delay must be between 0.1 and 60 seconds");
    return static_cast<int>(std::ceil(value*1000));
  };
  ChannelWorkerOptions result;
  result.id=cfg.id;result.url=cfg.stream.url;
  result.inference_fps=cfg.inference_fps;
  result.source_timeout_ms=milliseconds(cfg.stream.watchdog_timeout_seconds);
  result.reconnect=cfg.stream.reconnect.enabled;
  result.reconnect_initial_ms=milliseconds(cfg.stream.reconnect.initial_delay);
  result.reconnect_max_ms=milliseconds(cfg.stream.reconnect.max_delay);
  if (cfg.result_buffer.max_frames<1 || cfg.result_buffer.max_frames>10000)
    reject("Native result buffer capacity must be between 1 and 10000");
  result.result_capacity=cfg.result_buffer.max_frames;
  auto path=std::filesystem::path(cfg.model.path);
  if (!path.is_absolute()) {
    if (!model_root.is_absolute())reject("Explicit absolute model root required");
    path=model_root/path;
  }
  result.processor.model_path=path.lexically_normal().string();
  if (cfg.model.input_size.size()!=2)reject("Configured model dimensions are missing");
  result.processor.expected_input_size=std::array<int,2>{cfg.model.input_size[0],cfg.model.input_size[1]};
  result.processor.preprocess=cfg.preprocess;
  ModelTransform(cfg.preprocess,false);
  result.processor.detection={cfg.postprocess.conf_threshold,cfg.postprocess.iou_threshold,cfg.postprocess.max_detections};
  if(cfg.model.class_names)result.processor.classes=*cfg.model.class_names;
  else for(auto name:ai_service::utils::kCocoNames)result.processor.classes.emplace_back(name);
  return result;
}
}
