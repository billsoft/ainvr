// Copyright AINVR. Native online inference worker; service manager owns policy.
#pragma once
#include "frame_processor.hpp"
#include "output/result_buffer.hpp"
#include "stream/media_source.hpp"
#include "output/archive_admission.hpp"
#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>

namespace ainvr {
// Created, called and destroyed on the inference thread. Stage must durably
// accept the frame before returning; asynchronous work must retain its ticket.
// Throwing fails the channel rather than counting an unaccepted result.
class FrameArchiveSink {
 public:
  virtual ~FrameArchiveSink() = default;
  virtual void Stage(Nv12Frame frame, FrameContext context,
      ai_service::FrameResult result,
      ai_service::output::ArchiveAdmission::Ticket ticket) = 0;
};
struct ChannelWorkerOptions {
  std::string id, url;
  FrameProcessorOptions processor;
  double inference_fps = 5;
  int source_timeout_ms = 5000;
  bool reconnect = true;
  int reconnect_initial_ms = 1000, reconnect_max_ms = 10000;
  size_t result_capacity = 30;
  std::function<std::unique_ptr<FrameArchiveSink>()> archive_factory;
};

// Decodes continuously on its capture thread, retaining only the latest decoded
// frame for the inference thread. Model/GLES lifetime belongs to inference thread.
// License callback is REQUIRED, concurrent, fast and non-reentrant; exceptions
// revoke access. Revocation is latched until Stop() then explicit Start().
// Optional archive sink provides frame admission and durable acceptance.
// The manager must wire a real sink; SEI publishing and hot config are pending.
class OnnxChannelWorker {
 public:
  OnnxChannelWorker(ChannelWorkerOptions options, std::function<bool()> licensed);
  ~OnnxChannelWorker();
  void Start();
  void Stop();
  nlohmann::json Status() const;
  std::vector<ai_service::FrameResult> Results() const { return results_.All(); }
 private:
  struct Captured {
    Nv12Frame frame;
    FrameContext context;
    uint64_t epoch = 0;
  };
  bool Allowed();
  void Fail(const std::string& message);
  void CaptureLoop();
  void InferLoop();
  void CancelSource();
  ChannelWorkerOptions options_;
  std::function<bool()> licensed_;
  ai_service::ResultBuffer results_;
  std::atomic<bool> stop_{true}, revoked_{false};
  std::thread capture_, inference_;
  std::mutex lifecycle_;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::shared_ptr<MediaSource> source_;
  std::optional<Captured> latest_;
  std::string state_ = "idle", error_, backend_;
  uint64_t epoch_ = 0, decoded_ = 0, selected_ = 0, completed_ = 0;
  uint64_t superseded_ = 0, stale_ = 0, source_failures_ = 0;
  double read_ms_ = 0, submit_ms_ = 0, receive_ms_ = 0;
};
}
