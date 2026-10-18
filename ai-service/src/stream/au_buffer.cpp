#include "au_buffer.hpp"
#include "au_spool.hpp"

#include <algorithm>
#include <cmath>

namespace ai_service::stream {

namespace {
double round4(double v) { return std::nearbyint(v * 10000.0) / 10000.0; }
int64_t PayloadSize(const BufferedAu& au) {
  return static_cast<int64_t>(au.disk_payload?au.disk_payload->Size():au.data.size());
}
}  // namespace

// ========== AdaptiveDelayController ==========

AdaptiveDelayController::AdaptiveDelayController(double min_delay_s, double max_delay_s,
                                                   double headroom, size_t window,
                                                   double percentile, double miss_growth,
                                                   double fall_rate, double initial_delay_s)
    : min_delay_s_(min_delay_s),
      max_delay_s_(max_delay_s),
      headroom_(headroom),
      window_(window),
      percentile_(percentile),
      miss_growth_(miss_growth),
      fall_rate_(fall_rate),
      current_(initial_delay_s == -1.0 ? min_delay_s : initial_delay_s) {
  if (!std::isfinite(current_) || current_ < min_delay_s || current_ > max_delay_s)
    throw std::invalid_argument("Initial delay must be within the configured bounds");
  if (!(min_delay_s >= 0.0 && min_delay_s <= max_delay_s)) {
    throw std::invalid_argument("必须满足 0 <= min_delay_s <= max_delay_s");
  }
  if (!(percentile > 0.0 && percentile <= 1.0)) {
    throw std::invalid_argument("percentile 必须在 (0, 1]");
  }
  if (window < 1) {
    throw std::invalid_argument("window 必须 >= 1");
  }
}

void AdaptiveDelayController::on_stamp(double lag_s) {
  if (lag_s < 0.0) lag_s = 0.0;
  if (lag_s > max_delay_s_ * kOutlierFactor) {
    outliers_dropped_++;
    return;
  }
  lags_.push_back(lag_s);
  if (lags_.size() > window_) lags_.pop_front();

  double target = target_locked();
  if (target > current_) {
    current_ = std::min(max_delay_s_, target);  // 变差:立刻跟上
    raise_events_++;
  } else {
    // 变好:每个样本只收一小步,避免抖动导致延迟忽长忽短
    current_ = std::max(min_delay_s_, current_ - (current_ - target) * fall_rate_);
  }
}

void AdaptiveDelayController::on_miss() {
  miss_events_++;
  current_ = std::min(max_delay_s_, std::max(min_delay_s_, current_ * miss_growth_));
}

double AdaptiveDelayController::target_locked() const {
  if (lags_.empty()) return min_delay_s_;
  std::vector<double> ordered(lags_.begin(), lags_.end());
  std::sort(ordered.begin(), ordered.end());
  size_t idx = std::min(ordered.size() - 1,
                         static_cast<size_t>(static_cast<double>(ordered.size()) * percentile_));
  return ordered[idx] * headroom_;
}

ControllerStats AdaptiveDelayController::stats() const {
  ControllerStats s;
  s.delay_s = round4(current_);
  s.samples = static_cast<int>(lags_.size());
  s.p_target_s = round4(target_locked());
  s.raise_events = raise_events_;
  s.miss_events = miss_events_;
  s.outliers = outliers_dropped_;
  return s;
}

// ========== AuDelayBuffer ==========

AuDelayBuffer::AuDelayBuffer(std::shared_ptr<AdaptiveDelayController> controller,
                              double hold_factor, int64_t max_bytes, int64_t max_frames,
                              std::shared_ptr<AuSpool> spool)
    : controller_(controller ? std::move(controller)
                              : std::make_shared<AdaptiveDelayController>()),
      hold_factor_(hold_factor),
      max_bytes_(max_bytes),
      max_frames_(max_frames),spool_(std::move(spool)) {
  if (hold_factor <= 1.0) {
    throw std::invalid_argument("hold_factor 必须 > 1:容量要留在延迟上方");
  }
}

void AuDelayBuffer::put(BufferedAu au) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (au.generation != generation_) {
    if (!items_.empty()) {
      ++generation_reset_events_;
      generation_reset_units_ += static_cast<int64_t>(items_.size());
    }
    clear_locked();
    generation_ = au.generation;
  }

