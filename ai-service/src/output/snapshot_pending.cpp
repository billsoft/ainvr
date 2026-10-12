#include "snapshot_internal.hpp"
#include <cstring>

namespace ai_service::output {
using namespace snapshot_detail;
void SnapshotStore::SavePending(const ArchiveJob& input, bool enqueue) {
  ArchiveJob j = input;
  MaterializeCrop(j);
  if (pending_dir_.empty()) {
    throw std::runtime_error("pending archive has no recovery directory");
  }
#ifdef AINVR_PENDING_PNG_TEST_ORACLE
  // Preserve the original legacy/error-fixture behavior in the CPU oracle.
  std::vector<uchar> png;
  if (!cv::imencode(".png", j.crop, png, {cv::IMWRITE_PNG_COMPRESSION, 1}))
    throw SnapshotEncodeError("pending PNG encoding failed");
#else
  // Durable recovery preserves exact RGBA pixels. Packing rows copies bytes;
  // it does not run a CPU image codec or change channel order/precision.
  if (j.crop.empty() || j.crop.type() != CV_8UC4 || j.crop.cols > 8192 ||
      j.crop.rows > 8192 || j.crop.total() * 4 > (size_t(128) << 20))
    throw SnapshotEncodeError("invalid pending RGBA dimensions or layout");
  std::vector<uint8_t> pixels(j.crop.total() * 4);
  const size_t row_bytes = size_t(j.crop.cols) * 4;
  for (int row = 0; row < j.crop.rows; ++row)
    std::memcpy(pixels.data() + size_t(row) * row_bytes, j.crop.ptr(row), row_bytes);
#endif
  char oid[25]; bson_oid_to_string(&j.oid, oid);
  json data = {{"oid", oid}, {"image_id", j.image_id}, {"channel_id", j.channel_id},
    {"channel_name", j.channel_name}, {"pts", j.frame_pts_ns}, {"timestamp", j.timestamp},
    {"archive_epoch", j.archive_epoch},
    {"model", j.model_name}, {"task", j.task_type}, {"class_id", j.detection.class_id},
    {"class_name", j.detection.class_name}, {"confidence", j.detection.confidence},
    {"bbox", j.detection.bbox}};
#ifdef AINVR_PENDING_PNG_TEST_ORACLE
  data["png"] = json::binary(png);
#else
  data["pixel_format"] = "rgba8";
  data["image_width"] = j.crop.cols; data["image_height"] = j.crop.rows;
  data["rgba"] = json::binary(pixels); data["pending_version"] = 3;
#endif
  if (!j.detection.confidence_known) data["confidence"] = nullptr;
  data["label_id"] = j.detection.label_id;
  data["query_description"] = j.detection.query_description;
  if (!j.detection.model_extra.empty()) data["model_extra"] = j.detection.model_extra;
  if (j.config) data["processing"] = {
      {"brightness_enabled", j.config->brightness_enabled},
      {"brightness_target", j.config->brightness_target},
      {"jpeg_quality", j.config->jpeg_quality},
      {"face_enhance_model", j.config->face_enhance_model},
      {"face_enhance_blend", j.config->face_enhance_blend}};
  if (j.detection.landmarks) data["landmarks"] = *j.detection.landmarks;
  auto bytes = json::to_cbor(data);
  std::lock_guard<std::mutex> io_lock(pending_io_mutex_);
  std::filesystem::create_directories(pending_dir_);
  auto target = std::filesystem::path(pending_dir_) / (j.image_id + ".cbor");
  const auto previous = pending_sizes_.count(j.image_id) ? pending_sizes_.at(j.image_id) : 0;
  if (!stop_event_.load() &&
      (pending_bytes_ - previous + quarantined_bytes_ + bytes.size() > (uintmax_t(1) << 30) ||
       std::filesystem::space(pending_dir_).available < (uintmax_t(5) << 30) + bytes.size()))
    throw std::runtime_error("pending archive capacity reached (1 GiB/channel, 5 GiB disk reserve)");
  auto tmp = target.string() + ".tmp";
  int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) throw std::runtime_error("cannot open pending archive");
  bool ok = true; size_t done = 0;
  while (done < bytes.size()) {
    auto n = ::write(fd, bytes.data() + done, bytes.size() - done);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { ok = false; break; }
    done += static_cast<size_t>(n);
  }
  if (::fsync(fd) != 0) ok = false;
  ::close(fd);
  if (!ok) throw std::runtime_error("cannot persist pending archive");
  std::filesystem::rename(tmp, target);
  fd = ::open(pending_dir_.c_str(), O_RDONLY | O_DIRECTORY);
  if (fd < 0) throw std::runtime_error("cannot open pending directory");
  ok = ::fsync(fd) == 0; ::close(fd);
  if (!ok) throw std::runtime_error("cannot sync pending directory");
  pending_bytes_ = pending_bytes_ - previous + bytes.size();
  pending_sizes_[j.image_id] = bytes.size();
  Track(j.image_id, "pending_disk");
  if (enqueue && !stop_event_.load()) {
    { std::lock_guard<std::mutex> lock(queue_mutex_); pending_files_.push_back(target.string()); }
    queue_cond_.notify_all();
  }
}

