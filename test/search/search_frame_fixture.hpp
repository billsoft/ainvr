// Shared software-only frame/lease fixture; no SDK, model or network.
#pragma once
#include "output/search_hardware_owner.hpp"
#include <thread>
namespace search_test {
using namespace ai_service;
using namespace ai_service::config;
using namespace ai_service::output;
inline size_t checks=0;
inline void Check(bool ok,const char* why){++checks;if(!ok)throw std::runtime_error(why);}
template<class F> void Await(F f){auto end=std::chrono::steady_clock::now()+std::chrono::seconds(4);while(!f()){if(std::chrono::steady_clock::now()>end)throw std::runtime_error("await_timeout");std::this_thread::sleep_for(std::chrono::milliseconds(1));}}
struct Fixture {
  using Json = nlohmann::json;
  const std::string input = "00000000-0000-4000-8000-000000000001", output = "00000000-0000-4000-8000-000000000002";
  std::chrono::steady_clock::time_point now{};
  std::shared_ptr<SearchProducerGrantAuthority> authority;
  std::shared_ptr<ainvr::Nv12Frame> raw = std::make_shared<ainvr::Nv12Frame>();
  SearchFrameCapture capture;
  FrameResult result;
  Json doc;
  explicit Fixture(std::string package = "candidate-package") {
    doc = {{"enabled", true}, {"reason", nullptr}, {"endpoint", "http://127.0.0.1:8400"}, {"api_token", std::string(64, 'b')},
      {"revision", std::string(64, 'a')}, {"model", {{"package_id", std::move(package)}}}, {"valid_for_ms", 30000},
      {"limits", {{"producer_queue", 1}, {"producer_bytes", 134217728}, {"image_max_bytes", 8388608}, {"retention_days", 30}}},
      {"sampling", {{"mode", "all"}, {"channel_ids", Json::array()}, {"object", true}, {"scene", true}, {"object_interval_ms", 1000},
        {"scene_active_interval_ms", 10000}, {"scene_static_interval_ms", 60000}, {"scene_change_min_interval_ms", 3000}, {"track_slots", 8}}},
      {"sources", Json::array({{{"channel_id", output}, {"input_stream_id", input}, {"processor_id", "processor"},
        {"recording_channel_id", output}, {"input_path", "/live/source"}, {"output_path", "/live/result"}, {"object", true}, {"scene", true}}})}};
    authority = std::make_shared<SearchProducerGrantAuthority>([this] { return now; }); authority->Start(); Renew();
    raw->width = 8; raw->height = 4; raw->pixels.resize(48); raw->pts = 123;
    capture.worker_input_url = "rtmp://127.0.0.1/live/source"; capture.worker_output_url = "rtmp://127.0.0.1/live/result";
    auto& f = capture.fence; f.processor_id = "processor"; f.stream_session_id = "session-1"; f.input_path = "/live/source";
    f.output_path = "/live/result"; f.source_epoch = 1; f.stream_generation = 1; f.view_reset_epoch = 1;
    f.raw_width = f.observation_width = 8; f.raw_height = f.observation_height = 4;
    f.geometry = SearchFrameGeometryKind::FullFrameAxisScale; f.owner_allowed = true;
    f.projection = SearchSourceProjection::RawPlanar;
    result.channel_id = "processor"; result.stream_url = capture.worker_input_url; result.frame_width = 8; result.frame_height = 4;
    Detection detection; detection.class_name = detection.label_id = "person"; detection.track_id = "track-7";
    detection.bbox = {1, 0, 2, 4}; detection.confidence = .9; result.detections = {detection}; Advance(1);
  }
  void Renew() { Check(authority->Install(ParseSearchProducerGrant(doc), now), "fixture grant rejected"); }
  void Advance(int n, bool scene = false) {
    capture.mapped_pts_ns = result.frame_pts_ns = int64_t(n) * 1000000000;
    capture.capture_sequence = result.frame_index = n; capture.captured_wall = n;
    result.model_extra["analytics"] = {{"status", scene ? "detection_only" : "active"},
      {"stream_session_id", capture.fence.stream_session_id}, {"view_reset_epoch", capture.fence.view_reset_epoch}, {"tracks", Json::array()}};
    if (!scene) result.model_extra["analytics"]["tracks"].push_back({{"track_id", "track-7"}, {"state", "confirmed"},
      {"observation", "detected"}, {"last_observed_pts_ns", std::to_string(result.frame_pts_ns)}});
  }
  SearchProducerLeaseReader Reader() { std::weak_ptr<SearchProducerGrantAuthority> weak = authority;
    return [weak] { auto a = weak.lock(); return a ? a->Read() : std::nullopt; }; }
  SearchSamplingPixelRetainer Retain(int& n) { return [this, &n] { ++n; return raw; }; }
  SearchSamplingBinding Binding() { return {input,"processor",capture.fence.stream_session_id,8,4}; }
};
}  // namespace search_test
