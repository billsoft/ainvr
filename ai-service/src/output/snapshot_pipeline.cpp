#include "snapshot_internal.hpp"
#include "grounding_snapshot.hpp"

namespace ai_service::output {
using namespace snapshot_detail;
void SnapshotStore::Offer(const FrameProvider& frame_provider, const std::string& channel_id,
                          const std::string& channel_name, int64_t frame_pts_ns, double timestamp,
                          const std::string& model_name, const std::string& task_type,
                          const std::vector<Detection>& crop_detections,
                          const std::vector<Detection>& stored_detections, bool square_crop,
                          const config::SnapshotConfig& snapshot_cfg) {
  OfferTargets(frame_provider, channel_id, channel_name, frame_pts_ns, timestamp,
               model_name, task_type, crop_detections, stored_detections, square_crop,
               snapshot_cfg, {});
}

void SnapshotStore::OfferResult(const FrameProvider& provider, const FrameResult& result,
                                const std::string& channel_name,
                                const std::vector<Detection>& crop_detections, bool square_crop,
                                const config::SnapshotConfig& cfg) {
  if (!cfg.enabled) return;
  // Validate every point before accepting any box or point from this result.
  const auto targets = GroundingSnapshotTargets(result);
  if (!targets.empty() && (provider.size.width <= 0 || provider.size.height <= 0))
    throw std::invalid_argument("Snapshot point context requires a valid source frame");
  Offer(provider, result.channel_id, channel_name, result.frame_pts_ns, result.timestamp,
        result.model_name, result.task_type, crop_detections, result.detections, square_crop, cfg);
  if (targets.empty()) return;
  std::vector<Detection> contexts, properties;
  std::vector<json> points;
  for (const auto& target : targets) {
    Detection context;
    // This is an internal image region only. The record explicitly has bbox=null.
    context.bbox = {0, 0, double(provider.size.width), double(provider.size.height)};
    contexts.push_back(context);
    properties.push_back(target.properties);
    points.push_back(target.point);
  }
  OfferTargets(provider, result.channel_id, channel_name, result.frame_pts_ns, result.timestamp,
               result.model_name, result.task_type, contexts, properties, false, cfg, points);
}

void SnapshotStore::OfferTargets(const FrameProvider& frame_provider, const std::string& channel_id,
                          const std::string& channel_name, int64_t frame_pts_ns, double timestamp,
                          const std::string& model_name, const std::string& task_type,
                          const std::vector<Detection>& crop_detections,
                          const std::vector<Detection>& stored_detections, bool square_crop,
                          const config::SnapshotConfig& snapshot_cfg,
                          const std::vector<json>& points) {
  if (!snapshot_cfg.enabled) return;
  if (crop_detections.empty()) return;
  const bool point_records = !points.empty();
  if (point_records && (points.size() != crop_detections.size() || points.size() != stored_detections.size()))
    throw std::invalid_argument("Snapshot point target count mismatch");
  auto crop_cfg = snapshot_cfg;
  if (point_records) {
    // A point does not define an object extent or an ERP perspective crop.
    // Preserve the complete source frame as its explicitly described context.
    crop_cfg.projection_mode = "flat";
    crop_cfg.padding_ratio = 0;
    crop_cfg.face_enhance_model = "none";
    square_crop = false;
  }
  // One producer at a time: after capacity is checked, the writer can only free slots.
  std::lock_guard<std::mutex> offer_lock(offer_mutex_);
  const auto epoch = capture_epoch_.load();
  const auto archive_epoch = deletions_.Epoch();

  // 写入线程(AppendWrite)用的最新配置——见头文件 cfg_ 字段的说明:每次
  // Offer 调用即更新,等价 v1 channel.py::apply_hot_patch 直接替换
  // self._snapshot_store.cfg 引用的效果。
  {
    std::lock_guard<std::mutex> lock(cfg_mutex_);
    // An inference already in flight can carry the pre-toggle configuration.
    // Never let that stale offer re-enable capture after the API disabled it.
    if (!cfg_.enabled) return;
    cfg_ = snapshot_cfg;
  }

  double now = NowMono();

  const size_t total = std::min(crop_detections.size(), stored_detections.size());
  // Only owned pixels cross threads. Never retain a decoded surface/provider.
  // Unusual/invalid configurations continue through the existing validated path.
  bool deferred = thread_.joinable() && total > 0 &&
      frame_provider.download && frame_provider.size.width > 0 && frame_provider.size.height > 0 &&
      frame_provider.size.width < 32767 && frame_provider.size.height < 32767 &&
      size_t(frame_provider.size.width) * frame_provider.size.height * 4 <= (size_t(256) << 20) &&
      // A sparse 8K face costs less to crop/download by ROI than copying 112 MiB.
      // Keep that fast path; parallel full-frame work is for dense or <=4K input.
      (size_t(frame_provider.size.width) * frame_provider.size.height * 4 <= (size_t(32) << 20) || total >= 4) &&
      snapshot_cfg.max_crop_dimension > 0 && snapshot_cfg.max_crop_dimension <= 1024 &&
      std::isfinite(snapshot_cfg.padding_ratio) && snapshot_cfg.padding_ratio >= 0 &&
      snapshot_cfg.padding_ratio <= 1;
  for (size_t i = 0; deferred && i < total; ++i) {
    const auto& b = crop_detections[i].bbox;
    deferred = std::all_of(b.begin(), b.end(), [](double v) {
      return std::isfinite(v) && std::abs(v) <= 32760;
    }) && b[2] > 0 && b[3] > 0;
    // Validate without allocating maps; invalid targets keep existing accounting.
    if (deferred && crop_cfg.projection_mode == "erp_equirect")
      deferred = BboxToErpView(b, crop_cfg.padding_ratio, frame_provider.size.width,
          frame_provider.size.height, crop_cfg.max_crop_dimension, 9, square_crop).has_value();
    else if (deferred)
      deferred = b[0] < frame_provider.size.width && b[1] < frame_provider.size.height &&
          b[0] + b[2] > 0 && b[1] + b[3] > 0 &&
          (!square_crop || std::pow(std::max(b[2], b[3]) * (1 + 2 * crop_cfg.padding_ratio), 2) * 4 <= (size_t(256) << 20));
  }
  auto disabled = [&] { return !capture_enabled_.load() || epoch != capture_epoch_.load(); };
  auto cancelled = [&] { return disabled() || stop_event_.load() ||
      (frame_provider.cancelled && frame_provider.cancelled()); };
  std::shared_ptr<CapturedSnapshotFrame> captured;
  if (deferred && !cancelled()) {
    const size_t bytes = size_t(frame_provider.size.width) * frame_provider.size.height * 4;
    capacity_->Configure(bytes);
    captured = ReserveFrame(capacity_, captured_frames_, cancelled, backpressured_);
    if (captured) {
      const double start = NowMono();
      for (;;) {
        try {
          captured->size = frame_provider.size;
          if (frame_provider.owned_download) {
            captured->owned_download = frame_provider.owned_download;
            captured->nv12 = frame_provider.nv12;
            ClearArchiveFault("capture");
            break;
          }
          frame_provider.download(cv::Rect({}, frame_provider.size), captured->rgba);
          if (captured->rgba.size() != frame_provider.size || captured->rgba.type() != CV_8UC4)
            throw std::runtime_error("snapshot provider returned invalid frame");
          ClearArchiveFault("capture");
          break;
        } catch (const std::exception& e) {
          SetArchiveFault("capture", e.what());
          { std::lock_guard<std::mutex> lock(stats_mutex_); ++crop_error_count_; }
          if (last_crop_failure_log_mono_ == 0 || NowMono() - last_crop_failure_log_mono_ >= 30) {
            last_crop_failure_log_mono_ = NowMono();
            log::Warning(kLogModule, "[" + channel_id_ + "] snapshot capture failed: " + e.what());
          }
          if (cancelled()) { captured.reset(); break; }
          backpressured_.store(true);
          std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
      }
      backpressured_.store(false);
      if (captured) {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        ++captured_count_; ++crop_batches_;
        last_download_bytes_ = frame_provider.owned_download ? 0 : bytes;
        last_download_ms_ = (NowMono() - start) * 1000;
        last_crop_ms_ = 0;  // processing is now measured on the archive workers
      }
    }
  }
  if (captured) {
    for (size_t i = 0; i < total; ++i) {
      ArchiveJob job;
      job.archive_epoch = archive_epoch;
      bson_oid_init(&job.oid, nullptr);
      job.image_id = NewUuid4(); job.channel_id = channel_id; job.channel_name = channel_name;
      job.frame_pts_ns = frame_pts_ns; job.timestamp = timestamp; job.model_name = model_name;
      job.task_type = task_type; job.detection = stored_detections[i];
      if (point_records) job.point = points[i];
      job.crop_detection = crop_detections[i]; job.square = square_crop;
      job.config = crop_cfg; job.frame = captured;
      Track(job.image_id, "queued");
      std::unique_lock<std::mutex> lock(queue_mutex_);
      while (queue_.size() >= queue_maxsize_ && !cancelled()) {
        backpressured_.store(true);
        queue_cond_.wait_for(lock, std::chrono::milliseconds(100));
      }
      backpressured_.store(false);
      if (stop_event_.load() || (frame_provider.cancelled && frame_provider.cancelled())) {
        lock.unlock(); PreservePending(job);
      }
      else {
        // On hot disable, hand off the already owned frame's remaining targets
        // without doing disk I/O on inference. Only this serialized in-flight
        // offer may exceed the queue watermark; captured pixels remain bounded
        // by the existing two-frame/global budget. Later offers are gated off.
        queue_.push_back(std::move(job));
        lock.unlock(); queue_cond_.notify_one();
        std::lock_guard<std::mutex> stats_lock(stats_mutex_); ++enqueued_count_;
      }
    }
    return;
  }
  // No owned pixels were accepted while waiting for a capture slot.
  if (disabled()) return;
  for (size_t offset = 0; offset < total;) {
  size_t n = total - offset;
  const size_t dimension = std::clamp(snapshot_cfg.max_crop_dimension, 1, 4096);
  const size_t crop_batch_limit = std::max(size_t(1), (size_t(128) << 20) / (4 * dimension * dimension));
  const size_t accepted = std::min({n, queue_maxsize_, size_t(16), crop_batch_limit});
  if (accepted == 0) return;
  n = accepted;
  std::vector<cv::Mat> crops;
  double crop_start = NowMono();
  for (;;) {
  try {
    crops = cropper_.Crop(frame_provider,
        std::vector<Detection>(crop_detections.begin() + offset, crop_detections.begin() + offset + n),
        square_crop, crop_cfg);
    backpressured_.store(false);
    ClearArchiveFault("capture");
    break;
  } catch (const CropBatchBudgetError& e) {
    // Retry a smaller batch of the same frame, retaining every target.
    if (n > 1) { n = (n + 1) / 2; continue; }
    // A single target exceeding the bound is a configuration invariant failure.
    // Keep ownership and expose it instead of silently discarding the target.
    SetArchiveFault("capture", e.what());
    if (cancelled()) return;
    backpressured_.store(true);
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  } catch (const std::exception& e) {
    SetArchiveFault("capture", e.what());
    // Retry the same inferred frame, never skip it just to sustain inference FPS.
    // Invalid configuration remains an explicit error rather than an endless wait.
    const bool retry = !cancelled() && dynamic_cast<const std::invalid_argument*>(&e) == nullptr;
    {
      std::lock_guard<std::mutex> lock(stats_mutex_);
      ++crop_error_count_;
      if (!retry) {
        crop_failed_count_ += total - offset;
        dropped_count_ += total - offset;
      }
    }
    if (last_crop_failure_log_mono_ == 0 || NowMono() - last_crop_failure_log_mono_ >= 30) {
      last_crop_failure_log_mono_ = NowMono();
      log::Warning(kLogModule, "[" + channel_id_ + "] snapshot crop failed: " + e.what());
    }
    if (retry) {
      backpressured_.store(true);
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      continue;
    }
    log::Error(kLogModule, "[" + channel_id_ + "] CRITICAL snapshot capture abandoned targets=" +
               std::to_string(total - offset) + " before pixel ownership/cancellation: " + e.what());
    backpressured_.store(false);
    return;  // Archive failure must not tear down a healthy inference channel.
  }
  }
  double crop_ms = (NowMono() - crop_start) * 1000;
  {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    ++crop_batches_;
    last_download_bytes_ = cropper_.downloaded_bytes();
    last_download_ms_ = cropper_.download_ms();
    last_crop_ms_ = crop_ms;
    invalid_crop_count_ += cropper_.invalid_count();
  }
  if (last_crop_stats_log_mono_ == 0 || now - last_crop_stats_log_mono_ >= 60) {
    last_crop_stats_log_mono_ = now;
    AI_LOG(kInfo, kLogModule, "[" << channel_id_ << "] snapshot_crop targets=" << n
           << " source=" << frame_provider.size.width << "x" << frame_provider.size.height
           << " download_bytes=" << cropper_.downloaded_bytes()
           << " download_ms=" << cropper_.download_ms() << " crop_ms=" << crop_ms
           << " full_frame=" << cropper_.full_frame());
  }
  for (size_t i = 0; i < n; ++i) {
    cv::Mat crop = std::move(crops[i]);
    if (crop.empty()) {
      std::lock_guard<std::mutex> lock(stats_mutex_);
      ++dropped_count_;
      continue;
    }

    ArchiveJob job;
    job.archive_epoch = archive_epoch;
    bson_oid_init(&job.oid, nullptr);
    job.image_id = NewUuid4();
    job.channel_id = channel_id;
    job.channel_name = channel_name;
    job.frame_pts_ns = frame_pts_ns;
    job.timestamp = timestamp;
    job.model_name = model_name;
    job.task_type = task_type;
    job.detection = stored_detections[offset + i];
    if (point_records) job.point = points[offset + i];
    job.crop = crop;
    job.config = crop_cfg;
    Track(job.image_id, "queued");

    {
      std::unique_lock<std::mutex> lock(queue_mutex_);
      {
        while (queue_.size() >= queue_maxsize_ && !cancelled()) {
          backpressured_.store(true);
          queue_cond_.wait_for(lock, std::chrono::milliseconds(100));
        }
        backpressured_.store(false);
        if (stop_event_.load() || (frame_provider.cancelled && frame_provider.cancelled())) {
          lock.unlock();
          PreservePending(job);
          continue;
        }
      }
      queue_.push_back(std::move(job));
    }
    queue_cond_.notify_one();
    std::lock_guard<std::mutex> slock(stats_mutex_);
    enqueued_count_++;
  }
  offset += n;
  if (disabled()) break;
  }
}

// ---- 写入线程 ----

void SnapshotStore::SpoolLoop() {
  double last_failure=0;
  while(!stop_event_.load()) {
    ArchiveJob job;
    {
      std::unique_lock<std::mutex> lock(queue_mutex_);
      queue_cond_.wait_for(lock,std::chrono::milliseconds(200),[&]{
        return stop_event_.load() || (!connected_.load() && !queue_.empty());
      });
      if(stop_event_.load())break;
      if(connected_.load() || queue_.empty())continue;
      job=std::move(queue_.front());queue_.pop_front();
    }
    queue_cond_.notify_all();
    unsigned encode_failures = 0;
    for(;;) {
      try {
        // Release the shared capture as soon as its private crop exists.
        MaterializeCrop(job);
        SavePending(job);
        ++spooled_count_;spool_blocked_=false;
        break;
      } catch(const SnapshotEncodeError& e) {
        if (++encode_failures >= 3) {
          try { QuarantineJob(job,e.what()); break; }
          catch (const std::exception&) { spool_blocked_=true; }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
      } catch(const cv::Exception& e) {
        if (++encode_failures >= 3) {
          try { QuarantineJob(job,e.what()); break; }
          catch (const std::exception&) { spool_blocked_=true; }
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
      } catch(const std::exception& e) {
        spool_blocked_=true;
        if(last_failure==0 || NowMono()-last_failure>=30) {
          last_failure=NowMono();
          log::Error(kLogModule,"["+channel_id_+"] pending spool blocked; retained in memory: "+e.what());
        }
        if(stop_event_.load()){PreservePending(job);break;}
        if(connected_.load()) {
          std::lock_guard<std::mutex> lock(queue_mutex_);
          queue_.push_front(std::move(job));queue_cond_.notify_all();
          spool_blocked_=false;break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
      }
    }
  }
}

void SnapshotStore::PrepareNextBatch(std::vector<ArchiveJob>& batch, size_t limit) {
  batch.reserve(limit);
  while (batch.empty() && !stop_event_.load()) {
    std::string pending_file;
    {
      std::unique_lock<std::mutex> lock(queue_mutex_);
      queue_cond_.wait_for(lock, std::chrono::milliseconds(500), [this] {
        return stop_event_.load() || !pending_files_.empty() || !queue_.empty();
      });
      if (stop_event_.load()) return;
      if (!pending_files_.empty()) {
        pending_file = pending_files_.front();
        pending_files_.pop_front();
      } else if (!queue_.empty()) {
        batch.push_back(std::move(queue_.front()));
        queue_.pop_front();
      } else {
        return;
      }
    }
    queue_cond_.notify_all();
    if (!pending_file.empty()) {
      try {
        batch.push_back(ReadPending(pending_file));
        Track(batch.back().image_id, "preparing");
      }
      catch (const std::exception& e) {
        log::Error(kLogModule, "[" + channel_id_ + "] CRITICAL pending archive quarantined file=" + pending_file + ": " + e.what());
        try { QuarantinePending(pending_file); }
        catch (const std::exception& error) { log::Error(kLogModule, "pending quarantine rename failed: " + std::string(error.what())); }
        std::lock_guard<std::mutex> lock(stats_mutex_);
        ++write_error_count_; ++dropped_count_;
      }
    }
  }
  if (batch.empty()) return;
  {
    std::lock_guard<std::mutex> lock(queue_mutex_);
    while (batch.size() < limit && !queue_.empty()) {
      batch.push_back(std::move(queue_.front()));
      queue_.pop_front();
    }
  }
  queue_cond_.notify_all();
  PrepareBatch(batch);
}

void SnapshotStore::WriterLoop() {
  log::Info(kLogModule, "[" + channel_id_ + "] 识别快照写入线程已启动");
  int since_last_trim = 20; // Reconcile existing history once, including disabled startup.
  double last_probe = NowMono();
  double last_stats_log = 0;
  std::vector<ArchiveJob> retry;
  // At most one next batch (<=16 targets) may overlap the current durable write.
  // This coordinator is not a shared-pool worker: nested pool waits cannot
  // consume all of the workers needed to complete image processing.
  ArchiveBatch<ArchiveJob> ahead;
  auto trim = [&] {
    // Consume before reading config: a concurrent update remains requested.
    trim_requested_.exchange(false);
    try {
      PooledClient pc(pool_);
      ScopedCollection coll(pc.get(), db_name_, collection_name_);
      int64_t max_count;
      { std::lock_guard<std::mutex> lock(cfg_mutex_); max_count = cfg_.max_count; }
      const double start = NowMono();
      std::lock_guard<std::mutex> history_lock(history_mutex_);
      TrimHistory(coll.get(), max_count, history_count_);
      std::lock_guard<std::mutex> stats_lock(stats_mutex_);
      last_trim_ms_ = (NowMono() - start) * 1000;
      since_last_trim = 0;
    } catch (const std::exception& e) {
      trim_requested_.store(true);
      log::Error(kLogModule, "[" + channel_id_ + "] 识别快照淘汰失败: " + e.what());
    }
  };
  while (!stop_event_.load()) {
    // Detect an outage even when no detections are being archived. Keep database
    // I/O off /health and the inference thread; all timeouts are bounded.
    if (connected_.load() && NowMono() - last_probe >= 10.0) {
      TryConnect(false);
      last_probe = NowMono();
    }
    if (!connected_.load()) {
      TryConnect();
      if (!connected_.load()) {
        double delay;
        {
          std::lock_guard<std::mutex> lock(connect_mutex_);
          delay = reconnect_delay_s_;
        }
        double wait_end = NowMono() + delay;
        while (!stop_event_.load() && NowMono() < wait_end) {
          std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
        ScheduleReconnect();
        continue;
      }
      since_last_trim = 20; // A disconnected write may have committed before timing out.
      last_probe = NowMono();
    }

    std::vector<ArchiveJob> batch = std::move(retry);
    retry.clear();
    if (batch.empty()) {
      if (ahead.Pending()) {
        LogPreparationFailure(channel_id_, ahead.Join(), "archive preparation failed; owned jobs retained");
        batch = std::move(ahead.jobs);
        ahead.jobs.clear();
        prepared_ahead_targets_.store(0);
      } else {
        try {
          PrepareNextBatch(batch, static_cast<size_t>(std::min(16, 20 - (since_last_trim % 20))));
        } catch (...) {
          LogPreparationFailure(channel_id_, std::current_exception(), "serial preparation failed; owned jobs retained");
        }
      }
    }
    if (batch.empty()) {
      // The last partial batch must be trimmed even if capture was disabled or
      // the scene becomes empty. Otherwise the displayed count stays over limit.
      if (since_last_trim > 0 || trim_requested_.load()) trim();
      continue;
    }

      if (!ahead.Pending() && !stop_event_.load()) {
        const int projected = (since_last_trim + static_cast<int>(batch.size())) % 20;
        const size_t limit = static_cast<size_t>(std::min(16, 20 - projected));
        if (!ahead.Start([this, limit](auto& jobs) {
          PrepareNextBatch(jobs, limit);
          prepared_ahead_targets_.store(jobs.size());
        })) {
          LogPreparationFailure(channel_id_, ahead.Join(), "archive thread launch failed; using serial preparation");
        }
      }
    try {
      WriteBatch(batch);
      last_probe = NowMono();
      if (last_stats_log == 0 || last_probe - last_stats_log >= 60) {
        last_stats_log = last_probe;
        log::Info(kLogModule, "[" + channel_id_ + "] archive_pipeline " + GetStats().dump());
      }
      std::lock_guard<std::mutex> lock(stats_mutex_);
      written_count_ += batch.size();
      ++mongo_write_batches_;
      since_last_trim += batch.size();
    } catch (const SnapshotEncodeError& e) {
      log::Error(kLogModule, "[" + channel_id_ + "] 识别快照编码失败，保留待重试: " + e.what());
      { std::lock_guard<std::mutex> lock(stats_mutex_); write_error_count_++; }
      retry = std::move(batch);
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
      continue;
    } catch (const std::exception& e) {
      log::Error(kLogModule, "[" + channel_id_ + "] 识别快照写入失败: " + e.what());
      std::lock_guard<std::mutex> lock(stats_mutex_);
      write_error_count_++;
      connected_.store(false);
      std::lock_guard<std::mutex> clock(connect_mutex_);
      last_connect_error_ = e.what();
      retry = std::move(batch);
      continue;
    }

    if (since_last_trim >= 20 || !capture_enabled_.load() || trim_requested_.load()) trim();
  }
  // Normal shutdown preserves outstanding jobs, including an ambiguous Mongo
  // write. The original ObjectId makes replay safe if the server did commit it.
  LogPreparationFailure(channel_id_, ahead.Join(), "archive preparation failed during stop; owned jobs retained");
  prepared_ahead_targets_.store(0);
  for (const auto& job : ahead.jobs) PreservePending(job);
  ahead.jobs.clear();
  for (const auto& job : retry) PreservePending(job);
  std::deque<ArchiveJob> remaining;
  { std::lock_guard<std::mutex> lock(queue_mutex_); remaining.swap(queue_); }
  for (const auto& job : remaining) PreservePending(job);
  writer_running_.store(false);
  log::Info(kLogModule, "[" + channel_id_ + "] 识别快照写入线程已退出");
}


}  // namespace ai_service::output
