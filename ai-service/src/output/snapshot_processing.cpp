#include "snapshot_internal.hpp"
#include "face_enhancer.hpp"
#include "exposure.hpp"
#include "snapshot_jpeg.hpp"

namespace ai_service::output {
using namespace snapshot_detail;
void SnapshotStore::PrepareBatch(std::vector<ArchiveJob>& jobs) {
  for (const auto& job : jobs) Track(job.image_id, "preparing");
  struct PreparingScope {
    std::atomic<size_t>& count;
    size_t size;
    ~PreparingScope() { count.fetch_sub(size); }
  } preparing_scope{preparing_targets_, jobs.size()};
  preparing_targets_.fetch_add(jobs.size());
  const double prepare_start = NowMono();
  std::vector<std::future<void>> work;
  work.reserve(jobs.size());
  std::exception_ptr failure;
  std::vector<std::string> errors(jobs.size());
  try {
    for (size_t i = 0; i < jobs.size(); ++i) {
      work.push_back(SharedArchiveExecutor().Submit([this, &jobs, &errors, i] {
        for (unsigned attempt = 0; attempt < 3; ++attempt) {
          try { PrepareImage(jobs[i]); errors[i].clear(); return; }
          catch (const std::exception& e) {
            errors[i] = e.what();
            if (attempt < 2) std::this_thread::sleep_for(std::chrono::milliseconds(100));
          }
        }
      }));
    }
  } catch (...) { failure = std::current_exception(); }
  // Even after an error, join all workers before moving/destroying the batch.
  for (auto& future : work) {
    try { future.get(); } catch (...) { if (!failure) failure = std::current_exception(); }
  }
  if (failure) {
    try { std::rethrow_exception(failure); }
    catch (const std::exception& e) { throw SnapshotEncodeError(e.what()); }
    catch (...) { throw SnapshotEncodeError("non-standard archive preparation exception; tasks retained"); }
  }
  // A permanently bad target cannot prevent healthy targets in the same batch
  // from reaching Mongo. Keep recoverable bytes for inspection/manual replay.
  for (size_t i = jobs.size(); i-- > 0;) {
    if (!errors[i].empty()) {
      SetArchiveFault("processing", errors[i]);
      QuarantineJob(jobs[i], errors[i]);
      jobs.erase(jobs.begin() + i);
    }
  }
  const auto bad = std::find_if(errors.begin(), errors.end(), [](const auto& error) { return !error.empty(); });
  if (bad != errors.end()) SetArchiveFault("processing", *bad);
  else ClearArchiveFault("processing");
  if (jobs.empty()) return;
  std::lock_guard<std::mutex> lock(stats_mutex_);
  last_prepare_ms_ = (NowMono() - prepare_start) * 1000;
}

void SnapshotStore::MaterializeCrop(ArchiveJob& job) {
  if (!job.crop.empty()) return;
  if (!job.frame || !job.config) throw SnapshotEncodeError("missing captured snapshot frame");
  SnapshotCropper cropper;
  FrameProvider provider{job.frame->rgba.size(), [&job](const cv::Rect& roi, cv::Mat& dst) {
    // The immutable capture stays owned by this job until cropping completes.
    // A shallow view is safe here; Crop always returns independent target pixels.
    dst = job.frame->rgba(roi);
  }};
  auto crops = cropper.Crop(provider, {job.crop_detection}, job.square, *job.config);
  if (crops.empty() || crops[0].empty()) throw SnapshotEncodeError("captured target crop is empty");
  job.crop = std::move(crops[0]);
  job.frame.reset();
}

void SnapshotStore::PrepareImage(ArchiveJob& job) {
  if (!job.jpeg.empty()) return;  // Mongo retry must not repeat image processing.
  const double crop_start = NowMono();
  MaterializeCrop(job);
  if (job.crop.empty() || job.crop.type() != CV_8UC4)
    throw SnapshotEncodeError("snapshot crop must be nonempty 8-bit RGBA");
#ifdef AINVR_ARCHIVE_JPU
  // Tiny targets keep their original pixels; GLES extends the minimum canvas
  // before both original JPEG and enhancement. Metadata uses actual dimensions.
  job.crop = EnsureSnapshotJpuCanvas(job.crop);
#endif
  const double crop_end = NowMono();
  cv::Mat crop = job.crop;
  bool enhanced = false;
  std::string enhance_model;
  bool brightness_applied = false;

  config::SnapshotConfig cfg_snapshot;
  if (job.config) cfg_snapshot = *job.config;
  else {
    std::lock_guard<std::mutex> lock(cfg_mutex_);
    cfg_snapshot = cfg_;
  }

  // Keep the uncorrected crop for future matching and audit. Never treat GPEN's
  // generated detail as the sole evidence. Both variants share the same document
  // and are deleted atomically by existing rolling/channel cleanup.
  if (job.original_jpeg.empty()) {
    if (!EncodeSnapshotRgbaJpeg(job.crop, job.original_jpeg, cfg_snapshot.jpeg_quality))
      throw SnapshotEncodeError("original JPEG encoding failed");
  }

  const double brightness_start = NowMono();
  // Brightness correction precedes enhancement. Keep the original crop for
  // recovery if a configured transform fails.
  if (cfg_snapshot.brightness_enabled) {
    try {
      crop = CorrectExposureRgba(crop, static_cast<double>(cfg_snapshot.brightness_target));
      brightness_applied = true;
      std::lock_guard<std::mutex> lock(stats_mutex_);
      brightness_count_++;
    } catch (const std::exception& e) {
      std::lock_guard<std::mutex> lock(stats_mutex_);
      brightness_error_count_++;
      throw SnapshotEncodeError("configured brightness processing failed: " + std::string(e.what()));
    }
  }

  const double brightness_end = NowMono();
  // 人脸修复:仅人脸检测通道 + 选了模型 + 宽高都 < 模型画布尺寸才走。
  if (job.task_type == "face_detection" &&
      (cfg_snapshot.face_enhance_model == "gpen" || cfg_snapshot.face_enhance_model == "codeformer")) {
    const auto& spec = FaceEnhanceModelSpecs().at(cfg_snapshot.face_enhance_model);
    std::string engine_path = cfg_snapshot.face_enhance_model == "gpen"
                                  ? face_enhance_engine_path_
                                  : face_enhance_codeformer_engine_path_;
    if (ShouldEnhance(crop.cols, crop.rows, spec.size)) {
      try {
        if (engine_path.empty()) throw std::runtime_error("missing enhancement engine");
        auto enhancer = GetFaceEnhancer(cfg_snapshot.face_enhance_model, engine_path);
        crop = enhancer->EnhanceRgba(crop, cfg_snapshot.face_enhance_blend);
        enhanced = true;
        enhance_model = spec.name;
        std::lock_guard<std::mutex> lock(stats_mutex_);
        enhanced_count_++;
      } catch (const std::exception& e) {
        std::lock_guard<std::mutex> lock(stats_mutex_);
        enhance_error_count_++;
        throw SnapshotEncodeError("configured enhancement failed: " + std::string(e.what()));
      }
    }
  }

  const double enhancement_end = NowMono();
  // Preserve RGBA through processing. GPU converts channel order, BT.601 color
  // and chroma; JPU receives NV12. Never pass RGBA bytes to a BGR encoder.
  std::vector<uchar> jpeg_buf;
  if (!EncodeSnapshotRgbaJpeg(crop, jpeg_buf, cfg_snapshot.jpeg_quality)) {
    throw SnapshotEncodeError("JPEG 编码失败");
  }

  job.image_width = crop.cols; job.image_height = crop.rows;
  job.enhanced = enhanced; job.brightness_applied = brightness_applied;
  job.enhance_model = std::move(enhance_model);
  job.jpeg = std::move(jpeg_buf);
  std::lock_guard<std::mutex> stats_lock(stats_mutex_);
  ++prepared_count_;
  crop_processing_ms_ += (crop_end - crop_start) * 1000;
  brightness_ms_ += (brightness_end - brightness_start) * 1000;
  enhancement_ms_ += (enhancement_end - brightness_end) * 1000;
  encoding_ms_ += ((brightness_start - crop_end) + (NowMono() - enhancement_end)) * 1000;
}


}  // namespace ai_service::output