void SnapshotStore::PreservePending(const ArchiveJob& job) noexcept {
  double last_log = 0;
  for (;;) {
  try { SavePending(job); return; }
  catch (const std::exception& e) {
    if (last_log == 0 || NowMono() - last_log >= 30) {
    last_log = NowMono();
    log::Error(kLogModule, "[" + channel_id_ + "] CRITICAL shutdown waiting for pending persistence image=" +
               job.image_id + ": " + e.what());
    std::lock_guard<std::mutex> lock(stats_mutex_);
    ++write_error_count_;
    }
    spool_blocked_.store(true);
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
  }
}

void SnapshotStore::QuarantineJob(const ArchiveJob& job, const std::string& reason) {
  try {
    SavePending(job, false);
    const auto file = std::filesystem::path(pending_dir_) / (job.image_id + ".cbor");
    QuarantinePending(file.string());
  } catch (const std::exception& e) {
    log::Error(kLogModule, "[" + channel_id_ + "] CRITICAL cannot preserve failed image=" +
               job.image_id + ": " + e.what());
    throw SnapshotEncodeError("failed isolation; task retained: " + std::string(e.what()));
  }
  log::Error(kLogModule, "[" + channel_id_ + "] CRITICAL image quarantined image=" +
             job.image_id + ": " + reason);
  Finish(job.image_id, "quarantined");
  std::lock_guard<std::mutex> lock(stats_mutex_);
  ++write_error_count_;
}

void SnapshotStore::QuarantinePending(const std::string& name) {
  std::lock_guard<std::mutex> lock(pending_io_mutex_);
  const std::filesystem::path file(name);
  auto it = pending_sizes_.find(file.stem().string());
  if (std::filesystem::exists(file)) {
    const auto bad = name + ".bad";
    const auto previous = std::filesystem::exists(bad) ? std::filesystem::file_size(bad) : 0;
    const auto size = std::filesystem::file_size(file);
    std::filesystem::rename(file, bad);
    quarantined_bytes_ = quarantined_bytes_ - std::min(quarantined_bytes_, previous) + size;
  }
  if (it != pending_sizes_.end()) {
    pending_bytes_ -= it->second;
    pending_sizes_.erase(it);
  }
  Finish(file.stem().string(), "quarantined");
}

void SnapshotStore::LoadPending() {
  pending_files_.clear();
  pending_sizes_.clear(); pending_bytes_ = 0; quarantined_bytes_ = 0;
  if (pending_dir_.empty() || !std::filesystem::exists(pending_dir_)) return;
  for (const auto& f : std::filesystem::directory_iterator(pending_dir_)) {
    if (!f.is_regular_file()) continue;
    auto file = f.path();
    if (file.extension() == ".tmp" && file.stem().extension() == ".cbor") {
      // A crash between fsync and rename may leave a complete recoverable file.
      // Never silently erase incomplete evidence or replace an existing commit.
      auto target = file; target.replace_extension();
      try {
        ReadPending(file.string());
        if (std::filesystem::exists(target)) throw std::runtime_error("pending target already exists");
        std::filesystem::rename(file, target);
        file = target;
      } catch (const std::exception& e) {
        std::error_code error;
        std::filesystem::rename(file, file.string() + ".bad", error);
        log::Error(kLogModule, "[" + channel_id_ + "] CRITICAL pending temporary file quarantined: " + e.what());
        continue;
      }
    }
  }
  // Count after temporary-file recovery; .bad files still consume real space.
  // Restart must not silently reset the quarantine allowance.
  for (const auto& entry : std::filesystem::directory_iterator(pending_dir_)) {
    if (!entry.is_regular_file()) continue;
    const auto file = entry.path();
    if (file.extension() == ".bad") quarantined_bytes_ += entry.file_size();
    else if (file.extension() == ".cbor") {
      pending_files_.push_back(file.string());
      auto size=std::filesystem::file_size(file);
      pending_sizes_[file.stem().string()]=size; pending_bytes_+=size;
      Track(file.stem().string(), "pending_disk");
    }
  }
  std::sort(pending_files_.begin(), pending_files_.end());
}

SnapshotStore::ArchiveJob SnapshotStore::ReadPending(const std::string& file) {
  if (std::filesystem::file_size(file) > (uintmax_t(129) << 20))
    throw std::runtime_error("pending archive exceeds bounded recovery size");
  std::ifstream in(file, std::ios::binary);
  if (!in) throw std::runtime_error("cannot open pending archive");
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), {});
  if (in.bad()) throw std::runtime_error("cannot read pending archive");
  auto d = json::from_cbor(bytes);
  ArchiveJob j;
  auto oid = d.at("oid").get<std::string>();
  if (!IsObjectIdHex(oid)) throw std::runtime_error("invalid pending ObjectId");
  bson_oid_init_from_string(&j.oid, oid.c_str());
  j.image_id = d.at("image_id"); j.channel_id = d.at("channel_id");
  if (j.image_id.size() != 36 || j.image_id.find_first_not_of("0123456789abcdef-") != std::string::npos)
    throw std::runtime_error("invalid pending image id");
  auto identity = std::filesystem::path(file);
  if (identity.extension() == ".tmp") identity.replace_extension();
  if (identity.stem().string() != j.image_id) throw std::runtime_error("pending filename does not match image id");
  j.channel_name = d.at("channel_name"); j.frame_pts_ns = d.at("pts");
  j.timestamp = d.at("timestamp"); j.model_name = d.at("model"); j.task_type = d.at("task");
  j.archive_epoch = d.value("archive_epoch", uint64_t(0));
  j.detection.class_id = d.at("class_id"); j.detection.class_name = d.at("class_name");
  j.detection.confidence_known = !d.at("confidence").is_null();
  j.detection.confidence = j.detection.confidence_known ? d.at("confidence").get<double>() : 0.0;
  j.detection.label_id = d.value("label_id", std::string());
  j.detection.query_description = d.value("query_description", std::string());
  j.detection.model_extra = d.value("model_extra", json::object());
  j.detection.bbox = d.at("bbox").get<std::array<double, 4>>();
  if (d.contains("landmarks")) j.detection.landmarks = d.at("landmarks").get<std::vector<std::array<double, 2>>>();
  if (j.channel_id != channel_id_) throw std::runtime_error("invalid pending channel");
  if (d.contains("rgba")) {
    const int width = d.at("image_width"), height = d.at("image_height");
    if (d.value("pending_version", 0) != 3 || d.at("pixel_format") != "rgba8" ||
        width <= 0 || height <= 0 || width > 8192 || height > 8192 ||
        size_t(width) * size_t(height) * 4 > (size_t(128) << 20))
      throw std::runtime_error("invalid pending RGBA dimensions or layout");
    const auto& pixels = d.at("rgba").get_binary();
    if (pixels.size() != size_t(width) * size_t(height) * 4)
      throw std::runtime_error("pending RGBA byte count does not match dimensions");
    j.crop.create(height, width, CV_8UC4);
    std::memcpy(j.crop.data, pixels.data(), pixels.size());
  } else {
#ifdef AINVR_PENDING_PNG_TEST_ORACLE
    // Legacy fixtures exercise the original codec only in the CPU oracle.
    const auto& png = d.at("png").get_binary();
    j.crop = cv::imdecode(std::vector<uchar>(png.begin(), png.end()), cv::IMREAD_UNCHANGED);
#else
    // Keep legacy bytes in quarantine rather than silently decoding on CPU.
    // Existing files require an explicit offline format conversion.
    throw std::runtime_error("legacy PNG pending archive requires offline RGBA migration; bytes retained");
#endif
  }
  if (j.crop.empty() || j.channel_id != channel_id_) throw std::runtime_error("invalid pending image");
  if (d.contains("processing")) {
    config::SnapshotConfig c;
    const auto& p = d.at("processing");
    c.brightness_enabled = p.at("brightness_enabled");
    c.brightness_target = p.at("brightness_target");
    c.jpeg_quality = p.at("jpeg_quality");
    c.face_enhance_model = p.at("face_enhance_model");
    c.face_enhance_blend = p.at("face_enhance_blend");
    j.config = c;
  }
  return j;
}