  int64_t pts_ns = au.pts_ns;
  double arrived_mono = au.arrived_mono;
  int64_t data_size = static_cast<int64_t>(au.data.size());
  if(spool_){
    au.disk_payload=spool_->Store(au.data);
    std::vector<uint8_t>().swap(au.data);
  }

  items_.push_back(std::move(au));
  BufferedAu* stored = &items_.back();

  int count = 0;
  auto pc_it = pts_counts_.find(pts_ns);
  if (pc_it != pts_counts_.end()) count = pc_it->second;
  pts_counts_[pts_ns] = count + 1;

  // 重复 PTS 不猜哪一帧;直到该 PTS 的所有在途包退出才释放歧义。
  bool ambiguous = count > 0 || gone_.count(pts_ns) > 0;
  if (ambiguous) duplicate_pts_count_++;
  index_[pts_ns] = (ambiguous || pts_ns < 0) ? nullptr : stored;

  bytes_ += data_size;
  put_count_++;
  last_put_mono_ = arrived_mono;
  evict_locked(arrived_mono);
}

std::optional<double> AuDelayBuffer::seconds_since_last_put(double now_mono) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!last_put_mono_) return std::nullopt;
  return now_mono - *last_put_mono_;
}

StampResult AuDelayBuffer::stamp(int64_t pts_ns, const SeiTransform& transform, double now_mono,
                                  std::optional<int64_t> generation) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (generation != generation_ || pts_ns < 0) {
    unknown_count_++;
    return StampResult::kUnknown;
  }
  auto it = index_.find(pts_ns);
  BufferedAu* found = (it != index_.end()) ? it->second : nullptr;
  if (found == nullptr) {
    StampResult reason;
    if (pts_counts_.count(pts_ns) > 0) {
      reason = StampResult::kUnknown;
    } else {
      auto git = gone_.find(pts_ns);
      reason = (git != gone_.end()) ? git->second : StampResult::kUnknown;
    }
    if (reason == StampResult::kTooLate) {
      too_late_count_++;
      controller_->on_miss();
    } else if (reason == StampResult::kUnknown) {
      unknown_count_++;
    }
    return reason;
  }
  if (found->stamped) {
    return StampResult::kStamped;
  }
  std::vector<uint8_t> restored;
  if(found->disk_payload)restored=found->disk_payload->Read();
  const auto& original=found->disk_payload?restored:found->data;
  auto new_data = transform(original);
  if (new_data == original) {
    unknown_count_++;
    return StampResult::kUnknown;
  }
  const auto size_before=PayloadSize(*found);
  if(spool_){
    auto stored=spool_->Store(new_data);
    found->disk_payload=std::move(stored);
  }else found->data = std::move(new_data);
  bytes_ += PayloadSize(*found)-size_before;
  found->stamped = true;
  stamped_count_++;
  controller_->on_stamp(now_mono - found->arrived_mono);
  return StampResult::kStamped;
}

std::optional<BufferedAu> AuDelayBuffer::pop_ready(double now_mono) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (items_.empty()) return std::nullopt;
  const BufferedAu& head = items_.front();
  double age = now_mono - head.arrived_mono;
  if (age < pressure_threshold_locked()) {
    if (age < controller_->delay_s()) {
      return std::nullopt;
    }
  }
  // Read before changing the queue,so an I/O error cannot return empty bytes
  // or quietly publish a different frame. Anonymous files stay owned until
  // their last retained AU is consumed or evicted.
  if(items_.front().disk_payload){
    items_.front().data=items_.front().disk_payload->Read();
    items_.front().disk_payload.reset();
  }
  BufferedAu result = std::move(items_.front());
  items_.pop_front();
  remove_index_locked(result.pts_ns);
  bytes_ -= static_cast<int64_t>(result.data.size());
  popped_count_++;
  remember_gone_locked(result.pts_ns, StampResult::kTooLate);
  return result;
}

void AuDelayBuffer::remove_index_locked(int64_t pts_ns) {
  auto it = pts_counts_.find(pts_ns);
  int remaining = (it != pts_counts_.end() ? it->second : 0) - 1;
  if (remaining != 0) {
    pts_counts_[pts_ns] = remaining;
  } else {
    pts_counts_.erase(pts_ns);
    index_.erase(pts_ns);
  }
}

