// Copyright AINVR.
#include "channel_worker.hpp"
#include "frame_accounting.hpp"
#include <chrono>
#include <cmath>
#include <map>
#include <stdexcept>

namespace ainvr {
namespace {
using Clock = std::chrono::steady_clock;
double Seconds() { return std::chrono::duration<double>(Clock::now().time_since_epoch()).count(); }
template<class F> auto Timed(std::mutex& mutex, double& total, F&& action) {
  struct Timer {
    std::mutex& mutex; double& total; Clock::time_point start = Clock::now();
    ~Timer() {
      const auto elapsed = std::chrono::duration<double, std::milli>(Clock::now()-start).count();
      std::lock_guard lock(mutex); total += elapsed;
    }
  } timer{mutex, total};
  return action();
}
}
OnnxChannelWorker::OnnxChannelWorker(ChannelWorkerOptions options,
                                   std::function<bool()> licensed)
    : options_(std::move(options)), licensed_(std::move(licensed)),
      results_(options_.result_capacity) {
  if (options_.id.empty() || options_.url.empty() || !licensed_ ||
      !std::isfinite(options_.inference_fps) || options_.inference_fps < 0 ||
      options_.source_timeout_ms < 100 || options_.source_timeout_ms > 60000 ||
      options_.reconnect_initial_ms < 100 || options_.reconnect_max_ms < options_.reconnect_initial_ms ||
      options_.reconnect_max_ms > 60000 || options_.result_capacity < 1 || options_.result_capacity > 10000)
    throw std::invalid_argument("Invalid channel worker options or missing license callback");
}
OnnxChannelWorker::~OnnxChannelWorker() { Stop(); }
void OnnxChannelWorker::CancelSource() {
  std::shared_ptr<MediaSource> source;
  { std::lock_guard lock(mutex_); source = source_; }
  if (source) source->Cancel();
}
void OnnxChannelWorker::Fail(const std::string& message) {
  stop_ = true;
  { std::lock_guard lock(mutex_); state_ = "error";
    error_ = revoked_ ? "License unavailable or revoked" : message; latest_.reset(); }
  cv_.notify_all(); CancelSource();
}
bool OnnxChannelWorker::Allowed() {
  if (stop_ || revoked_) return false;
  bool allowed = false;
  try { allowed = licensed_(); } catch (...) {}
  if (!allowed) {
    { std::lock_guard lock(mutex_); revoked_ = true; }
    Fail("License unavailable or revoked");
  }
  return allowed && !stop_ && !revoked_;
}
void OnnxChannelWorker::Start() {
  std::lock_guard lifecycle(lifecycle_);
  if (capture_.joinable() || inference_.joinable())
    throw std::logic_error("Stop and join the channel before restarting");
  {
    std::lock_guard lock(mutex_);
    state_ = "starting"; error_.clear(); backend_.clear(); latest_.reset();
    decoded_ = selected_ = completed_ = superseded_ = stale_ = source_failures_ = 0;
    read_ms_ = submit_ms_ = receive_ms_ = 0;
    ++epoch_;
  }
  results_.Clear(); revoked_ = false; stop_ = false;
  if (!Allowed()) return;
  try {
    inference_ = std::thread(&OnnxChannelWorker::InferLoop, this);
    capture_ = std::thread(&OnnxChannelWorker::CaptureLoop, this);
  } catch (...) {
    Fail("Could not start channel threads");
    if (inference_.joinable()) inference_.join();
    if (capture_.joinable()) capture_.join();
    throw;
  }
}
void OnnxChannelWorker::Stop() {
  std::lock_guard lifecycle(lifecycle_);
  stop_ = true; cv_.notify_all(); CancelSource();
  if (capture_.joinable()) capture_.join();
  if (inference_.joinable()) inference_.join();
  std::lock_guard lock(mutex_);
  source_.reset(); latest_.reset();
  if (state_ != "error") state_ = "idle";
}
nlohmann::json OnnxChannelWorker::Status() const {
  std::lock_guard lock(mutex_);
  return {{"channel_id", options_.id}, {"state", state_}, {"last_error", error_},
          {"epoch", epoch_}, {"decoded", decoded_}, {"selected", selected_},
          {"completed", completed_}, {"superseded_before_inference", superseded_},
          {"stale_results_discarded", stale_}, {"source_failures", source_failures_},
          {"pending_frames", latest_ ? 1 : 0}, {"model_provider", "cpu"},
          {"preprocess_backend", backend_}, {"license_revoked", revoked_.load()},
          {"capture_read_ms", read_ms_}, {"capture_submit_ms", submit_ms_},
          {"capture_receive_ms", receive_ms_}};
}
void OnnxChannelWorker::CaptureLoop() {
  int delay = options_.reconnect_initial_ms;
  while (Allowed()) {
    try {
      // Construction has bounded open/probe timeouts; Cancel handles active reads.
      auto source = std::make_shared<MediaSource>(options_.url, options_.source_timeout_ms);
      if (!Allowed()) break;
      uint64_t epoch;
      { std::lock_guard lock(mutex_); if (stop_) break;
        source_ = source; epoch = ++epoch_; latest_.reset(); }
      const auto info = source->Info();
      VpuDecoder decoder(info.codec, info.width, info.height);
      std::map<uint64_t, std::optional<int64_t>> timestamps;
      uint64_t token = 0;
      bool waiting_keyframe = true;
      bool decoded_any = false;
      auto last_frame = Clock::now();
      auto receive = [&](int timeout) {
        const auto start = Clock::now();
        auto frame = Timed(mutex_, receive_ms_, [&] { return decoder.Receive(timeout); });
        if (!frame) return false;
        const auto found = timestamps.find(frame->pts);
        if (found == timestamps.end()) throw std::runtime_error("Unknown decoded frame token");
        Captured item;
        item.context.channel_id = options_.id;
        // Source credentials must not be echoed in API results.
        item.context.source_pts_ns = found->second;
        item.context.received_at = std::chrono::duration<double>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        item.context.decode_ms = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
        item.context.bt709 = info.bt709; item.context.full_range = info.full_range;
        item.frame = std::move(*frame); item.epoch = epoch;
        timestamps.erase(found);
        if (!Allowed()) return false;
        {
          std::lock_guard lock(mutex_);
          if (stop_) return false;
          item.context.index = decoded_++;
          if (latest_) ++superseded_;
          latest_ = std::move(item); state_ = "running"; error_.clear();
        }
        cv_.notify_all(); last_frame = Clock::now(); delay = options_.reconnect_initial_ms;
        decoded_any = true;
        return true;
      };
      while (Allowed()) {
        auto packet = Timed(mutex_, read_ms_, [&] { return source->Read(); });
        if (!packet) throw std::runtime_error("Source reached end of stream");
        if (waiting_keyframe) {
          if (!packet->key_frame) {
            if (Clock::now() - last_frame > std::chrono::milliseconds(options_.source_timeout_ms))
              throw std::runtime_error("Timed out waiting for random-access frame");
            continue;
          }
          waiting_keyframe = false;
        }
        if (timestamps.size() >= 128) throw std::runtime_error("Undecoded packet bound exceeded");
        timestamps.emplace(token, packet->pts_ns);
        while (Allowed() && !Timed(mutex_, submit_ms_, [&] { return decoder.Submit(packet->bytes, token, 20); })) {
          receive(20);
          if (Clock::now() - last_frame > std::chrono::milliseconds(options_.source_timeout_ms))
            throw std::runtime_error("Decoder stalled");
        }
        ++token;
        if (!decoded_any) { if (Allowed()) receive(50); }
        else { while (Allowed() && receive(1)) {} }
        if (Clock::now() - last_frame > std::chrono::milliseconds(options_.source_timeout_ms))
          throw std::runtime_error("No decoded video frames");
      }
    } catch (const std::exception& e) {
      if (stop_) break;
      {
        std::lock_guard lock(mutex_);
        if (stop_) break;
        ++source_failures_; ++epoch_; latest_.reset(); source_.reset();
        state_ = "reconnecting"; error_ = e.what();
      }
      if (!options_.reconnect) { Fail("Source failure with reconnect disabled"); break; }
      std::unique_lock lock(mutex_);
      cv_.wait_for(lock, std::chrono::milliseconds(delay), [&] { return stop_.load(); });
      delay = std::min(options_.reconnect_max_ms, delay * 2);
    } catch (...) { Fail("Unknown capture failure"); break; }
  }
  std::lock_guard lock(mutex_); source_.reset();
}
void OnnxChannelWorker::InferLoop() {
  try {
    if (!Allowed()) return;
    OnnxFrameProcessor processor(options_.processor);
    auto archive = options_.archive_factory ? options_.archive_factory() : nullptr;
    if (options_.archive_factory && !archive)
      throw std::runtime_error("Archive factory returned no sink");
    ai_service::output::ArchiveAdmission admission;
    const double interval = options_.inference_fps > 0 ? 1.0 / options_.inference_fps : 0;
    double deadline = Seconds();
    while (Allowed()) {
      std::optional<Captured> item;
      size_t frame_bytes = 0;
      {
        std::unique_lock lock(mutex_);
        if (!latest_ || Seconds() < deadline) {
          cv_.wait_for(lock, std::chrono::milliseconds(20)); continue;
        }
        frame_bytes = latest_->frame.pixels.size();
      }
      std::optional<ai_service::output::ArchiveAdmission::Ticket> ticket;
      // Never hold the capture mutex while waiting for archive capacity.
      if (archive) {
        ticket = admission.Acquire(frame_bytes, [&] { return Allowed(); });
        if (!ticket) break;
      }
      {
        std::lock_guard lock(mutex_);
        // Reconnect/resolution changes can replace the candidate while waiting.
        // Re-reserve before selecting a larger frame; smaller frames fit safely.
        if (!latest_ || latest_->frame.pixels.size() > frame_bytes) continue;
        item = std::move(latest_); latest_.reset(); ++selected_;
      }
      if (!Allowed()) break;
      auto processed = processor.Process(item->frame, item->context);
      if (!Allowed()) break;
      {
        std::lock_guard lock(mutex_);
        if (item->epoch != epoch_) { ++stale_; continue; }
      }
      if (archive) {
        archive->Stage(std::move(item->frame), item->context,
                       processed.result, std::move(*ticket));
        ticket.reset();
      }
      {
        std::lock_guard lock(mutex_);
        if (!stop_ && !revoked_ && item->epoch == epoch_) {
          backend_ = processed.preprocess_backend;
          results_.Append(std::move(processed.result)); ++completed_;
        } else { ++stale_; }
      }
      deadline = ai_service::pipeline::NextInferenceDeadline(deadline, Seconds(), interval);
    }
  } catch (const std::exception& e) { Fail(e.what()); }
    catch (...) { Fail("Unknown inference failure"); }
}
}
