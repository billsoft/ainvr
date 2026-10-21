#include "snapshot_internal.hpp"
#include "face_enhancer.hpp"
#include "exposure.hpp"
#include "snapshot_jpeg.hpp"

namespace ai_service::output {
using namespace snapshot_detail;
std::string NewUuid4() {
  // 每线程一个由 random_device 播种的 64 位引擎:推理线程(Offer)热路径上
  // 不加锁、不每次读 /dev/urandom。
  thread_local std::mt19937_64 rng{[] {
    std::random_device rd;
    std::seed_seq seq{rd(), rd(), rd(), rd(), rd(), rd(), rd(), rd()};
    return std::mt19937_64(seq);
  }()};
  uint64_t hi = rng();
  uint64_t lo = rng();
  hi = (hi & 0xFFFFFFFFFFFF0FFFULL) | 0x0000000000004000ULL;  // version 4
  lo = (lo & 0x3FFFFFFFFFFFFFFFULL) | 0x8000000000000000ULL;  // variant 10xx
  char buf[37];
  std::snprintf(buf, sizeof(buf), "%08x-%04x-%04x-%04x-%012llx",
                static_cast<unsigned>(hi >> 32), static_cast<unsigned>((hi >> 16) & 0xFFFF),
                static_cast<unsigned>(hi & 0xFFFF), static_cast<unsigned>(lo >> 48),
                static_cast<unsigned long long>(lo & 0xFFFFFFFFFFFFULL));
  return buf;
}

// ---- SnapshotStore ----

SnapshotStore::SnapshotStore(config::SnapshotConfig initial_cfg, std::string mongo_uri,
                              std::string db_name, std::string channel_id,
                              std::string channel_name, std::string face_enhance_engine_path,
                              std::string face_enhance_codeformer_engine_path,
                              size_t queue_maxsize, bool preload_face_enhancer, std::string pending_dir)
    : cfg_(std::move(initial_cfg)),
      mongo_uri_(std::move(mongo_uri)),
      db_name_(std::move(db_name)),
      channel_id_(std::move(channel_id)),
      channel_name_(std::move(channel_name)),
      face_enhance_engine_path_(std::move(face_enhance_engine_path)),
      face_enhance_codeformer_engine_path_(std::move(face_enhance_codeformer_engine_path)),
      queue_maxsize_(std::max(size_t(1), queue_maxsize)),
      preload_face_enhancer_(preload_face_enhancer),
      collection_name_("snapshots_" + channel_id_) {
  EnsureMongocInit();
  pending_dir_ = std::move(pending_dir);
  capture_enabled_.store(cfg_.enabled);
}

SnapshotStore::~SnapshotStore() { Stop(); }

void SnapshotStore::Track(const std::string& id, const std::string& stage) {
  std::lock_guard<std::mutex> lock(ledger_mutex_);
  auto [it, inserted] = outstanding_.try_emplace(id, TrackedJob{stage, NowMono()});
  if (inserted) ++accepted_targets_;
  it->second.stage = stage;
}

void SnapshotStore::Finish(const std::string& id, const std::string& outcome) {
  std::lock_guard<std::mutex> lock(ledger_mutex_);
  const auto it=outstanding_.find(id);
  if(it==outstanding_.end()) return;
  const double latency_ms=std::max(0.0,(NowMono()-it->second.since)*1000.0);
  outstanding_.erase(it);
  if (outcome == "committed") {
    ++committed_targets_;
    committed_latency_sum_ms_+=latency_ms;
    committed_latency_max_ms_=std::max(committed_latency_max_ms_,latency_ms);
    recent_committed_latency_ms_.push_back(latency_ms);
    if(recent_committed_latency_ms_.size()>256)recent_committed_latency_ms_.pop_front();
  }
  else if (outcome == "quarantined") ++quarantined_targets_;
  else ++deleted_targets_;
}

void SnapshotStore::SetArchiveFault(const std::string& stage, const std::string& message) {
  std::lock_guard<std::mutex> lock(fault_mutex_);
  auto [it, inserted] = archive_faults_.try_emplace(stage, ArchiveFault{message, NowMono()});
  it->second.message = message;
}

void SnapshotStore::ClearArchiveFault(const std::string& stage) {
  std::lock_guard<std::mutex> lock(fault_mutex_);
  archive_faults_.erase(stage);
}

void SnapshotStore::WaitForCapacity(const std::function<bool()>& cancelled) {
  const auto epoch = capture_epoch_.load();
  auto& captures = Captures();
  while (capture_enabled_.load() && capture_epoch_.load() == epoch &&
         !stop_event_.load() && !cancelled()) {
    {
      std::unique_lock<std::mutex> lock(queue_mutex_);
      if (queue_.size() >= queue_maxsize_) {
        backpressured_.store(true);
        queue_cond_.wait_for(lock, std::chrono::milliseconds(100));
        continue;
      }
    }
    // Frame release signals Captures.changed, not queue_cond_. Waiting on the
    // queue condition here used to sleep until the 100ms timeout even when
    // archive workers had already released all owned source frames.
    std::unique_lock<std::mutex> lock(captures.mutex);
    if (captured_frames_->load() < 2) break;
    backpressured_.store(true);
    captures.changed.wait_for(lock, std::chrono::milliseconds(100));
  }
  backpressured_.store(false);
}

void SnapshotStore::ReserveForFrame(cv::Size size) {
  if (!capture_enabled_.load()) return;
  if (size.width <= 0 || size.height <= 0 || size.width >= 32767 || size.height >= 32767)
    throw std::invalid_argument("invalid archive source dimensions");
  capacity_->Configure(size_t(size.width) * size.height * 4);
}

void SnapshotStore::Start(bool keep_history_access) {
  if (thread_.joinable()) return;
  if (!cfg_.enabled && !keep_history_access) return;
  deletions_.Load(pending_dir_);
  applied_deletion_epoch_ = 0;

  bson_error_t error;
  uri_ = mongoc_uri_new_with_error(mongo_uri_.c_str(), &error);
  if (!uri_) {
    std::lock_guard<std::mutex> lock(connect_mutex_);
    last_connect_error_ = "mongo_uri 解析失败: " + BsonErrorMessage(error);
    connected_.store(false);
  } else {
    // v1 用 serverSelectionTimeoutMS=5000;libmongoc 默认 30s——连不上时
    // 写入线程会卡在 ping 里长达 30s,Stop() 也要跟着等。URI 显式写了就尊重。
    if (!mongoc_uri_has_option(uri_, MONGOC_URI_SERVERSELECTIONTIMEOUTMS)) {
      mongoc_uri_set_option_as_int32(uri_, MONGOC_URI_SERVERSELECTIONTIMEOUTMS, 5000);
    }
    // Bound connect and socket waits too: server selection alone does not
    // bound an established connection whose server stops responding.
    if (!mongoc_uri_has_option(uri_, MONGOC_URI_CONNECTTIMEOUTMS)) {
      mongoc_uri_set_option_as_int32(uri_, MONGOC_URI_CONNECTTIMEOUTMS, 5000);
    }
    if (!mongoc_uri_has_option(uri_, MONGOC_URI_SOCKETTIMEOUTMS)) {
      mongoc_uri_set_option_as_int32(uri_, MONGOC_URI_SOCKETTIMEOUTMS, 15000);
    }
    pool_ = mongoc_client_pool_new(uri_);
    TryConnect();
  }

  // Preload exposes configuration faults early. A failed configured transform
  // is retried/quarantined, never reported as successfully processed.
  std::string model = cfg_.face_enhance_model;
  if (cfg_.enabled && preload_face_enhancer_ && (model == "gpen" || model == "codeformer")) {
    std::string engine_path =
        model == "gpen" ? face_enhance_engine_path_ : face_enhance_codeformer_engine_path_;
    {
      try {
        if (engine_path.empty()) throw std::runtime_error("configured face enhancement engine path is empty");
        auto enhancer = GetFaceEnhancer(model, engine_path);
        enhancer->EnsureLoaded();
      } catch (const std::exception& e) {
        SetArchiveFault("processing", e.what());
        log::Error(kLogModule, "[" + channel_id_ +
                                   "] 人脸增强 engine 预加载失败(归档将重试或隔离，请修复模型配置): " +
                                   e.what());
      }
    }
  }

  LoadPending();
  stop_event_.store(false);
  writer_running_.store(true);
  thread_ = std::thread([this] { WriterLoop(); });
  try { spool_thread_ = std::thread([this] { SpoolLoop(); }); }
  catch (...) { RequestStop(); thread_.join(); throw; }
}

void SnapshotStore::RequestStop() {
  stop_event_.store(true);
  queue_cond_.notify_all();
  Captures().changed.notify_all();
}

void SnapshotStore::QuiesceWriter() {
  RequestStop();
  std::lock_guard<std::mutex> join_lock(join_mutex_);
  if (spool_thread_.joinable()) spool_thread_.join();
  if (thread_.joinable()) thread_.join();
  // Old HTTP readers may retain this store after a channel restart. They must
  // not retain admission quota once all owned jobs have drained.
  std::lock_guard<std::mutex> offer_lock(offer_mutex_);
  if (captured_frames_->load() == 0) capacity_->Release();
}

void SnapshotStore::Stop() {
  QuiesceWriter();
  if (pool_) {
    mongoc_client_pool_destroy(pool_);
    pool_ = nullptr;
  }
  if (uri_) {
    mongoc_uri_destroy(uri_);
    uri_ = nullptr;
  }
}

bool SnapshotStore::TryConnect(bool ensure_indexes) {
  if (!pool_) return false;
  try {
    PooledClient pc(pool_);
    bson_t* ping = bson_new_from_json(reinterpret_cast<const uint8_t*>("{\"ping\": 1}"), -1, nullptr);
    bson_t reply;
    bson_error_t error;
    bool ok = mongoc_client_command_simple(pc.get(), "admin", ping, nullptr, &reply, &error);
    bson_destroy(ping);
    bson_destroy(&reply);  // libmongoc 约定:失败时 reply 也已初始化,同样要释放
    if (!ok) {
      std::lock_guard<std::mutex> lock(connect_mutex_);
      last_connect_error_ = BsonErrorMessage(error);
      connected_.store(false);
      return false;
    }

    if (ensure_indexes) {
    // 索引确保存在(createIndexes 命令,幂等——已存在同名索引不报错)。
    ScopedCollection coll(pc.get(), db_name_, collection_name_);
    std::string idx_cmd = "{\"createIndexes\": \"" + collection_name_ +
                          "\", \"indexes\": [{\"key\": {\"timestamp\": 1}, \"name\": \"timestamp_1\"},"
                          "{\"key\": {\"image_id\": 1}, \"name\": \"image_id_1\"},"
                          "{\"key\": {\"track_id\": 1, \"frame_pts_ns\": 1}, \"name\": \"observation_evidence_1\"}]}";
    bson_t* cmd = bson_new_from_json(reinterpret_cast<const uint8_t*>(idx_cmd.c_str()), -1, nullptr);
    bson_t idx_reply;
    bool idx_ok =
        mongoc_client_command_simple(pc.get(), db_name_.c_str(), cmd, nullptr, &idx_reply, &error);
    bson_destroy(&idx_reply);
    bson_destroy(cmd);
    // v1 create_index 失败会让本次连接判失败并进入退避重连;这里同语义,
    // 不能"连接正常但缺索引"地静默跑下去(比如账号没有建索引权限)。
    if (!idx_ok) {
      std::lock_guard<std::mutex> lock(connect_mutex_);
      last_connect_error_ = "创建识别历史索引失败: " + BsonErrorMessage(error);
      connected_.store(false);
      return false;
    }

    }
    if (ensure_indexes) {
      std::lock_guard<std::mutex> history_lock(history_mutex_);
      ScopedCollection history(pc.get(), db_name_, collection_name_);
      ApplyDeletionRules(history.get());
    }
    std::lock_guard<std::mutex> lock(connect_mutex_);
    connected_.store(true);
    last_connect_error_.reset();
    reconnect_delay_s_ = kReconnectInitialSeconds;
    return true;
  } catch (const std::exception& e) {
    std::lock_guard<std::mutex> lock(connect_mutex_);
    last_connect_error_ = e.what();
    connected_.store(false);
    return false;
  }
}

void SnapshotStore::ScheduleReconnect() {
  std::lock_guard<std::mutex> lock(connect_mutex_);
  reconnect_delay_s_ = std::min(reconnect_delay_s_ * kReconnectBackoffFactor, kReconnectMaxSeconds);
}

json SnapshotStore::GetStats() const {
  json ledger;
  {
    std::lock_guard<std::mutex> lock(ledger_mutex_);
    json stages = json::object();
    double oldest = 0;
    for (const auto& [id, item] : outstanding_) {
      stages[item.stage] = stages.value(item.stage, size_t(0)) + 1;
      oldest = std::max(oldest, NowMono() - item.since);
    }
    auto sorted=recent_committed_latency_ms_;
    std::sort(sorted.begin(),sorted.end());
    const double p95=sorted.empty()?0:sorted[(sorted.size()*95+99)/100-1];
    ledger = {{"admission_to_commit", {{"count",committed_targets_},
              {"mean_ms",committed_targets_?committed_latency_sum_ms_/committed_targets_:0},
              {"max_ms",committed_latency_max_ms_},{"recent_p95_ms",p95},
              {"recent_count",sorted.size()}}}, {"accepted", accepted_targets_}, {"committed", committed_targets_},
              {"quarantined", quarantined_targets_}, {"deleted", deleted_targets_},
              {"outstanding", outstanding_.size()}, {"stages", stages},
              {"oldest_wait_seconds", oldest}};
  }
  json faults = json::array();
  {
    std::lock_guard<std::mutex> lock(fault_mutex_);
    for (const auto& [stage, fault] : archive_faults_)
      faults.push_back({{"stage", stage}, {"message", fault.message},
                        {"duration_seconds", std::max(0.0, NowMono() - fault.since)}});
  }
  const auto pending_bytes = pending_bytes_.load(std::memory_order_relaxed);
  const auto quarantined_bytes = quarantined_bytes_.load(std::memory_order_relaxed);
  bool enabled;
  {
    std::lock_guard<std::mutex> lock(cfg_mutex_);
    enabled = cfg_.enabled;
  }
  size_t queue_depth;
  {
    std::lock_guard<std::mutex> lock(queue_mutex_);
    queue_depth = queue_.size() + pending_files_.size();
  }
  std::lock_guard<std::mutex> lock(stats_mutex_);
  // Failed captures never owned image pixels, so cannot honestly be labelled
  // committed or quarantined. Expose them separately from accepted-job balance.
  ledger["capture_failed"] = crop_failed_count_;
  ledger["attempted"] = ledger["accepted"].get<uint64_t>() + crop_failed_count_;
  return json{
      {"enabled", enabled},
      {"delivery", ledger},
      {"faults", faults},
      {"healthy", faults.empty()},
      {"has_quarantined_data", quarantined_bytes != 0},
      {"writer_running", writer_running_.load()},
      {"connected", connected_.load()},
      {"enqueued_count", enqueued_count_},
      {"dropped_count", dropped_count_},
      {"written_count", written_count_},
      {"mongo_write_batches", mongo_write_batches_},
      {"write_error_count", write_error_count_},
      {"enhanced_count", enhanced_count_},
      {"enhance_error_count", enhance_error_count_},
      {"brightness_corrected_count", brightness_count_},
      {"brightness_error_count", brightness_error_count_},
      {"queue_depth", queue_depth},
      {"backpressured", backpressured_.load()},
      {"spooled_count", spooled_count_.load()},
      {"spool_blocked", spool_blocked_.load()},
      {"pending_bytes", pending_bytes},
      {"quarantined_bytes", quarantined_bytes},
      {"preparing_targets", preparing_targets_.load()},
      {"prepared_ahead_targets", prepared_ahead_targets_.load()},
      {"crop_batches", crop_batches_},
      {"crop_error_count", crop_error_count_},
      {"crop_failed_count", crop_failed_count_},
      {"invalid_crop_count", invalid_crop_count_},
      {"budget_drop_count", 0},
      {"queue_full_drop_count", 0},
      {"last_download_bytes", last_download_bytes_},
      {"last_download_ms", last_download_ms_},
      {"last_crop_ms", last_crop_ms_},
      {"captured_frames", captured_frames_->load()},
      {"capture_reserved_bytes", capacity_->Reserved()},
      {"captured_count", captured_count_},
      {"jpeg_process_wide", [] {
        const auto stats=GetSnapshotJpegStats();
        json result={{"scope","process"},{"jpu",stats.jpu},{"failures",stats.failures},
          {"encoder_creates",stats.encoder_creates},{"encoder_reuses",stats.encoder_reuses}};
        const char* names[]={"input_copy","admission_wait","conversion_queue_wait","conversion","encoder_queue_wait","encoder_setup","jpu_encode"};
        for(size_t i=0;i<stats.timings.size();++i){const auto& t=stats.timings[i];
          result["stages"][names[i]]={{"count",t.count},{"total_ms",t.total_ns/1e6},
            {"mean_ms",t.count?t.total_ns/1e6/t.count:0.0},{"max_ms",t.max_ns/1e6}};}
        return result;
      }()},
      {"archive_workers", ArchiveWorkerCount()},
      {"last_prepare_ms", last_prepare_ms_},
      {"last_mongo_ms", last_mongo_ms_},
      {"mongo_max_ms", mongo_max_ms_},
      {"mongo_slow_batches", mongo_slow_batches_},
      {"last_history_wait_ms", last_history_wait_ms_},
      {"last_trim_ms", last_trim_ms_},
      {"prepared_count", prepared_count_},
      {"crop_mean_ms", prepared_count_ ? crop_processing_ms_ / prepared_count_ : 0},
      {"brightness_mean_ms", prepared_count_ ? brightness_ms_ / prepared_count_ : 0},
      {"enhancement_mean_ms", prepared_count_ ? enhancement_ms_ / prepared_count_ : 0},
      {"encoding_mean_ms", prepared_count_ ? encoding_ms_ / prepared_count_ : 0},
  };
}


}  // namespace ai_service::output