double AuDelayBuffer::hold_s_locked() const { return controller_->max_delay_s() * hold_factor_; }

double AuDelayBuffer::pressure_threshold_locked() const {
  return controller_->max_delay_s() * (1.0 + hold_factor_) / 2.0;
}

void AuDelayBuffer::remember_gone_locked(int64_t pts_ns, StampResult reason) {
  if (gone_order_.size() == kPtsMemory) {
    gone_.erase(gone_order_.front());
    gone_order_.pop_front();
  }
  gone_order_.push_back(pts_ns);
  gone_[pts_ns] = reason;
}

void AuDelayBuffer::evict_locked(double now_mono) {
  double hold_s = hold_s_locked();
  while (!items_.empty() && over_capacity_locked(now_mono, hold_s)) {
    size_t before = items_.size();
    size_t cut = std::min(find_resync_cut_locked(), items_.size());
    BufferEviction e;
    e.at_mono = now_mono;
    e.oldest_age_s = now_mono - items_.front().arrived_mono;
    e.hold_limit_s = hold_s;
    e.bytes_before = bytes_;
    e.frames_before = static_cast<int64_t>(before);
    e.removed = static_cast<int64_t>(cut);
    e.resumed_at_keyframe = cut < before && items_[cut].is_keyframe;
    e.generation = generation_;
    if (bytes_ > max_bytes_) { e.reasons |= kBufferBytes; ++byte_limit_events_; }
    if (e.frames_before > max_frames_) { e.reasons |= kBufferFrames; ++frame_limit_events_; }
    if (e.oldest_age_s > hold_s) { e.reasons |= kBufferAge; ++age_limit_events_; }
    last_eviction_ = e;
    for (size_t k = 0; k < cut; ++k) {
      auto& a = items_[k];
      remove_index_locked(a.pts_ns);
      bytes_ -= PayloadSize(a);
      remember_gone_locked(a.pts_ns, StampResult::kDropped);
    }
    items_.erase(items_.begin(), items_.begin() + static_cast<std::ptrdiff_t>(cut));
    dropped_count_ += static_cast<int64_t>(before - items_.size());
    drop_events_ += 1;
  }
}

bool AuDelayBuffer::over_capacity_locked(double now_mono, double hold_s) const {
  if (static_cast<int64_t>(items_.size()) > max_frames_ || bytes_ > max_bytes_) return true;
  return (now_mono - items_.front().arrived_mono) > hold_s;
}

size_t AuDelayBuffer::find_resync_cut_locked() const {
  for (size_t i = 1; i < items_.size(); ++i) {
    if (items_[i].is_keyframe) return i;
  }
  return 1;
}

void AuDelayBuffer::clear() {
  std::lock_guard<std::mutex> lock(mutex_);
  clear_locked();
}

void AuDelayBuffer::clear_locked() {
  items_.clear();
  if(spool_)spool_->Reset();
  index_.clear();
  pts_counts_.clear();
  gone_.clear();
  gone_order_.clear();
  bytes_ = 0;
  last_put_mono_ = std::nullopt;
}

BufferStats AuDelayBuffer::stats() const {
  std::lock_guard<std::mutex> lock(mutex_);
  BufferStats s;
  s.level = static_cast<int>(items_.size());
  if (items_.size() > 1) {
    s.held_s = round4(items_.back().arrived_mono - items_.front().arrived_mono);
  }
  s.bytes = bytes_;
  s.resident_payload_bytes=spool_?0:bytes_;
  s.ssd_allocated_bytes=spool_?spool_->AllocatedBytes():0;
  s.put = put_count_;
  s.popped = popped_count_;
  s.stamped = stamped_count_;
  s.too_late = too_late_count_;
  s.dropped = dropped_count_;
  s.drop_events = drop_events_;
  s.byte_limit_events = byte_limit_events_;
  s.frame_limit_events = frame_limit_events_;
  s.age_limit_events = age_limit_events_;
  s.generation_reset_events = generation_reset_events_;
  s.generation_reset_units = generation_reset_units_;
  s.last_eviction = last_eviction_;
  s.unknown = unknown_count_;
  s.duplicate_pts = duplicate_pts_count_;
  s.controller = controller_->stats();
  return s;
}

size_t AuDelayBuffer::size() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return items_.size();
}

}  // namespace ai_service::stream