void SnapshotStore::DeletePending(const std::string& channel_id) {
  std::filesystem::remove_all(PendingDirectory(channel_id));
}

std::string SnapshotStore::PendingDirectory(const std::string& channel_id) {
  if (channel_id.empty() || channel_id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != std::string::npos)
    throw std::invalid_argument("invalid channel id");
  return (std::filesystem::path("data/snapshot-pending") / channel_id).string();
}

void SnapshotStore::UpdateConfig(const config::SnapshotConfig& cfg) {
  {
    std::lock_guard<std::mutex> lock(cfg_mutex_);
    if (cfg_.max_count != cfg.max_count) trim_requested_.store(true);
    cfg_ = cfg;
    capture_enabled_.store(cfg.enabled);
    if (!cfg.enabled) capture_epoch_.fetch_add(1);
  }
  queue_cond_.notify_all();
  Captures().changed.notify_all();
}

// ---- 推理线程调用(热路径) ----

void SnapshotStore::RemovePending(const std::string& image_id) {
  if(pending_dir_.empty()) return;
  std::lock_guard<std::mutex> lock(pending_io_mutex_);
  std::filesystem::remove(std::filesystem::path(pending_dir_)/(image_id+".cbor"));
  auto it=pending_sizes_.find(image_id);
  if(it!=pending_sizes_.end()){pending_bytes_-=it->second;pending_sizes_.erase(it);}
}


}  // namespace ai_service::output
