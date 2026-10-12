// Copyright AINVR. Durable pre-encoding tasks, including 8K NV12 frames.
#pragma once
#include "platform/vpu_decoder.hpp"
#include <nlohmann/json.hpp>
#include <functional>
#include <memory>
namespace ainvr {
struct RawFrameTask {Nv12Frame frame;nlohmann::json metadata;};
class RawFrameSpool {
 public:
  RawFrameSpool(const std::string& directory,size_t max_bytes,size_t max_tasks=2);
  ~RawFrameSpool();
  RawFrameSpool(const RawFrameSpool&)=delete;
  RawFrameSpool& operator=(const RawFrameSpool&)=delete;
  // ID and metadata (including per-detection IDs) must remain stable on retries.
  void Stage(const std::string& id,const RawFrameTask& task);
  std::vector<std::string> Pending();
  // Retire only after every output derived from this task has been persisted.
  void Deliver(const std::string& id,const std::function<void(const RawFrameTask&)>& accept);
 private:
  struct State;std::unique_ptr<State> state_;
};
}
