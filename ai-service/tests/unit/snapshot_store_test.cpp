// 对应 Python output/snapshot_store.py。CropWithPadding 对照 v1 真实算法
// 的 golden fixture;SnapshotStore 端到端测试用独立的测试 channel id
// (test-ai-service-snapshot-store,不是任何生产通道)连真实 Mongo 实例;每个用例
// 结束 Clear(),整个测试进程结束时 drop 掉测试集合,不在 ai_snapshots 里留垃圾。
#include <gtest/gtest.h>

#include <chrono>
#include <cstdlib>
#include <fstream>
#include <future>
#include <filesystem>
#include <mutex>
#include <regex>
#include <set>
#include <thread>
#include <limits>
#include <opencv2/imgproc.hpp>
#ifdef AINVR_CUDA_REFERENCE_TESTS
#include <opencv2/core/cuda.hpp>
#endif
#include <opencv2/imgcodecs.hpp>

#include <nlohmann/json.hpp>

#include "../../src/output/snapshot_store.hpp"
#include "../../src/output/snapshot_jpeg.hpp"
#include "../../src/output/snapshot_internal.hpp"
#include "../../src/output/archive_executor.hpp"
#include "../../src/output/archive_batch.hpp"
#include "../../src/output/grounding_snapshot.hpp"
#ifdef AINVR_CUDA_REFERENCE_TESTS
#include "../../src/output/gpu_image.hpp"
#endif
#ifdef AINVR_CUDA_REFERENCE_TESTS
#include "../../src/output/snapshot_download.hpp"
#endif
#ifdef AINVR_CUDA_REFERENCE_TESTS
#include <opencv2/cudaimgproc.hpp>
#endif
#ifdef AINVR_CUDA_REFERENCE_TESTS
#include <cuda_runtime.h>
#endif

using namespace ai_service;
using namespace ai_service::output;
using nlohmann::json;

TEST(SnapshotArchiveBatch, PreparationExceptionKeepsOwnedJobsAndAllowsNextBatch) {
  ArchiveBatch<int> batch;
  ASSERT_TRUE(batch.Start([](auto& jobs) {
    jobs.push_back(42);
    throw std::bad_alloc();
  }));
  std::exception_ptr error;
  EXPECT_NO_THROW(error = batch.Join());
  EXPECT_TRUE(error);
  EXPECT_EQ(batch.jobs, std::vector<int>({42}));
  EXPECT_FALSE(batch.Pending());
  batch.jobs.clear();
  ASSERT_TRUE(batch.Start([](auto& jobs) { jobs.push_back(43); }));
  EXPECT_FALSE(batch.Join());
  EXPECT_EQ(batch.jobs, std::vector<int>({43}));
}

TEST(SnapshotArchiveBatch, ThreadLaunchFailureReturnsToCallerWithoutLosingJobs) {
  ArchiveBatch<int> batch;
  batch.jobs.push_back(42);
  bool started = true;
  EXPECT_NO_THROW(started = batch.Start([](auto&) {}, [](auto) -> std::future<void> {
    throw std::system_error(std::make_error_code(std::errc::resource_unavailable_try_again));
  }));
  EXPECT_FALSE(started);
  EXPECT_FALSE(batch.Pending());
  EXPECT_EQ(batch.jobs, std::vector<int>({42}));
  EXPECT_TRUE(batch.Join());
  // The caller can continue serially with the same owned data.
  batch.jobs.push_back(43);
  EXPECT_EQ(batch.jobs.size(), 2);
}

TEST(SnapshotArchiveBatch, StopJoinsNonstandardExceptionBeforeDestroyingJobs) {
  std::promise<void> started;
  std::promise<void> release;
  auto ready = release.get_future().share();
  std::atomic<bool> finished{false};
  auto batch = std::make_unique<ArchiveBatch<int>>();
  ASSERT_TRUE(batch->Start([&](auto& jobs) {
    jobs.push_back(42);
    started.set_value();
    ready.wait();
    finished.store(true);
    throw 42;
  }));
  started.get_future().wait();
  auto shutdown = std::async(std::launch::async, [&] { batch.reset(); });
  EXPECT_EQ(shutdown.wait_for(std::chrono::milliseconds(30)), std::future_status::timeout);
  release.set_value();
  EXPECT_NO_THROW(shutdown.get());
  EXPECT_TRUE(finished.load());
}

namespace ai_service::output {
struct SnapshotStoreTestAccess {
  static void CheckPointPendingRoundTrip(SnapshotStore& store) {
    SnapshotStore::ArchiveJob job;
    bson_oid_init(&job.oid, nullptr);
    job.image_id = NewUuid4(); job.channel_id = store.channel_id_;
    job.channel_name = "point-test"; job.timestamp = 123; job.frame_pts_ns = 456;
    job.model_name = "locateanything"; job.task_type = "grounding";
    job.point = {{"x", .5}, {"y", .25}, {"coordinate_space", "normalized_full_frame"}};
    job.detection.class_id = -1; job.detection.class_name = "定位点";
    job.detection.label_id = "stable-point";
    job.detection.query_description = "Point to: person.";
    job.detection.confidence_known = false;
    job.detection.model_extra = {{"source", "point-contract"}};
    job.config = store.cfg_;
    job.crop = cv::Mat(16, 32, CV_8UC4, cv::Scalar(1, 2, 3, 255));
    store.SavePending(job, false);
    const auto file = std::filesystem::path(store.pending_dir_) / (job.image_id + ".cbor");
    std::ifstream input(file, std::ios::binary);
    auto raw = json::from_cbor(std::vector<uint8_t>((std::istreambuf_iterator<char>(input)), {}));
    EXPECT_TRUE(raw.at("bbox").is_null());
    EXPECT_EQ(raw.at("point"), job.point);
    EXPECT_EQ(raw.at("context_image"), "full_frame");
    const auto restored = store.ReadPending(file.string());
    EXPECT_EQ(restored.image_id, job.image_id);
    EXPECT_EQ(restored.point, job.point);
    EXPECT_FALSE(restored.detection.confidence_known);
    EXPECT_EQ(restored.detection.label_id, "stable-point");
    EXPECT_EQ(restored.detection.model_extra, job.detection.model_extra);
    EXPECT_EQ(cv::norm(restored.crop, job.crop, cv::NORM_INF), 0);
    // Corrupted recovery metadata must fail rather than fabricate a box or empty point.
    raw["point"]["x"] = -1;
    const auto bad = json::to_cbor(raw);
    std::ofstream output(file, std::ios::binary | std::ios::trunc);
    output.write(reinterpret_cast<const char*>(bad.data()), bad.size()); output.close();
    EXPECT_THROW(store.ReadPending(file.string()), std::exception);
    store.RemovePending(job.image_id);
  }
  static void CheckPointOfferQueue(SnapshotStore& store) {
    store.stop_event_.store(false); store.capture_enabled_.store(true);
    // Joinable sentinel selects the real deferred-admission path,with no writer
    // consuming it. Nothing invokes image callbacks or neural/hardware execution.
    store.thread_ = std::thread([] {});
    FrameResult result;
    result.channel_id = store.channel_id_; result.model_name = "locateanything";
    result.task_type = "grounding"; result.timestamp = 123; result.frame_pts_ns = 456;
    result.model_extra = {{"grounding", {{"complete", true},
      {"coordinate_space", "normalized_full_frame"}, {"points", json::array({
        {{"x", .5}, {"y", .25}, {"class_name", "person"}, {"confidence", nullptr}},
        {{"x", .75}, {"y", .5}, {"class_name", "car"}, {"confidence", .8}}
      })}}}};
    std::atomic<int> downloads{0};
    pipeline::SnapshotSink::FrameProvider provider;
    provider.size = {64, 32};
    provider.download = provider.owned_download = [&](const cv::Rect&, cv::Mat&) { ++downloads; };
    try {
      store.OfferResult(provider, result, "point-test", {}, true, store.cfg_);
    } catch (...) {
      store.thread_.join(); store.stop_event_.store(true); throw;
    }
    store.thread_.join();
    EXPECT_EQ(downloads.load(), 0);
    EXPECT_TRUE(result.detections.empty());
    EXPECT_EQ(store.queue_.size(), 2u);
    for (const auto& job : store.queue_) {
      EXPECT_FALSE(job.point.is_null());
      EXPECT_EQ(job.point.at("coordinate_space"), "normalized_full_frame");
      EXPECT_EQ(job.detection.bbox, (std::array<double, 4>{0, 0, 0, 0}));
      EXPECT_EQ(job.crop_detection.bbox, (std::array<double, 4>{0, 0, 64, 32}));
      EXPECT_FALSE(job.square);
      EXPECT_EQ(job.config->projection_mode, "flat");
      EXPECT_EQ(job.config->padding_ratio, 0);
      EXPECT_EQ(job.config->face_enhance_model, "none");
    }
    EXPECT_EQ(store.cfg_.projection_mode, "erp_equirect");
    store.queue_.clear(); store.stop_event_.store(true); store.capture_enabled_.store(false);
  }
  static void CheckStatsWhileDiskLocked(SnapshotStore& store) {
    std::unique_lock<std::mutex> disk_lock(store.pending_io_mutex_);
    store.pending_bytes_ = 123;
    store.quarantined_bytes_ = 45;
    auto stats = std::async(std::launch::async, [&store] { return store.GetStats(); });
    const auto status = stats.wait_for(std::chrono::milliseconds(500));
    disk_lock.unlock(); // Always release before joining, including the regression case.
    const auto result = stats.get();
    EXPECT_EQ(status, std::future_status::ready);
    EXPECT_EQ(result.at("pending_bytes"), 123);
    EXPECT_EQ(result.at("quarantined_bytes"), 45);
  }

  static void PreserveOne(SnapshotStore& store) {
    SnapshotStore::ArchiveJob job;
    bson_oid_init(&job.oid, nullptr);
    job.image_id = NewUuid4(); job.channel_id = "test";
    job.frame_pts_ns = 1; job.timestamp = 1; job.config = store.cfg_;
    job.crop = cv::Mat(16, 16, CV_8UC4, cv::Scalar(1, 2, 3, 255));
    store.PreservePending(job);
  }
  static void FailedQuarantineRetainsOwnership(SnapshotStore& store) {
    SnapshotStore::ArchiveJob job;
    bson_oid_init(&job.oid, nullptr);
    job.image_id = NewUuid4(); job.channel_id = "test";
    job.frame_pts_ns = 1; job.timestamp = 1; job.config = store.cfg_;
    job.crop = cv::Mat(16, 16, CV_8UC4, cv::Scalar(1, 2, 3, 255));
    // No pending directory: caller must retain this job, not erase it.
    EXPECT_THROW(store.QuarantineJob(job, "injected encoding failure"), std::exception);
    EXPECT_EQ(store.GetStats()["dropped_count"], 0);
  }
  static void CheckQuarantineAccounting(SnapshotStore& store) {
    SnapshotStore::ArchiveJob job;
    bson_oid_init(&job.oid, nullptr);
    job.image_id=NewUuid4();job.channel_id="test";job.timestamp=1;
    job.config=store.cfg_;job.crop=cv::Mat(16,16,CV_8UC4,cv::Scalar(10,20,30,255));
    store.SavePending(job,false);
    const auto bytes=store.pending_bytes_.load();
    ASSERT_GT(bytes,0u);
    store.QuarantineJob(job,"test quarantine");
    EXPECT_EQ(store.pending_bytes_.load(),0u);
    EXPECT_EQ(store.quarantined_bytes_.load(),bytes);
    store.LoadPending();
    EXPECT_EQ(store.pending_bytes_.load(),0u);
    EXPECT_EQ(store.quarantined_bytes_.load(),bytes);
    job.image_id=NewUuid4();store.SavePending(job,false);
    store.deletions_.Add(json::object());
    job.jpeg={1};
    std::vector<SnapshotStore::ArchiveJob> jobs{job};
    store.WriteBatch(jobs);
    EXPECT_TRUE(jobs.empty());
    EXPECT_EQ(store.pending_bytes_.load(),0u); // cleared history releases retry accounting
    EXPECT_EQ(store.quarantined_bytes_.load(),bytes); // isolated evidence still occupies disk
  }
  static void StartDisconnectedWriterForBackpressureTest(SnapshotStore& store) {
    // Isolate cancellation from the independently tested disk spool consumer.
    store.stop_event_.store(false);
    store.writer_running_.store(true);
    store.thread_ = std::thread([&store] { store.WriterLoop(); });
  }
  static void MarkConnected(SnapshotStore& store) {
    if (!store.uri_) store.uri_ = mongoc_uri_new(store.mongo_uri_.c_str());
    if (!store.pool_) store.pool_ = mongoc_client_pool_new(store.uri_);
    store.connected_.store(true);
  }
  static std::string LeaveAmbiguousPending(SnapshotStore& store) {
    SnapshotStore::ArchiveJob job;
    bson_oid_init(&job.oid, nullptr);
    job.archive_epoch = store.deletions_.Epoch();
    job.image_id = NewUuid4(); job.channel_id = store.channel_id_;
    job.channel_name = "test"; job.timestamp = 100; job.frame_pts_ns = 0;
    job.model_name = "test"; job.task_type = "object_detection";
    job.config = store.cfg_; job.crop = cv::Mat(16, 16, CV_8UC4, cv::Scalar(10, 20, 30, 255));
    std::vector<SnapshotStore::ArchiveJob> batch{job};
    store.WriteBatch(batch);
    store.SavePending(batch.front(), false); // durable copy left after ambiguous acknowledgement
    return job.image_id;
  }
  static void DeletedBatchNeedsNoMongo(SnapshotStore& store) {
    SnapshotStore::ArchiveJob job;
    job.image_id = "deleted"; job.timestamp = 123;
    job.jpeg = {1}; // preparation already completed before deletion
    std::vector<SnapshotStore::ArchiveJob> batch{job};
    store.deletions_.Add({{"image_id", "deleted"}});
    store.WriteBatch(batch); // pool is null: must be pruned before any database access
    EXPECT_TRUE(batch.empty());
  }
  static std::unique_lock<std::mutex> HoldHistory(SnapshotStore& store) {
    return std::unique_lock<std::mutex>(store.history_mutex_);
  }
  static bool WaitForInitialTrim(SnapshotStore& store) {
    {
      std::lock_guard<std::mutex> lock(store.stats_mutex_);
      store.last_trim_ms_ = 0;
      store.trim_requested_.store(true);
    }
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
      if (store.GetStats()["last_trim_ms"].get<double>() > 0) return true;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return false;
  }
};
}

TEST(SnapshotDeletion, UnavailableIsNotSuccessfulEmptyDeletion) {
  config::SnapshotConfig cfg;
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1", "test", "test", "test", "", "", 64, false);
  EXPECT_THROW(store.DeleteOne("missing"), SnapshotUnavailable);
  EXPECT_THROW(store.DeleteRange(1, 2), SnapshotUnavailable);
  EXPECT_THROW(store.Clear(), SnapshotUnavailable);
}

static FrameResult PointSnapshotResult(json points) {
  FrameResult result;
  result.model_extra = {{"grounding", {{"complete", true},
    {"coordinate_space", "normalized_full_frame"}, {"points", std::move(points)}}}};
  return result;
}

TEST(SnapshotGrounding, KeepsPointQueryAndUnknownConfidenceWithoutABox) {
  const auto result = PointSnapshotResult(json::array({{{"x", .5}, {"y", .25},
    {"class_name", "person"}, {"confidence", nullptr}, {"label_id", "stable"},
    {"query_description", "Point to: person."}}}));
  const auto targets = GroundingSnapshotTargets(result);
  ASSERT_EQ(targets.size(), 1u);
  EXPECT_TRUE(result.detections.empty());
  EXPECT_EQ(targets[0].point.at("x"), .5);
  EXPECT_EQ(targets[0].point.at("coordinate_space"), "normalized_full_frame");
  EXPECT_EQ(targets[0].properties.class_id, -1);
  EXPECT_FALSE(targets[0].properties.confidence_known);
  EXPECT_EQ(targets[0].properties.label_id, "stable");
  EXPECT_EQ(targets[0].properties.query_description, "Point to: person.");
}

TEST(SnapshotGrounding, RejectsInvalidCoordinatesConfidenceAndUnboundedCount) {
  for (auto point : std::vector<json>{
      {{"x", -1}, {"y", .5}}, {{"x", 1.1}, {"y", .5}},
      {{"x", "0.5"}, {"y", .5}}, {{"x", .5}},
      {{"x", .5}, {"y", .5}, {"confidence", 1.1}},
      {{"x", .5}, {"y", std::numeric_limits<double>::infinity()}}}) {
    EXPECT_THROW(GroundingSnapshotTargets(PointSnapshotResult(json::array({point}))), std::exception);
  }
  json points = json::array();
  for (int i = 0; i < 1025; ++i) points.push_back({{"x", .5}, {"y", .5}});
  EXPECT_THROW(GroundingSnapshotTargets(PointSnapshotResult(points)), std::invalid_argument);
}

TEST(SnapshotGrounding, EmptyAndIncompleteOutputsDoNotCreateRecords) {
  auto result = PointSnapshotResult(json::array());
  EXPECT_TRUE(GroundingSnapshotTargets(result).empty());
  result.model_extra["grounding"]["points"] = json::array({{{"x", .5}, {"y", .5}}});
  result.model_extra["grounding"]["complete"] = false;
  EXPECT_TRUE(GroundingSnapshotTargets(result).empty());
  result.model_extra["grounding"]["complete"] = true;
  result.model_extra["grounding"]["coordinate_space"] = "pixels";
  EXPECT_TRUE(GroundingSnapshotTargets(result).empty());
}

TEST(SnapshotGrounding, DeferredQueueUsesFullContextAndPreservesUserConfig) {
  config::SnapshotConfig cfg;
  cfg.enabled = true; cfg.projection_mode = "erp_equirect";
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1", "test", "test", "test", "", "", 64, false);
  SnapshotStoreTestAccess::CheckPointOfferQueue(store);
}

TEST(SnapshotGrounding, PendingRoundTripRetainsGeometryAndRejectsCorruption) {
  const auto dir = std::filesystem::temp_directory_path() / ("point-pending-" + NewUuid4());
  config::SnapshotConfig cfg;
  {
    SnapshotStore store(cfg, "mongodb://127.0.0.1:1", "test", "test", "test", "", "", 64, false, dir.string());
    SnapshotStoreTestAccess::CheckPointPendingRoundTrip(store);
  }
  std::filesystem::remove_all(dir);
}

TEST(SnapshotGrounding, HistoryPreservesPointAndDoesNotInventBbox) {
  const json point = {{"x", .5}, {"y", .25}, {"coordinate_space", "normalized_full_frame"}};
  const auto item = snapshot_detail::DocToListItem({{"bbox", nullptr}, {"point", point},
    {"geometry_type", "point"}, {"context_image", "full_frame"}});
  EXPECT_TRUE(item.at("bbox").is_null());
  EXPECT_EQ(item.at("point"), point);
  EXPECT_EQ(item.at("geometry_type"), "point");
  EXPECT_EQ(item.at("context_image"), "full_frame");
  const auto legacy = snapshot_detail::DocToListItem({{"bbox", {{"x", 1}, {"y", 2}, {"w", 3}, {"h", 4}}}});
  EXPECT_FALSE(legacy.contains("point"));
  EXPECT_FALSE(legacy.contains("geometry_type"));
}

TEST(SnapshotGrounding, ContextRectangleRetainsCoordinatesAcrossJpuPaddingAndRetries) {
  json point = {{"x", .5}, {"y", .25}, {"coordinate_space", "normalized_full_frame"}};
  PreserveSnapshotPointContext(point, 17, 1, 17, 17);
  EXPECT_EQ(point.at("x"), .5);
  EXPECT_EQ(point.at("y"), .25);
  EXPECT_DOUBLE_EQ(point["context_image_rect"]["w"].get<double>(), 1);
  EXPECT_DOUBLE_EQ(point["context_image_rect"]["h"].get<double>(), 1.0 / 17);
  const auto original = point;
  PreserveSnapshotPointContext(point, 17, 17, 17, 17);
  EXPECT_EQ(point, original);  // Retry already owns the padded pixels.
  EXPECT_THROW(PreserveSnapshotPointContext(point, 18, 17, 17, 17), std::invalid_argument);
  point["context_image_rect"]["w"] = 1.1;
  EXPECT_THROW(ValidateSnapshotPoint(point), std::invalid_argument);
}

TEST(SnapshotGrounding, ContextRectangleRejectsInvalidOffsetsAndExtents) {
  for (const auto& rect : std::vector<json>{
       {{"x", -.1}, {"y", 0}, {"w", 1}, {"h", 1}},
       {{"x", .5}, {"y", 0}, {"w", .6}, {"h", 1}},
       {{"x", 0}, {"y", 0}, {"w", 1}, {"h", 0}},
       {{"x", 0}, {"y", 0}, {"w", 1}, {"h", "1"}}}) {
    const json point = {{"x", .5}, {"y", .25}, {"coordinate_space", "normalized_full_frame"},
                        {"context_image_rect", rect}};
    EXPECT_THROW(ValidateSnapshotPoint(point), std::invalid_argument);
  }
}

TEST(SnapshotSpool, QuarantineAndDeletionAccountingSurvivesReload) {
  const auto dir=std::filesystem::temp_directory_path() / ("pending-account-"+NewUuid4());
  config::SnapshotConfig cfg;
  {
    SnapshotStore store(cfg,"mongodb://127.0.0.1:1","test","test","test","","",64,false,dir.string());
    SnapshotStoreTestAccess::CheckQuarantineAccounting(store);
  }
  std::filesystem::remove_all(dir);
}

TEST(SnapshotRead, UnavailableIsNotMissingImageOrEmptyHeatmap) {
  config::SnapshotConfig cfg;
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1", "test", "test", "test", "", "", 64, false);
  EXPECT_THROW(store.GetImage("missing", false), SnapshotUnavailable);
  EXPECT_THROW(store.Heatmap(std::nullopt, std::nullopt, 60), SnapshotUnavailable);
}

TEST(SnapshotRead, FailedMongoCursorIsNotMissingImageOrEmptyHeatmap) {
  config::SnapshotConfig cfg;
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=50&connectTimeoutMS=50",
                      "test", "test", "test", "", "", 64, false);
  SnapshotStoreTestAccess::MarkConnected(store);
  EXPECT_THROW(store.GetImage("missing", false), SnapshotUnavailable);
  SnapshotStoreTestAccess::MarkConnected(store);
  EXPECT_THROW(store.Heatmap(std::nullopt, std::nullopt, 60), SnapshotUnavailable);
}

TEST(SnapshotDeletion, AlreadyPreparedRetryIsSuppressedBeforeDatabaseWrite) {
  config::SnapshotConfig cfg;
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1", "test", "test", "test", "", "", 64, false);
  EXPECT_NO_THROW(SnapshotStoreTestAccess::DeletedBatchNeedsNoMongo(store));
}

#ifdef AINVR_CUDA_REFERENCE_TESTS
TEST(SnapshotDownload, IndependentOfUnrelatedGpuWorkAndKeepsPixels) {
  if (!GpuAvailable()) GTEST_SKIP() << "CUDA unavailable";
  cv::Mat input(257, 513, CV_8UC4); cv::randu(input, 0, 255);
  cv::cuda::GpuMat gpu; gpu.upload(input);
  cv::Rect roi(3, 7, 231, 119);
  cudaStream_t unrelated;
  ASSERT_EQ(cudaStreamCreate(&unrelated), cudaSuccess);
  std::promise<void> ready, start, release;
  auto start_signal = start.get_future().share();
  auto release_signal = release.get_future().share();
  auto result = std::async(std::launch::async, [&] {
    cv::Mat host;
    DownloadSnapshotRegion(gpu, roi, host);  // Warm the thread-local stream.
    ready.set_value(); start_signal.wait();
    DownloadSnapshotRegion(gpu, roi, host);
    return host;
  });
  ready.get_future().wait();
  auto queued = cudaLaunchHostFunc(unrelated, [](void* data) {
    static_cast<std::shared_future<void>*>(data)->wait();
  }, &release_signal);
  start.set_value();
  auto status = result.wait_for(std::chrono::milliseconds(500));
  release.set_value();  // Always release even when the regression is reproduced.
  cudaStreamSynchronize(unrelated); cudaStreamDestroy(unrelated);
  EXPECT_EQ(queued, cudaSuccess);
  EXPECT_EQ(status, std::future_status::ready);
  auto host = result.get();
  EXPECT_EQ(cv::norm(host, input(roi), cv::NORM_INF), 0);
  gpu.setTo(cv::Scalar(0, 0, 0, 0));
  EXPECT_EQ(cv::norm(host, input(roi), cv::NORM_INF), 0);
  EXPECT_THROW(DownloadSnapshotRegion(gpu, cv::Rect(-1, 0, 10, 10), host), cv::Exception);
  DownloadSnapshotRegion(gpu, roi, host);
  EXPECT_EQ(cv::norm(host, cv::NORM_INF), 0);
}
#endif

namespace {
pipeline::SnapshotSink::FrameProvider FrameProvider(const cv::Mat& image, int* calls = nullptr) {
  return {image.size(), [image, calls](const cv::Rect& roi, cv::Mat& dst) {
    if (calls) ++*calls;
    image(roi).copyTo(dst);
  }};
}

bool IsUuid4(const std::string& s) {
  static const std::regex kRe(
      "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
  return std::regex_match(s, kRe);
}

json LoadFixtures() {
  std::ifstream f(SNAPSHOT_CROP_FIXTURES_PATH);
  json j;
  f >> j;
  return j;
}

cv::Mat JsonToRgbaMat(const json& arr) {
  int h = static_cast<int>(arr.size());
  int w = static_cast<int>(arr[0].size());
  cv::Mat m(h, w, CV_8UC4);
  for (int r = 0; r < h; ++r) {
    for (int c = 0; c < w; ++c) {
      for (int ch = 0; ch < 4; ++ch) m.at<cv::Vec4b>(r, c)[ch] = static_cast<uchar>(arr[r][c][ch].get<int>());
    }
  }
  return m;
}

// 集成测试用的 Mongo URI 带写账号凭据,绝不能写进源码(源码要入库)。
// 取值顺序:环境变量 AI_SERVICE_TEST_MONGO_URI → 本机 config/config.yaml
// (gitignore 的本地配置,板上部署时必然存在)的 snapshot_store.mongo_uri。
// 两者都没有时返回空串,调用方 GTEST_SKIP 并说明原因(不是静默通过)。
std::string TestMongoUri() {
  if (const char* env = std::getenv("AI_SERVICE_TEST_MONGO_URI"); env && *env) return env;
  std::ifstream probe(LOCAL_CONFIG_PATH);
  if (!probe.good()) return "";
  return config::LoadAppConfig(LOCAL_CONFIG_PATH).snapshot_store.mongo_uri;
}
const char* kNoMongoReason =
    "未设置 AI_SERVICE_TEST_MONGO_URI,且本机没有 config/config.yaml,跳过 Mongo 集成测试";
const char* kTestChannelId = "test-ai-service-snapshot-store";

// 集成测试写入的是生产 Mongo 实例里的独立测试集合;每个用例自己 Clear(),
// 但空集合本身会一直留在库里——整个测试进程结束时 drop 掉,不留垃圾。
class DropTestCollectionEnv : public ::testing::Environment {
 public:
  void TearDown() override {
    std::string uri_str = TestMongoUri();
    if (uri_str.empty()) return;
    mongoc_init();
    bson_error_t error;
    mongoc_uri_t* uri = mongoc_uri_new_with_error(uri_str.c_str(), &error);
    if (!uri) return;
    mongoc_client_t* client = mongoc_client_new_from_uri(uri);
    std::string name = std::string("snapshots_") + kTestChannelId;
    mongoc_collection_t* coll = mongoc_client_get_collection(client, "ainvr_snapshot_reuse_tests", name.c_str());
    mongoc_collection_drop(coll, &error);  // 集合不存在时报错,忽略即可
    mongoc_collection_destroy(coll);
    mongoc_client_destroy(client);
    mongoc_uri_destroy(uri);
  }
};
const auto* const kDropEnv = ::testing::AddGlobalTestEnvironment(new DropTestCollectionEnv);
}  // namespace

TEST(SnapshotDeletion, UnavailableDatabaseIsNotSuccessfulCleanup) {
  config::SnapshotStoreConfig cfg;
  cfg.mongo_uri = "mongodb://127.0.0.1:1";
  EXPECT_THROW(SnapshotStore::DropChannelHistory(cfg, "test-delete-unavailable"), SnapshotUnavailable);
}

TEST(SnapshotHistory, TrimDoesNotFetchUnusedImageIds) {
  const auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  mongoc_init();
  auto client = std::unique_ptr<mongoc_client_t, decltype(&mongoc_client_destroy)>(
      mongoc_client_new(uri.c_str()), mongoc_client_destroy);
  ASSERT_NE(client, nullptr);
  auto collection = std::unique_ptr<mongoc_collection_t, decltype(&mongoc_collection_destroy)>(
      mongoc_client_get_collection(client.get(), "ainvr_snapshot_reuse_tests",
                                  (std::string("snapshots_") + kTestChannelId).c_str()),
      mongoc_collection_destroy);
  bson_error_t error{};
  mongoc_collection_drop(collection.get(), &error);
  for (int i = 0; i < 3; ++i) {
    bson_t doc = BSON_INITIALIZER;
    bson_oid_t id;
    bson_oid_init(&id, nullptr);
    BSON_APPEND_OID(&doc, "_id", &id);
    BSON_APPEND_UTF8(&doc, "image_id", "trim-test");
    const bool inserted = mongoc_collection_insert_one(collection.get(), &doc, nullptr, nullptr, &error);
    bson_destroy(&doc);
    ASSERT_TRUE(inserted);
  }
  std::pair<int, int> commands{0, 0};
  auto* callbacks = mongoc_apm_callbacks_new();
  mongoc_apm_set_command_started_cb(callbacks, [](const mongoc_apm_command_started_t* event) {
    auto* counts = static_cast<std::pair<int, int>*>(mongoc_apm_command_started_get_context(event));
    const std::string name = mongoc_apm_command_started_get_command_name(event);
    if (name == "find") ++counts->first;
    if (name == "delete") ++counts->second;
  });
  ASSERT_TRUE(mongoc_client_set_apm_callbacks(client.get(), callbacks, &commands));
  mongoc_apm_callbacks_destroy(callbacks);
  std::optional<int64_t> count = 3;
  ASSERT_NO_THROW(snapshot_detail::TrimHistory(collection.get(), 1, count));
  EXPECT_EQ(count, 1);
  EXPECT_EQ(commands.first, 1);  // Boundary lookup only; no unused image_id scan.
  EXPECT_EQ(commands.second, 1);
  bson_t filter = BSON_INITIALIZER;
  EXPECT_EQ(mongoc_collection_count_documents(collection.get(), &filter, nullptr,
                                             nullptr, nullptr, &error), 1);
  bson_destroy(&filter);
  mongoc_collection_drop(collection.get(), &error);
  mongoc_client_set_apm_callbacks(client.get(), nullptr, nullptr);
}

TEST(SnapshotDeletion, DropsOnlyTargetCollectionAndRetryIsIdempotent) {
  auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  config::SnapshotStoreConfig cfg;
  cfg.mongo_uri = uri;
  cfg.db_name = "ainvr_snapshot_reuse_tests";
  const auto id = "test-delete-" + NewUuid4();
  const auto keep_id = id + "-keep";
  auto* client = mongoc_client_new(uri.c_str());
  ASSERT_NE(client, nullptr);
  auto* target = mongoc_client_get_collection(client, cfg.db_name.c_str(), ("snapshots_" + id).c_str());
  auto* keep = mongoc_client_get_collection(client, cfg.db_name.c_str(), ("snapshots_" + keep_id).c_str());
  bson_t doc = BSON_INITIALIZER;
  BSON_APPEND_UTF8(&doc, "image", "isolated deletion fixture");
  bson_error_t error{};
  ASSERT_TRUE(mongoc_collection_insert_one(target, &doc, nullptr, nullptr, &error));
  ASSERT_TRUE(mongoc_collection_insert_one(keep, &doc, nullptr, nullptr, &error));
  EXPECT_NO_THROW(SnapshotStore::DropChannelHistory(cfg, id));
  EXPECT_NO_THROW(SnapshotStore::DropChannelHistory(cfg, id));
  bson_t empty = BSON_INITIALIZER;
  EXPECT_EQ(mongoc_collection_count_documents(keep, &empty, nullptr, nullptr, nullptr, &error), 1);
  EXPECT_EQ(mongoc_collection_count_documents(target, &empty, nullptr, nullptr, nullptr, &error), 0);
  EXPECT_NO_THROW(SnapshotStore::DropChannelHistory(cfg, keep_id));
  bson_destroy(&empty);
  bson_destroy(&doc);
  mongoc_collection_destroy(target);
  mongoc_collection_destroy(keep);
  mongoc_client_destroy(client);
}

// ---- CropWithPadding:对照 v1 golden fixture ----

TEST(SnapshotCrop, MatchesGoldenShapes) {
  json fixtures = LoadFixtures();
  cv::Mat frame = JsonToRgbaMat(fixtures["frame"]);
  for (auto&& c : fixtures["cases"]) {
    std::string name = c["name"].get<std::string>();
    auto bbox_j = c["bbox"];
    std::array<double, 4> bbox = {bbox_j[0], bbox_j[1], bbox_j[2], bbox_j[3]};
    cv::Mat out = CropWithPadding(frame, bbox, c["padding_ratio"].get<double>(),
                                  c["max_dimension"].get<int>(), c["keep_square"].get<bool>());
    if (c.value("is_none", false)) {
      EXPECT_TRUE(out.empty()) << name;
      continue;
    }
    ASSERT_FALSE(out.empty()) << name;
    auto expected_shape = c["output_shape"];
    EXPECT_EQ(out.rows, expected_shape[0].get<int>()) << name;
    EXPECT_EQ(out.cols, expected_shape[1].get<int>()) << name;
    EXPECT_EQ(out.channels(), expected_shape[2].get<int>()) << name;
  }
}

TEST(SnapshotCrop, SquareModeAlwaysProducesSquareOutput) {
  cv::Mat frame(200, 300, CV_8UC4, cv::Scalar(50, 60, 70, 255));
  cv::Mat out = CropWithPadding(frame, {100.0, 100.0, 35.0, 35.0}, 0.25, 320, /*keep_square=*/true);
  ASSERT_FALSE(out.empty());
  EXPECT_EQ(out.rows, out.cols);
}

TEST(SnapshotCrop, DegenerateBboxReturnsEmpty) {
  cv::Mat frame(200, 300, CV_8UC4, cv::Scalar(50, 60, 70, 255));
  cv::Mat out = CropWithPadding(frame, {10.0, 10.0, 0.0, 5.0}, 0.25, 320, false);
  EXPECT_TRUE(out.empty());
}

// ---- Mongo integration (isolated test collection) ----

class MongoIntegrationTest : public ::testing::Test {
 protected:
  void SetUp() override {
    mongo_uri_ = TestMongoUri();
    if (mongo_uri_.empty()) GTEST_SKIP() << kNoMongoReason;
    mongoc_init();
    bson_error_t error;
    uri_ = mongoc_uri_new_with_error(mongo_uri_.c_str(), &error);
    ASSERT_NE(uri_, nullptr) << error.message;
    pool_ = mongoc_client_pool_new(uri_);
    client_ = mongoc_client_pool_pop(pool_);
    std::string coll_name = std::string("snapshots_") + kTestChannelId;
    coll_ = mongoc_client_get_collection(client_, "ainvr_snapshot_reuse_tests", coll_name.c_str());
    // 每个测试开始前先清空,保证测试之间互不影响。
    bson_t* filter = bson_new();
    bson_t reply;
    mongoc_collection_delete_many(coll_, filter, nullptr, &reply, &error);
    bson_destroy(&reply);
    bson_destroy(filter);
  }
  void TearDown() override {
    if (!coll_) return;  // SetUp 里 GTEST_SKIP 了
    bson_error_t error;
    bson_t* filter = bson_new();
    bson_t reply;
    mongoc_collection_delete_many(coll_, filter, nullptr, &reply, &error);
    bson_destroy(&reply);
    bson_destroy(filter);
    mongoc_collection_destroy(coll_);
    mongoc_client_pool_push(pool_, client_);
    mongoc_client_pool_destroy(pool_);
    mongoc_uri_destroy(uri_);
  }

  void InsertDummyDoc(const std::string& image_id) {
    bson_t doc;
    bson_init(&doc);
    BSON_APPEND_UTF8(&doc, "image_id", image_id.c_str());
    bson_error_t error;
    bson_t reply;
    ASSERT_TRUE(mongoc_collection_insert_one(coll_, &doc, nullptr, &reply, &error)) << error.message;
    bson_destroy(&reply);
    bson_destroy(&doc);
  }

  std::string mongo_uri_;
  mongoc_uri_t* uri_ = nullptr;
  mongoc_client_pool_t* pool_ = nullptr;
  mongoc_client_t* client_ = nullptr;
  mongoc_collection_t* coll_ = nullptr;
};



TEST_F(MongoIntegrationTest, StartupEnsuresImageLookupIndex) {
  config::SnapshotConfig cfg;cfg.enabled=true;
  SnapshotStore store(cfg,TestMongoUri(),"ainvr_snapshot_reuse_tests",kTestChannelId,"index","","",64,false);
  store.Start();
  auto* cursor=mongoc_collection_find_indexes_with_opts(coll_,nullptr);
  const bson_t* doc=nullptr;bool found=false;
  while(mongoc_cursor_next(cursor,&doc)) {
    bson_iter_t it,key;
    if(bson_iter_init(&it,doc) && bson_iter_find_descendant(&it,"key.image_id",&key))
      found=bson_iter_as_int64(&key)==1;
  }
  bson_error_t error{};
  EXPECT_FALSE(mongoc_cursor_error(cursor,&error));
  mongoc_cursor_destroy(cursor);
  EXPECT_TRUE(found);
  store.Stop();
}

// ---- SnapshotStore 端到端(真实 Mongo,独立测试通道) ----

TEST(SnapshotStoreEndToEnd, DeletedImageDoesNotReturnFromPendingAfterRestart) {
  const auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  const auto dir = std::filesystem::temp_directory_path() /
      ("snapshot-delete-replay-" + NewUuid4());
  struct Cleanup {
    std::filesystem::path path;
    ~Cleanup() { std::filesystem::remove_all(path); }
  } cleanup{dir};
  config::SnapshotConfig cfg;
  cfg.enabled = true; cfg.min_interval_ms = 0;
  cfg.brightness_enabled = false; cfg.face_enhance_model = "none";
  std::string id;
  {
    SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "test", "", "", 64, false, dir.string());
    store.Start(); store.Clear();
    id = SnapshotStoreTestAccess::LeaveAmbiguousPending(store);
    ASSERT_TRUE(store.DeleteOne(id));
    store.Stop();
  }
  SnapshotStore reloaded(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "test", "", "", 64, false, dir.string());
  reloaded.Start();
  for (int i = 0; i < 100 && std::filesystem::exists(dir / (id + ".cbor")); ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  EXPECT_FALSE(std::filesystem::exists(dir / (id + ".cbor")));
  EXPECT_FALSE(reloaded.GetImage(id).has_value());
  // Same timestamp, but a newly accepted task belongs to the next epoch.
  const auto fresh = SnapshotStoreTestAccess::LeaveAmbiguousPending(reloaded);
  EXPECT_TRUE(reloaded.GetImage(fresh).has_value());
  reloaded.Clear(); reloaded.Stop();
}

TEST(SnapshotStoreEndToEnd, OfferWriteQueryDeleteRoundTrip) {
  config::SnapshotConfig cfg;
  cfg.enabled = true;
  cfg.min_interval_ms = 0;  // 测试不需要节流
  cfg.max_count = 1000;
  cfg.jpeg_quality = 80;
  cfg.max_crop_dimension = 320;
  cfg.padding_ratio = 0.25;
  cfg.projection_mode = "none";
  cfg.brightness_enabled = false;
  cfg.face_enhance_model = "none";

  std::string mongo_uri = TestMongoUri();
  if (mongo_uri.empty()) GTEST_SKIP() << kNoMongoReason;
  SnapshotStore store(cfg, mongo_uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "单测通道", "", "");
  store.Start();

  // 等连接建立(TryConnect 在 Start() 里同步跑过一次,这里给写入线程一点
  // 时间完成一轮 reconnect 状态机的收敛)。
  for (int i = 0; i < 20; ++i) {
    auto overview = store.GetOverview();
    if (overview["connected"].get<bool>()) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }
  ASSERT_TRUE(store.GetOverview()["connected"].get<bool>()) << "Mongo 连接失败,检查测试环境";

  cv::Mat frame(100, 100, CV_8UC4, cv::Scalar(10, 20, 30, 255));
  Detection det;
  det.class_id = 0;
  det.class_name = "person";
  det.confidence = 0.9;
  det.bbox = {10.0, 10.0, 30.0, 40.0};

  store.Offer(FrameProvider(frame), kTestChannelId, "单测通道", 123456789, 1700000000.0, "yolo26m",
              "object_detection", {det}, {det}, /*square_crop=*/false, cfg);

  // 等写入线程处理完队列。
  std::optional<std::string> image_id;
  for (int i = 0; i < 30; ++i) {
    auto page = store.ListPage(std::nullopt, 10, 0.0, std::nullopt, std::nullopt);
    if (!page["items"].empty()) {
      image_id = page["items"][0]["image_id"].get<std::string>();
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }
  ASSERT_TRUE(image_id.has_value()) << "写入线程超时未完成归档";
  EXPECT_TRUE(IsUuid4(*image_id)) << *image_id;  // 入库的 image_id 契约是 uuid4

  // 列表项是对外契约(v1 SnapshotStore._doc_to_list_item):固定扁平字段,
  // 尺寸在顶层 image_width/image_height,不透传 image 子对象、增强模型名、
  // embedding 这些内部存储字段。
  {
    auto item = store.ListPage(std::nullopt, 10, 0.0, std::nullopt, std::nullopt)["items"][0];
    std::set<std::string> keys;
    for (auto it = item.begin(); it != item.end(); ++it) keys.insert(it.key());
    std::set<std::string> want = {"image_id",    "channel_id", "channel_name", "frame_pts_ns",
                                  "timestamp",   "model_name", "task_type",    "class_id",
                                  "class_name",  "confidence", "bbox",         "landmarks",
                                  "image_width", "image_height", "enhanced"};
    EXPECT_EQ(keys, want);
    EXPECT_GT(item["image_width"].get<int>(), 0);
    EXPECT_GT(item["image_height"].get<int>(), 0);
    EXPECT_TRUE(item["landmarks"].is_null());
    EXPECT_TRUE(item["enhanced"].is_boolean());
  }

  auto image_data = store.GetImage(*image_id);
  ASSERT_TRUE(image_data.has_value());
  EXPECT_GT(image_data->size(), 0u);
  // JPEG 文件头 magic bytes: FF D8.
  EXPECT_EQ((*image_data)[0], 0xFF);
  EXPECT_EQ((*image_data)[1], 0xD8);

  EXPECT_TRUE(store.DeleteOne(*image_id));
  EXPECT_FALSE(store.DeleteOne(*image_id));  // 已删除,第二次应该 false

  store.Clear();
  store.Stop();
}

TEST(SnapshotStoreEndToEnd, ErpRegionRoundTripsIdenticalJpegThroughMongo) {
  auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  config::SnapshotConfig cfg;
  cfg.enabled = true;
  cfg.min_interval_ms = 0;
  cfg.projection_mode = "erp_equirect";
  cfg.brightness_enabled = false;
  cfg.face_enhance_model = "none";
  SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "region-e2e", "", "", 64, false);
  store.Start();
  ASSERT_TRUE(store.GetOverview()["connected"].get<bool>());
  store.Clear();
  cv::Mat frame(384, 768, CV_8UC4);
  cv::RNG rng(121); rng.fill(frame, cv::RNG::UNIFORM, 0, 256);
  Detection d; d.bbox = {300.5, 160.5, 32.5, 40.5}; d.confidence = 0.9;
  auto v = BboxToErpView(d.bbox, cfg.padding_ratio, 768, 384, cfg.max_crop_dimension, 9, true).value();
  auto ss = ScaleErpView(v, 1.5);
  ErpMapCache cache;
  auto [mx, my] = cache.GetOrBuild(768, 384, ss);
  auto big = SampleErpPerspective(frame, mx, my);
  cv::Mat expected, bgr;
  cv::resize(big, expected, {v.w_out, v.h_out}, 0, 0, cv::INTER_CUBIC);
  cv::cvtColor(expected, bgr, cv::COLOR_RGBA2BGR);
  std::vector<uint8_t> jpeg;
  ASSERT_TRUE(EncodeSnapshotJpeg(bgr, jpeg, cfg.jpeg_quality));
  store.Offer(FrameProvider(frame), kTestChannelId, "region-e2e", 1234, 1700000000,
              "fixture", "face_detection", {d}, {d}, true, cfg);
  std::optional<std::string> id;
  for (int i = 0; i < 30 && !id; ++i) {
    auto page = store.ListPage(std::nullopt, 10, 0, std::nullopt, std::nullopt);
    if (!page["items"].empty()) id = page["items"][0]["image_id"].get<std::string>();
    else std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  ASSERT_TRUE(id);
  auto saved = store.GetImage(*id);
  ASSERT_TRUE(saved);
  EXPECT_EQ(*saved, jpeg);
  EXPECT_EQ(store.GetStats()["last_download_bytes"].get<size_t>(), frame.total() * 4);
  EXPECT_EQ(store.GetStats()["captured_count"], 1);
  store.Clear();
  store.Stop();
}

// 生产事故(2026-09-23):范围查询把 double 用 ostream 默认 6 位有效数字拼进
// 查询 JSON,1790168716 被写成 1.79017e+09(=1790170000),时间戳被取整到
// ~1 万秒粒度——识别历史"最近 10 分钟"查不到,"删除此范围"删错范围。
TEST(SnapshotStoreEndToEnd, TimeRangeQueriesUseFullTimestampPrecision) {
  config::SnapshotConfig cfg;
  cfg.enabled = true;
  cfg.min_interval_ms = 0;
  cfg.max_count = 1000;
  cfg.projection_mode = "none";
  cfg.brightness_enabled = false;
  cfg.face_enhance_model = "none";

  std::string mongo_uri = TestMongoUri();
  if (mongo_uri.empty()) GTEST_SKIP() << kNoMongoReason;
  SnapshotStore store(cfg, mongo_uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "单测通道", "", "");
  store.Start();
  for (int i = 0; i < 20 && !store.GetOverview()["connected"].get<bool>(); ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }
  ASSERT_TRUE(store.GetOverview()["connected"].get<bool>());
  store.Clear();

  // 真实量级的时间戳;三条分别在 1 小时前、5 分钟前、刚才。
  const double now = 1790169316.25;
  cv::Mat frame(100, 100, CV_8UC4, cv::Scalar(10, 20, 30, 255));
  Detection det;
  det.class_name = "person";
  det.confidence = 0.9;
  det.bbox = {10.0, 10.0, 30.0, 40.0};
  for (double ts : {now - 3600.0, now - 300.0, now}) {
    store.Offer(FrameProvider(frame), kTestChannelId, "x", 1, ts, "m", "object_detection", {det},
                {det}, false, cfg);
  }
  for (int i = 0; i < 30 && store.GetOverview()["count"].get<int64_t>() < 3; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }
  ASSERT_EQ(store.GetOverview()["count"], 3);

  // 最近 10 分钟:应恰好命中后两条
  auto page = store.ListPage(std::nullopt, 20, 0.0, now - 600.0, now);
  EXPECT_EQ(page["items"].size(), 2u);

  // 边界精度:to_ts 比最新一条早 0.1 秒,就不能包含它
  page = store.ListPage(std::nullopt, 20, 0.0, now - 600.0, now - 0.1);
  EXPECT_EQ(page["items"].size(), 1u);

  auto heat = store.Heatmap(now - 600.0, now, 60);
  int64_t total = 0;
  for (auto& b : heat["buckets"]) total += b["count"].get<int64_t>();
  EXPECT_EQ(total, 2);

  // 不带范围的热力图也必须能用(不能把空 {} 当成管道阶段)
  auto heat_all = store.Heatmap(std::nullopt, std::nullopt, 60);
  total = 0;
  for (auto& b : heat_all["buckets"]) total += b["count"].get<int64_t>();
  EXPECT_EQ(total, 3);

  // 删除范围只能删 10 分钟内的两条,1 小时前那条必须保留
  EXPECT_EQ(store.DeleteRange(now - 600.0, now), 2);
  EXPECT_EQ(store.GetOverview()["count"], 1);

  // 带引号的 image_id 不能把查询拼坏(应干净地找不到,而不是异常/误删)
  EXPECT_FALSE(store.GetImage("x\"}, \"$where\": \"1").has_value());
  EXPECT_FALSE(store.DeleteOne("x\"}, \"image_id\": {\"$exists\": true}, \"y\": \""));
  EXPECT_EQ(store.GetOverview()["count"], 1);

  store.Clear();
  store.Stop();
}

TEST(SnapshotStoreEndToEnd, DisabledConfigOffersNothing) {
  config::SnapshotConfig cfg;
  cfg.enabled = false;

  // enabled=false 不连 Mongo,URI 用一个不含凭据的占位地址即可。
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1/unused", "ainvr_snapshot_reuse_tests", kTestChannelId,
                      "单测通道", "", "");
  // enabled=false 时 Start() 不应该真的连接(见头文件说明)。
  store.Start();

  cv::Mat frame(50, 50, CV_8UC4, cv::Scalar(1, 2, 3, 255));
  Detection det;
  det.bbox = {5.0, 5.0, 10.0, 10.0};
  store.Offer(FrameProvider(frame), kTestChannelId, "x", 1, 1.0, "m", "object_detection", {det},
              {det}, false, cfg);

  auto stats = store.GetStats();
  EXPECT_EQ(stats["enqueued_count"], 0);
  store.Stop();
}

// ---- 惰性取帧:帧留在 GPU 上,只有真要归档时才整帧下载一次 ----

namespace {
config::SnapshotConfig LazyCfg(int min_interval_ms) {
  config::SnapshotConfig cfg;
  cfg.enabled = true;
  cfg.min_interval_ms = min_interval_ms;
  cfg.projection_mode = "none";
  cfg.face_enhance_model = "none";
  return cfg;
}
}  // namespace

TEST(SnapshotReliable, LegacyIntervalCannotDiscardInferredResults) {
  auto cfg = LazyCfg(1000);
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1/unused", "ainvr_snapshot_reuse_tests",
                      kTestChannelId, "x", "", "");
  cv::Mat frame(32, 32, CV_8UC4, cv::Scalar(1, 2, 3, 255));
  Detection d; d.bbox = {2, 2, 10, 10};
  for (int i = 0; i < 3; ++i)
    store.Offer(FrameProvider(frame), kTestChannelId, "x", i, i, "m",
                "object_detection", {d, d}, {d, d}, false, cfg);
  EXPECT_EQ(store.GetStats()["enqueued_count"], 6);
  EXPECT_EQ(store.GetStats()["dropped_count"], 0);
}

TEST(SnapshotReliable, FailedIsolationDoesNotPretendTaskIsSaved) {
  SnapshotStore store(LazyCfg(0), "mongodb://127.0.0.1:1/unused", "ainvr_snapshot_reuse_tests",
                      kTestChannelId, "x", "", "");
  SnapshotStoreTestAccess::FailedQuarantineRetainsOwnership(store);
}

TEST(SnapshotReliable, PersistenceFailureRetainsTaskUntilStorageRecovers) {
  auto path = std::filesystem::temp_directory_path() / ("archive-recover-" + NewUuid4());
  { std::ofstream blocked(path); blocked << "not a directory"; }
  SnapshotStore store(LazyCfg(0), "", "ainvr_snapshot_reuse_tests", "test", "", "", "", 1, false, path.string());
  auto saving = std::async(std::launch::async, [&] { SnapshotStoreTestAccess::PreserveOne(store); });
  EXPECT_EQ(saving.wait_for(std::chrono::milliseconds(100)), std::future_status::timeout);
  EXPECT_EQ(store.GetStats()["dropped_count"], 0);
  std::filesystem::remove(path);
  EXPECT_EQ(saving.wait_for(std::chrono::seconds(3)), std::future_status::ready);
  saving.get();
  EXPECT_EQ(store.GetStats()["delivery"]["outstanding"], 1);
  EXPECT_GT(store.GetStats()["pending_bytes"].get<size_t>(), 0u);
  std::filesystem::remove_all(path);
}

TEST(SnapshotReliable, OversizedSquareUsesBoundedOutputInsteadOfRejectingTarget) {
  auto cfg = LazyCfg(0); cfg.padding_ratio = 1;
  cv::Mat frame(32, 32, CV_8UC4, cv::Scalar(1, 2, 3, 255));
  Detection d; d.bbox = {-4000, -4000, 8000, 8000};
  SnapshotCropper cropper;
  auto crops = cropper.Crop(FrameProvider(frame), {d}, true, cfg);
  ASSERT_EQ(crops.size(), 1u);
  EXPECT_EQ(crops[0].size(), cv::Size(320, 320));
  EXPECT_FALSE(crops[0].empty());
}

TEST(SnapshotReliable, ChannelReservationsCannotBeConsumedByOtherChannels) {
  auto pool = std::make_shared<ArchiveCapacity::Pool>();
  pool->limit = 384;
  ArchiveCapacity large(pool), small(pool), extra(pool);
  large.Configure(118); small.Configure(30);
  EXPECT_EQ(pool->reserved, 296u);
  EXPECT_THROW(extra.Configure(118), std::runtime_error);
  EXPECT_EQ(large.Reserved(), 236u);
  EXPECT_EQ(small.Reserved(), 60u);
  large.Release();
  EXPECT_NO_THROW(extra.Configure(118));
}

TEST(SnapshotReliable, AdmissionWaitIsLocalAndDisableReleasesIt) {
  auto cfg = LazyCfg(0);
  SnapshotStore blocked(cfg, "", "ainvr_snapshot_reuse_tests", "test-blocked", "", "", "", 1);
  SnapshotStore free(cfg, "", "ainvr_snapshot_reuse_tests", "test-free", "", "", "", 1);
  cv::Mat frame(32, 32, CV_8UC4, cv::Scalar(1, 2, 3, 255));
  Detection d; d.bbox = {2, 2, 10, 10};
  blocked.Offer(FrameProvider(frame), "test-blocked", "", 1, 1, "m", "object_detection", {d}, {d}, false, cfg);
  auto waiting = std::async(std::launch::async, [&] { blocked.WaitForCapacity([] { return false; }); });
  EXPECT_EQ(waiting.wait_for(std::chrono::milliseconds(100)), std::future_status::timeout);
  auto ready = std::async(std::launch::async, [&] { free.WaitForCapacity([] { return false; }); });
  EXPECT_EQ(ready.wait_for(std::chrono::milliseconds(200)), std::future_status::ready);
  cfg.enabled = false; blocked.UpdateConfig(cfg);
  EXPECT_EQ(waiting.wait_for(std::chrono::milliseconds(300)), std::future_status::ready);
  waiting.get(); ready.get();
}

TEST(SnapshotLazyFrame, DownloadedOnceForManyDetections) {
  auto cfg = LazyCfg(0);
  // 不 Start():只验证 Offer 的节流/取帧/入队,不需要 Mongo
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1/unused", "ainvr_snapshot_reuse_tests", kTestChannelId, "x", "", "");
  cv::Mat frame(100, 100, CV_8UC4, cv::Scalar(1, 2, 3, 255));
  Detection a, b, c;
  a.bbox = {5, 5, 10, 10};
  b.bbox = {30, 30, 10, 10};
  c.bbox = {60, 60, 10, 10};
  int calls = 0;
  store.Offer(FrameProvider(frame, &calls), kTestChannelId, "x", 1, 1.0, "m", "object_detection",
              {a, b, c}, {a, b, c}, false, cfg);
  EXPECT_EQ(calls, 1);
  EXPECT_EQ(store.GetStats()["enqueued_count"], 3);
}

TEST(SnapshotLazyFrame, FullQueueBackpressuresAndShutdownPreservesPending) {
  auto cfg = LazyCfg(0);
  auto dir = std::filesystem::temp_directory_path() / ("snapshot-test-" + NewUuid4());
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1/unused", "ainvr_snapshot_reuse_tests",
                      kTestChannelId, "x", "", "", 1, false, dir.string());
  cv::Mat frame(100, 100, CV_8UC4, cv::Scalar(1, 2, 3, 255));
  Detection d;
  d.bbox = {5, 5, 10, 10};
  int calls = 0;
  auto provider = FrameProvider(frame, &calls);
  std::atomic<bool> cancelled{false};
  provider.cancelled = [&] { return cancelled.load(); };
  store.Offer(provider, kTestChannelId, "x", 1, 1, "m", "object_detection", {d}, {d}, false, cfg);
  auto pending = std::async(std::launch::async, [&] {
    store.Offer(provider, kTestChannelId, "x", 2, 2, "m", "object_detection", {d}, {d}, false, cfg);
  });
  EXPECT_EQ(pending.wait_for(std::chrono::milliseconds(100)), std::future_status::timeout);
  EXPECT_TRUE(store.GetStats()["backpressured"]);
  cancelled.store(true);
  EXPECT_EQ(pending.wait_for(std::chrono::seconds(3)), std::future_status::ready);
  pending.get();
  EXPECT_EQ(store.GetStats()["enqueued_count"], 1);
  EXPECT_EQ(store.GetStats()["dropped_count"], 0);
  EXPECT_EQ(std::distance(std::filesystem::directory_iterator(dir), std::filesystem::directory_iterator{}), 1);
  std::filesystem::remove_all(dir);
}

TEST(SnapshotLazyFrame, OfflineDatabaseSpoolsWithoutWaitingForReconnection) {
  auto cfg = LazyCfg(0);
  auto dir = std::filesystem::temp_directory_path() / ("snapshot-offline-" + NewUuid4());
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1/unused?serverSelectionTimeoutMS=100&connectTimeoutMS=100",
      "ainvr_snapshot_reuse_tests", kTestChannelId, "offline", "", "", 1, false, dir.string());
  store.Start();
  cv::Mat frame(100,100,CV_8UC4,cv::Scalar(1,2,3,255));
  Detection d; d.bbox={5,5,10,10};
  auto producer=std::async(std::launch::async,[&] {
    for(int i=0;i<8;++i)
      store.Offer(FrameProvider(frame),kTestChannelId,"offline",i,i,"test","object_detection",{d},{d},false,cfg);
  });
  auto completed=producer.wait_for(std::chrono::seconds(3));
  EXPECT_EQ(completed,std::future_status::ready);
  // Always unblock the old implementation too; a failing test must not hang.
  if(completed!=std::future_status::ready) store.RequestStop();
  producer.get();
  store.Stop();
  size_t count=0;
  if(std::filesystem::exists(dir)) for(auto& p:std::filesystem::directory_iterator(dir))
    if(p.path().extension()==".cbor") ++count;
  EXPECT_EQ(count,8);
  EXPECT_EQ(store.GetStats()["dropped_count"],0);
  std::filesystem::remove_all(dir);
}

TEST(SnapshotStoreEndToEnd, LowerLimitTrimsIdleDisabledArchiveWithoutNewFrames) {
  auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  auto cfg = LazyCfg(0); cfg.max_count = 100;
  SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "test", "", "", 64, false);
  store.Start(); store.Clear();
  cv::Mat frame(32, 32, CV_8UC4, cv::Scalar(12, 34, 56, 255));
  Detection d; d.bbox = {2, 2, 10, 10};
  std::vector<Detection> detections(20, d);
  store.Offer(FrameProvider(frame), kTestChannelId, "test", 1, 1, "m", "object_detection", detections, detections, false, cfg);
  for (int n = 0; n < 100 && store.GetStats()["written_count"].get<int>() < 20; ++n)
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  ASSERT_EQ(store.GetOverview()["count"], 20);
  cfg.enabled = false; store.UpdateConfig(cfg);
  std::this_thread::sleep_for(std::chrono::milliseconds(1200));
  cfg.max_count = 3; store.UpdateConfig(cfg);
  for (int n = 0; n < 60 && store.GetOverview()["count"].get<int>() != 3; ++n)
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_EQ(store.GetOverview()["count"], 3);
  store.QuiesceWriter(); store.Clear();
}

TEST(SnapshotStoreEndToEnd, InvalidCaptureAccountsForAllRemainingTargets) {
  auto cfg = LazyCfg(0);
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1/unused", "ainvr_snapshot_reuse_tests", kTestChannelId, "test", "", "", 2, false);
  cv::Mat frame(32, 32, CV_8UC4, cv::Scalar(0, 0, 0, 255));
  auto provider = FrameProvider(frame);
  provider.size = {40000, 40000};  // Rejected before allocation or download.
  Detection d; d.bbox = {2, 2, 10, 10};
  std::vector<Detection> detections(20, d);
  store.Offer(provider, kTestChannelId, "test", 1, 1, "m", "object_detection", detections, detections, false, cfg);
  const auto stats = store.GetStats();
  EXPECT_EQ(stats["delivery"]["accepted"], 0);
  EXPECT_EQ(stats["delivery"]["capture_failed"], 20);
  EXPECT_EQ(stats["delivery"]["attempted"], 20);
  EXPECT_EQ(stats["dropped_count"], 20);
  EXPECT_EQ(stats["healthy"], false);
}

TEST(SnapshotStoreEndToEnd, EveryDetectedTargetSurvivesSmallQueueAndLargeBatch) {
  auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  auto cfg = LazyCfg(0); cfg.max_count = 1000;
  SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "test", "", "", 2, false);
  store.Start(); store.Clear();
  cv::Mat frame(32, 32, CV_8UC4, cv::Scalar(12, 34, 56, 255));
  Detection d; d.bbox = {2, 2, 10, 10};
  std::vector<Detection> detections(70, d);
  store.Offer(FrameProvider(frame), kTestChannelId, "test", 1, 1, "m", "object_detection", detections, detections, false, cfg);
  for (int n = 0; n < 100 && store.GetStats()["written_count"].get<int>() < 70; ++n)
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_EQ(store.GetOverview()["count"], 70);
  EXPECT_EQ(store.GetStats()["dropped_count"], 0);
  const auto delivery = store.GetStats()["delivery"];
  EXPECT_EQ(delivery["accepted"], 70);
  EXPECT_EQ(delivery["committed"], 70);
  EXPECT_EQ(delivery["outstanding"], 0);
  store.QuiesceWriter(); store.Clear();
}

TEST(SnapshotStoreEndToEnd, PendingReplayIsIdempotentAfterAmbiguousWrite) {
  auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  auto cfg = LazyCfg(0);
  auto dir = std::filesystem::temp_directory_path() / ("snapshot-replay-" + NewUuid4());
  cv::Mat frame(32, 32, CV_8UC4, cv::Scalar(12, 34, 56, 255));
  Detection d; d.bbox = {2, 2, 10, 10};
  {
    SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "test", "", "", 2, false, dir.string());
    auto provider = FrameProvider(frame); provider.cancelled = [] { return true; };
    store.Offer(provider, kTestChannelId, "test", 3, 3, "m", "object_detection", {d}, {d}, false, cfg);
  }
  auto file = std::filesystem::directory_iterator(dir)->path();
  std::ifstream input(file, std::ios::binary);
  std::vector<char> bytes((std::istreambuf_iterator<char>(input)), {});
  for (int pass = 0; pass < 2; ++pass) {
    if (pass) { std::ofstream out(file, std::ios::binary); out.write(bytes.data(), bytes.size()); }
    SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "test", "", "", 2, false, dir.string());
    store.Start();
    for (int n = 0; n < 100 && store.GetStats()["written_count"].get<int>() < 1; ++n)
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    EXPECT_EQ(store.GetStats()["written_count"], 1);
    EXPECT_EQ(store.GetOverview()["count"], 1);
    EXPECT_FALSE(std::filesystem::exists(file));
    store.QuiesceWriter();
    if (pass) store.Clear();
  }
  std::filesystem::remove_all(dir);
}

TEST(SnapshotStoreEndToEnd, QueuedTargetsShareJournalAcknowledgements) {
  auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  auto cfg = LazyCfg(0); cfg.max_count = 1000;
  SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "test", "", "", 64, false);
  cv::Mat frame(32, 32, CV_8UC4, cv::Scalar(12, 34, 56, 255));
  Detection d; d.bbox = {2, 2, 10, 10};
  std::vector<Detection> detections(32, d);
  store.Offer(FrameProvider(frame), kTestChannelId, "test", 1, 1, "m", "object_detection", detections, detections, false, cfg);
  store.Start();
  for (int n = 0; n < 100 && store.GetStats()["written_count"].get<int>() < 32; ++n)
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_EQ(store.GetOverview()["count"], 32);
  EXPECT_EQ(store.GetStats()["dropped_count"], 0);
  EXPECT_LE(store.GetStats()["mongo_write_batches"].get<int>(), 3);
  store.QuiesceWriter(); store.Clear();
}

TEST(SnapshotLazyFrame, LegacyIntervalIsIgnoredButDisableAndEmptyResultsStillWork) {
  auto cfg = LazyCfg(60000);
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1/unused", "ainvr_snapshot_reuse_tests", kTestChannelId, "x", "", "");
  cv::Mat frame(100, 100, CV_8UC4, cv::Scalar(1, 2, 3, 255));
  Detection d;
  d.bbox = {5, 5, 10, 10};
  int calls = 0;
  auto provider = FrameProvider(frame, &calls);
  store.Offer(provider, kTestChannelId, "x", 1, 1.0, "m", "object_detection", {d}, {d}, false, cfg);
  EXPECT_EQ(calls, 1);
  // Legacy sampling configuration cannot discard the second inference.
  store.Offer(provider, kTestChannelId, "x", 2, 2.0, "m", "object_detection", {d}, {d}, false, cfg);
  EXPECT_EQ(calls, 2);
  // 没有检测结果:不下载
  auto no_throttle = LazyCfg(0);
  store.Offer(provider, kTestChannelId, "x", 3, 3.0, "m", "object_detection", {}, {}, false, no_throttle);
  EXPECT_EQ(calls, 2);
  // 归档关闭:不下载
  auto off = LazyCfg(0);
  off.enabled = false;
  store.Offer(provider, kTestChannelId, "x", 4, 4.0, "m", "object_detection", {d}, {d}, false, off);
  EXPECT_EQ(calls, 2);
}

TEST(SnapshotRegionCrop, ErpMatchesOriginalAcrossSeamsPolesAndFractionalBoxes) {
  cv::Mat frame(384, 768, CV_8UC4);
  cv::RNG rng(413);
  rng.fill(frame, cv::RNG::UNIFORM, 0, 256);
  auto cfg = LazyCfg(0);
  cfg.projection_mode = "erp_equirect";
  cfg.max_crop_dimension = 320;
  std::vector<std::array<double, 4>> boxes = {{384,192,20,20}, {0,170,25,30},
      {740,180,28,30}, {375,0,30,15}, {375,360,30,24}, {300,150,100,70}};
  for (int i = 0; i < 24; ++i)
    boxes.push_back({rng.uniform(0., 720.), rng.uniform(0., 330.), rng.uniform(1., 48.), rng.uniform(1., 48.)});
  for (bool square : {false, true}) for (auto bbox : boxes) {
    SnapshotCropper cropper;
    Detection d; d.bbox = bbox;
    int downloads = 0;
    auto crops = cropper.Crop(FrameProvider(frame, &downloads), {d}, square, cfg);
    auto v = BboxToErpView(bbox, cfg.padding_ratio, frame.cols, frame.rows, 320, 9, square).value();
    auto ss = ScaleErpView(v, 1.5);
    ErpMapCache cache;
    auto [mx, my] = cache.GetOrBuild(frame.cols, frame.rows, ss);
    auto big = SampleErpPerspective(frame, mx, my);
    cv::Mat expected;
    cv::resize(big, expected, {v.w_out, v.h_out}, 0, 0, cv::INTER_CUBIC);
    ASSERT_EQ(crops.size(), 1);
    ASSERT_EQ(crops[0].size(), expected.size());
    EXPECT_EQ(cv::norm(crops[0], expected, cv::NORM_INF), 0) << square << " " << bbox[0] << "," << bbox[1];
    EXPECT_EQ(downloads, 1);
  }
}

TEST(SnapshotRegionCrop, SmallErpDownloadsRegionAndMultipleTargetsShareOneDownload) {
  cv::Mat frame(384, 768, CV_8UC4, cv::Scalar(11, 22, 33, 255));
  auto cfg = LazyCfg(0); cfg.projection_mode = "erp_equirect";
  Detection a,b; a.bbox={300,180,20,20}; b.bbox={320,180,20,20};
  SnapshotCropper cropper;
  int calls=0;
  auto first=cropper.Crop(FrameProvider(frame,&calls), {a,b}, true,cfg);
  EXPECT_EQ(calls,1);
  EXPECT_LT(cropper.downloaded_bytes(), frame.total()*frame.elemSize()/4);
  EXPECT_FALSE(cropper.full_frame());
  auto saved=first[0].clone();
  frame.setTo(cv::Scalar(100,100,100,255));
  cropper.Crop(FrameProvider(frame),{a,b},true,cfg);
  EXPECT_EQ(cv::norm(first[0],saved,cv::NORM_INF),0); // queued images do not alias reusable host
  cv::Mat changed(192,384,CV_8UC4,cv::Scalar(1,2,3,255));
  EXPECT_NO_THROW(cropper.Crop(FrameProvider(changed),{a},true,cfg));
}

TEST(SnapshotRegionCrop, OrdinaryPaddingMatchesOriginalAndRejectsInvalidBoxes) {
  cv::Mat frame(90,120,CV_8UC4);cv::randu(frame,0,256);
  auto cfg=LazyCfg(0); cfg.max_crop_dimension=32;
  for(bool square:{false,true}) for(auto bbox:std::vector<std::array<double,4>>{
      {-4.5,2.5,25.5,40.5},{99.5,70.5,30.,30.},{10,10,5,7}}) {
    SnapshotCropper cropper;Detection d;d.bbox=bbox;
    auto out=cropper.Crop(FrameProvider(frame),{d},square,cfg);
    auto expected=CropWithPadding(frame,bbox,cfg.padding_ratio,32,square);
    EXPECT_EQ(cv::norm(out[0],expected,cv::NORM_INF),0);
  }
  SnapshotCropper cropper;Detection bad;bad.bbox={std::numeric_limits<double>::quiet_NaN(),0,10,10};
  int calls=0;auto out=cropper.Crop(FrameProvider(frame,&calls),{bad},false,cfg);
  EXPECT_TRUE(out[0].empty());EXPECT_EQ(calls,0);
  EXPECT_THROW(cropper.Crop({{40000,40000},{}},{bad},false,cfg),std::invalid_argument);
  cfg.max_crop_dimension=100000; // a high ceiling must not reject a small actual crop
  Detection small;small.bbox={10,10,5,7};
  auto small_out=cropper.Crop(FrameProvider(frame),{small},true,cfg);
  EXPECT_FALSE(small_out[0].empty());
}

TEST(SnapshotRegionCrop, MapBudgetFallsBackOnceAndKeepsPixels) {
  cv::Mat frame(384,768,CV_8UC4);cv::randu(frame,0,256);
  auto cfg=LazyCfg(0);cfg.projection_mode="erp_equirect";cfg.max_crop_dimension=640;
  std::vector<Detection> detections(16);
  for(size_t i=0;i<detections.size();i++)detections[i].bbox={double(i*15),20,600,300};
  SnapshotCropper cropper;int calls=0;
  auto out=cropper.Crop(FrameProvider(frame,&calls),detections,true,cfg);
  EXPECT_TRUE(cropper.full_frame());EXPECT_EQ(calls,1);
  ErpMapCache reference_cache;
  for(size_t i=0;i<detections.size();i++) {
    auto v=BboxToErpView(detections[i].bbox,cfg.padding_ratio,768,384,640,9,true).value();
    auto ss=ScaleErpView(v,1.5);auto [mx,my]=reference_cache.GetOrBuild(768,384,ss);
    auto big=SampleErpPerspective(frame,mx,my);cv::Mat expected;
    cv::resize(big,expected,{v.w_out,v.h_out},0,0,cv::INTER_CUBIC);
    EXPECT_EQ(cv::norm(out[i],expected,cv::NORM_INF),0);
  }
}

#ifdef AINVR_CUDA_REFERENCE_TESTS
TEST(SnapshotRegionGpu, Real8KDownloadKeepsPixelsAndReportsCost) {
  const char* enabled = std::getenv("AI_SERVICE_GPU_TESTS");
  if (!enabled || std::string(enabled) != "1")
    GTEST_SKIP() << "Set AI_SERVICE_GPU_TESTS=1 in an isolated GPU maintenance window";
  const char* benchmark = std::getenv("AI_SERVICE_CROP_BENCHMARK");
  const bool measure = benchmark && std::string(benchmark) == "1";
  const int warmup = measure ? 2 : 0;
  const int samples = measure ? 10 : 1;
  if(cv::cuda::getCudaEnabledDeviceCount()==0)GTEST_SKIP()<<"CUDA required";
  cv::Mat frame(3840,7680,CV_8UC4);cv::RNG rng(20261003);rng.fill(frame,cv::RNG::UNIFORM,0,256);
  cv::cuda::GpuMat device;device.upload(frame);
  auto cfg=LazyCfg(0);cfg.projection_mode="erp_equirect";cfg.max_crop_dimension=640;
  for(auto bbox:std::vector<std::array<double,4>>{{3840,1920,200,200},{20,1800,200,200},
      {7400,1800,240,240},{3800,10,300,150},{3800,3600,300,180},{3500,1500,800,700}}) {
    Detection d;d.bbox=bbox;SnapshotCropper cropper;ErpMapCache cache;
    pipeline::SnapshotSink::FrameProvider provider{device.size(),[&](const cv::Rect&r,cv::Mat&dst){device(r).download(dst);}};
    auto v=BboxToErpView(bbox,cfg.padding_ratio,7680,3840,640,9,true).value();
    auto ss=ScaleErpView(v,1.5);auto [mx,my]=cache.GetOrBuild(7680,3840,ss);
    double old_ms=0,new_ms=0;
    for(int i=0;i<warmup+samples;i++) {
      auto start=std::chrono::steady_clock::now();cv::Mat host;device.download(host);
      auto big=SampleErpPerspective(host,mx,my);cv::Mat expected;
      cv::resize(big,expected,{v.w_out,v.h_out},0,0,cv::INTER_CUBIC);
      auto mid=std::chrono::steady_clock::now();auto out=cropper.Crop(provider,{d},true,cfg);
      auto end=std::chrono::steady_clock::now();
      ASSERT_EQ(cv::norm(out[0],expected,cv::NORM_INF),0);
      if(i>=warmup){old_ms+=std::chrono::duration<double,std::milli>(mid-start).count();new_ms+=std::chrono::duration<double,std::milli>(end-mid).count();}
    }
    if(measure) std::cout<<"CROP_BENCH "<<json{{"x",bbox[0]},{"y",bbox[1]},{"old_mean_ms",old_ms/samples},
      {"new_mean_ms",new_ms/samples},{"download_bytes",cropper.downloaded_bytes()}}.dump()<<std::endl;
  }
}
#endif

TEST(SnapshotLazyFrame, DownloadFailureIsContainedAndNextOfferRecovers) {
  auto cfg=LazyCfg(1);
  SnapshotStore store(cfg,"mongodb://127.0.0.1:1/unused","ainvr_snapshot_reuse_tests",kTestChannelId,"x","","",1,false);
  Detection d;d.bbox={5,5,10,10};
  pipeline::SnapshotSink::FrameProvider broken{{100,100},[](const cv::Rect&,cv::Mat&){throw std::runtime_error("test download failed");}};
  broken.cancelled = [] { return true; };
  EXPECT_NO_THROW(store.Offer(broken,kTestChannelId,"x",1,1,"m","object_detection",{d},{d},false,cfg));
  EXPECT_EQ(store.GetStats()["crop_error_count"],1);
  EXPECT_EQ(store.GetStats().value("crop_failed_count", int64_t(-1)),1);
  EXPECT_EQ(store.GetStats()["dropped_count"],1);
  cv::Mat frame(100,100,CV_8UC4,cv::Scalar(1,2,3,255));
  std::this_thread::sleep_for(std::chrono::milliseconds(2));
  store.Offer(FrameProvider(frame),kTestChannelId,"x",2,2,"m","object_detection",{d},{d},false,cfg);
  EXPECT_EQ(store.GetStats()["enqueued_count"],1);
}

TEST(SnapshotLazyFrame, EveryFrameRetriesSameImageAfterTransientDownloadFailure) {
  auto cfg = LazyCfg(0);
  SnapshotStore store(cfg,"mongodb://127.0.0.1:1/unused","ainvr_snapshot_reuse_tests",kTestChannelId,"x","","",1,false);
  Detection d; d.bbox={5,5,10,10};
  cv::Mat image(100,100,CV_8UC4,cv::Scalar(1,2,3,255));
  int attempts = 0;
  pipeline::SnapshotSink::FrameProvider provider{image.size(), [&](const cv::Rect& roi, cv::Mat& out) {
    if (++attempts == 1) throw std::runtime_error("transient download failure");
    image(roi).copyTo(out);
  }};
  store.Offer(provider,kTestChannelId,"x",1,1,"m","object_detection",{d},{d},false,cfg);
  EXPECT_EQ(attempts,2);
  EXPECT_EQ(store.GetStats()["enqueued_count"],1);
  EXPECT_EQ(store.GetStats()["dropped_count"],0);
}

TEST(SnapshotLazyFrame, RejectionReasonsAreSeparateFromQueuePressure) {
  auto cfg = LazyCfg(1);  // legacy input must still use reliable admission
  SnapshotStore store(cfg,"mongodb://127.0.0.1:1/unused","ainvr_snapshot_reuse_tests",kTestChannelId,"x","","",1,false);
  cv::Mat frame(100,100,CV_8UC4,cv::Scalar(1,2,3,255));
  Detection bad; bad.bbox={0,0,-1,10};
  store.Offer(FrameProvider(frame),kTestChannelId,"x",1,1,"m","object_detection",{bad},{bad},false,cfg);
  EXPECT_EQ(store.GetStats().value("invalid_crop_count",int64_t(-1)),1);
  EXPECT_EQ(store.GetStats().value("queue_full_drop_count",int64_t(-1)),0);
  Detection good; good.bbox={5,5,10,10};
  std::this_thread::sleep_for(std::chrono::milliseconds(2));
  store.Offer(FrameProvider(frame),kTestChannelId,"x",2,2,"m","object_detection",{good},{good},false,cfg);
  EXPECT_EQ(store.GetStats().value("queue_full_drop_count",int64_t(-1)),0);
  EXPECT_EQ(store.GetStats()["dropped_count"],1);
}

TEST(SnapshotLazyFrame, StatsLogDoesNotSuppressFirstFailureAndFailuresAreLimited) {
  auto cfg = LazyCfg(1);
  SnapshotStore store(cfg,"mongodb://127.0.0.1:1/unused","ainvr_snapshot_reuse_tests",kTestChannelId,"x","","",3,false);
  cv::Mat frame(100,100,CV_8UC4,cv::Scalar(1,2,3,255));
  Detection d; d.bbox={5,5,10,10};
  testing::internal::CaptureStderr();
  store.Offer(FrameProvider(frame),kTestChannelId,"x",1,1,"m","object_detection",{d},{d},false,cfg);
  auto stats_log = testing::internal::GetCapturedStderr();
  EXPECT_NE(stats_log.find("snapshot_crop"),std::string::npos);
  pipeline::SnapshotSink::FrameProvider broken{{100,100},[](const cv::Rect&,cv::Mat&){throw std::runtime_error("probe_failure");}};
  broken.cancelled = [] { return true; };
  testing::internal::CaptureStderr();
  for(int i=0;i<2;++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
    store.Offer(broken,kTestChannelId,"x",2,2,"m","object_detection",{d},{d},false,cfg);
  }
  auto errors = testing::internal::GetCapturedStderr();
  auto pos = errors.find("snapshot crop failed");
  ASSERT_NE(pos,std::string::npos);
  EXPECT_EQ(errors.find("snapshot crop failed",pos+1),std::string::npos);
}

TEST(SnapshotLazyFrame, InternalBudgetRejectionIsObservableWithoutDownload) {
  auto cfg = LazyCfg(0); cfg.projection_mode="erp_equirect"; cfg.max_crop_dimension=4096;
  SnapshotStore store(cfg,"mongodb://127.0.0.1:1/unused","ainvr_snapshot_reuse_tests",kTestChannelId,"x","","",3,false);
  int downloads=0;
  pipeline::SnapshotSink::FrameProvider provider{{7680,3840},[&](const cv::Rect&,cv::Mat&){++downloads;}};
  Detection d; d.bbox={1000,1000,2500,2500};
  store.Offer(provider,kTestChannelId,"x",1,1,"m","object_detection",{d},{d},true,cfg);
  EXPECT_EQ(downloads,0);
  EXPECT_EQ(store.GetStats().value("budget_drop_count",int64_t(-1)),0);
  EXPECT_EQ(store.GetStats()["dropped_count"],1);
}

// ---- image_id:uuid4 契约 ----

TEST(SnapshotImageId, NewUuid4MatchesRfc4122Version4) {
  for (int i = 0; i < 1000; ++i) {
    auto id = NewUuid4();
    ASSERT_TRUE(IsUuid4(id)) << id;
  }
}

TEST(SnapshotImageId, NewUuid4IsUniqueAcrossThreads) {
  std::set<std::string> ids;
  std::mutex m;
  std::vector<std::thread> threads;
  for (int t = 0; t < 4; ++t) {
    threads.emplace_back([&] {
      std::vector<std::string> local;
      for (int i = 0; i < 5000; ++i) local.push_back(NewUuid4());
      std::lock_guard<std::mutex> lock(m);
      ids.insert(local.begin(), local.end());
    });
  }
  for (auto& th : threads) th.join();
  EXPECT_EQ(ids.size(), 20000u);
}

// ---- 热更新:max_count 不必等下一帧检测结果才生效 ----

TEST(SnapshotStoreHotConfig, UpdateConfigTakesEffectWithoutOffer) {
  config::SnapshotConfig cfg;
  cfg.enabled = true;
  cfg.max_count = 100;
  // 不 Start():未连接状态下 GetOverview 走 NotConnectedOverview,只读 cfg_。
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1/unused", "ainvr_snapshot_reuse_tests", kTestChannelId, "x",
                      "", "");
  EXPECT_EQ(store.GetOverview()["max_count"], 100);
  cfg.max_count = 7;
  store.UpdateConfig(cfg);
  EXPECT_EQ(store.GetOverview()["max_count"], 7);
}

TEST(SnapshotStoreHotConfig, DisabledGateRejectsStaleInferenceConfigBeforeDownload) {
  auto cfg = LazyCfg(0);
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1/unused", "ainvr_snapshot_reuse_tests", kTestChannelId, "x", "", "");
  auto off = cfg; off.enabled = false; store.UpdateConfig(off);
  int downloads = 0;
  cv::Mat source(128, 128, CV_8UC4, cv::Scalar(1, 2, 3, 255));
  Detection d; d.bbox = {20, 20, 40, 40};
  store.Offer(FrameProvider(source, &downloads), kTestChannelId, "x", 1, 1,
              "m", "object_detection", {d}, {d}, false, cfg);
  EXPECT_EQ(downloads, 0);
  EXPECT_EQ(store.GetStats()["enqueued_count"], 0);
  EXPECT_EQ(store.GetStats()["enabled"], false);
}

TEST(SnapshotStoreHotConfig, DisabledRestartKeepsHistoryAndCanResumeCapture) {
  auto uri = TestMongoUri(); if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  auto cfg = LazyCfg(0); cfg.brightness_enabled = false;
  cv::Mat source(128, 128, CV_8UC4, cv::Scalar(20, 30, 40, 255));
  Detection d; d.bbox = {20, 20, 40, 40};
  auto offer = [&](SnapshotStore& store, const config::SnapshotConfig& current) {
    store.Offer(FrameProvider(source), kTestChannelId, "toggle", 1, 1,
                "m", "object_detection", {d}, {d}, false, current);
  };
  std::string image_id;
  {
    SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "toggle", "", "", 64, false);
    store.Start(); store.Clear(); offer(store, cfg);
    for (int i = 0; i < 100 && store.GetStats()["written_count"].get<int>() < 1; ++i)
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    auto page = store.ListPage({}, 10, 0, {}, {});
    ASSERT_EQ(page["items"].size(), 1);
    image_id = page["items"][0]["image_id"];
    cfg.enabled = false; store.UpdateConfig(cfg); offer(store, cfg);
    EXPECT_EQ(store.GetStats()["enqueued_count"], 1);
    EXPECT_TRUE(store.GetImage(image_id));
  }
  SnapshotStore restored(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "toggle", "", "", 64, false);
  restored.Start(/*keep_history_access=*/true);
  EXPECT_EQ(restored.GetOverview()["count"], 1);
  EXPECT_TRUE(restored.GetImage(image_id));
  EXPECT_TRUE(restored.GetImage(image_id, true));
  offer(restored, cfg);
  EXPECT_EQ(restored.GetStats()["enqueued_count"], 0);
  cfg.enabled = true; restored.UpdateConfig(cfg); offer(restored, cfg);
  for (int i = 0; i < 100 && restored.GetStats()["written_count"].get<int>() < 1; ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_EQ(restored.GetOverview()["count"], 2);
  restored.QuiesceWriter(); restored.Clear();
}

TEST(SnapshotAsyncArchive, CaptureOwnsPixelsAndConfigWhileWorkersAreBlocked) {
  auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  auto cfg = LazyCfg(0); cfg.brightness_enabled = true; cfg.brightness_target = 220;
  SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "async", "", "", 64, false);
  store.Start(); store.Clear();
  std::promise<void> release;
  auto gate = release.get_future().share();
  std::atomic<int> entered{0};
  std::vector<std::future<void>> blockers;
  for (size_t i = 0; i < ArchiveWorkerCount(); ++i)
    blockers.push_back(SharedArchiveExecutor().Submit([&] { ++entered; gate.wait(); }));
  while (size_t(entered.load()) != ArchiveWorkerCount()) std::this_thread::yield();
  cv::Mat source(128, 128, CV_8UC4, cv::Scalar(12, 24, 36, 255));
  Detection d; d.bbox = {20,20,40,40};
  auto expected = CropWithPadding(source, d.bbox, cfg.padding_ratio, cfg.max_crop_dimension);
  cv::Mat bgr; cv::cvtColor(expected, bgr, cv::COLOR_RGBA2BGR);
  std::vector<uint8_t> original;
  EncodeSnapshotJpeg(bgr, original, cfg.jpeg_quality);
  int downloads = 0;
  store.Offer(FrameProvider(source, &downloads), kTestChannelId, "async", 1, 1,
              "m", "object_detection", {d,d,d,d}, {d,d,d,d}, false, cfg);
  const auto during = store.GetStats();
  source.setTo(cv::Scalar(255,255,255,255));
  cfg.brightness_enabled = false; store.UpdateConfig(cfg);
  release.set_value();
  for (auto& future : blockers) future.get();
  EXPECT_EQ(during["captured_count"], 1);
  EXPECT_EQ(during["written_count"], 0);
  EXPECT_EQ(downloads, 1);
  for (int i = 0; i < 100 && store.GetStats()["written_count"].get<int>() < 4; ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  auto page = store.ListPage({}, 10, 0, {}, {});
  ASSERT_EQ(page["items"].size(), 4);
  for (const auto& item : page["items"]) {
    auto id = item["image_id"].get<std::string>();
    auto raw = store.GetImage(id, true), processed = store.GetImage(id);
    ASSERT_TRUE(raw); ASSERT_TRUE(processed);
    EXPECT_EQ(*raw, original);
    EXPECT_NE(*processed, original);
  }
  EXPECT_EQ(store.GetStats()["captured_frames"], 0);
  EXPECT_EQ(store.GetStats()["dropped_count"], 0);
  store.QuiesceWriter(); store.Clear();
}

TEST(SnapshotAsyncArchive, Sparse8KTargetKeepsSmallRegionDownload) {
  auto uri=TestMongoUri();if(uri.empty())GTEST_SKIP()<<kNoMongoReason;
  auto cfg=LazyCfg(0);cfg.projection_mode="erp_equirect";cfg.brightness_enabled=false;
  SnapshotStore store(cfg,uri,"ainvr_snapshot_reuse_tests",kTestChannelId,"sparse","","",64,false);
  store.Start();store.Clear();
  Detection d;d.bbox={3800,1900,30,30};
  cv::Rect downloaded;
  pipeline::SnapshotSink::FrameProvider provider{{7680,3840},[&](const cv::Rect& roi,cv::Mat& dst) {
    downloaded=roi;dst=cv::Mat(roi.size(),CV_8UC4,cv::Scalar(1,2,3,255));
  }};
  store.Offer(provider,kTestChannelId,"sparse",1,1,"m","face_detection",{d},{d},true,cfg);
  EXPECT_LT(downloaded.area(),7680*3840/100);
  EXPECT_EQ(store.GetStats()["captured_count"],0);
  for(int n=0;n<100 && store.GetStats()["written_count"].get<int>()<1;++n)
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
  EXPECT_EQ(store.GetStats()["written_count"],1);
  store.QuiesceWriter();store.Clear();
}

TEST(SnapshotAsyncArchive, CaptureLimitCancellationPersistsAllFramesAndReplays) {
  auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  auto cfg = LazyCfg(0); cfg.brightness_enabled = false;
  auto dir = std::filesystem::temp_directory_path() / ("snapshot-async-" + NewUuid4());
  {
    SnapshotStore store(cfg, "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=100", "ainvr_snapshot_reuse_tests",
                        kTestChannelId, "offline", "", "", 64, false, dir.string());
    SnapshotStoreTestAccess::StartDisconnectedWriterForBackpressureTest(store);
    cv::Mat image(64,64,CV_8UC4,cv::Scalar(1,2,3,255));
    Detection d; d.bbox={10,10,20,20};
    std::atomic<bool> cancel{false};
    auto provider = FrameProvider(image); provider.cancelled = [&] { return cancel.load(); };
    for (int i = 0; i < 2; ++i)
      store.Offer(provider,kTestChannelId,"offline",i,i,"m","object_detection",{d},{d},false,cfg);
    auto third = std::async(std::launch::async, [&] {
      store.Offer(provider,kTestChannelId,"offline",3,3,"m","object_detection",{d},{d},false,cfg);
    });
    EXPECT_EQ(third.wait_for(std::chrono::milliseconds(150)),std::future_status::timeout);
    EXPECT_EQ(store.GetStats()["captured_frames"],2);
    cancel.store(true);
    EXPECT_EQ(third.wait_for(std::chrono::seconds(5)),std::future_status::ready);
    third.get();
    store.QuiesceWriter();
    EXPECT_EQ(store.GetStats()["captured_frames"],0);
    EXPECT_EQ(store.GetStats()["dropped_count"],0);
  }
  EXPECT_EQ(std::distance(std::filesystem::directory_iterator(dir),std::filesystem::directory_iterator{}),3);
  SnapshotStore recovered(cfg,uri,"ainvr_snapshot_reuse_tests",kTestChannelId,"replay","","",64,false,dir.string());
  // Clear test collection before replay starts.
  config::SnapshotStoreConfig sc; sc.mongo_uri=uri; sc.db_name="ainvr_snapshot_reuse_tests";
  SnapshotStore::DropChannelHistory(sc,kTestChannelId);
  recovered.Start();
  for(int i=0;i<100 && recovered.GetStats()["written_count"].get<int>()<3;++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_EQ(recovered.GetOverview()["count"],3);
  EXPECT_EQ(recovered.GetStats()["write_error_count"],0);
  recovered.QuiesceWriter(); recovered.Clear();
  std::filesystem::remove_all(dir);
}

TEST(SnapshotAsyncArchive, WorkerExceptionsDoNotKillPoolOrLoseFollowingTasks) {
  ArchiveExecutor pool(2,2);
  auto failed = pool.Submit([] { throw std::runtime_error("expected"); });
  std::atomic<int> done{0};
  std::vector<std::future<void>> work;
  for(int i=0;i<20;++i) work.push_back(pool.Submit([&] { ++done; }));
  EXPECT_THROW(failed.get(),std::runtime_error);
  for(auto& f:work)f.get();
  EXPECT_EQ(done.load(),20);
}

TEST(SnapshotAsyncArchive, PreparesNextFrameWhileHistoryWriteIsBlocked) {
  auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  auto cfg = LazyCfg(0); cfg.brightness_enabled = false;
  SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "overlap", "", "", 64, false);
  store.Start(); store.Clear();
  ASSERT_TRUE(SnapshotStoreTestAccess::WaitForInitialTrim(store));
  auto blocked_write = SnapshotStoreTestAccess::HoldHistory(store);
  cv::Mat image(64, 64, CV_8UC4, cv::Scalar(1, 2, 3, 255));
  Detection d; d.bbox = {10, 10, 20, 20};
  store.Offer(FrameProvider(image), kTestChannelId, "overlap", 1, 1, "m", "object_detection", {d}, {d}, false, cfg);
  for (int i = 0; i < 100 && store.GetStats()["prepared_count"].get<int>() < 1; ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  store.Offer(FrameProvider(image), kTestChannelId, "overlap", 2, 2, "m", "object_detection", {d}, {d}, false, cfg);
  for (int i = 0; i < 100 && store.GetStats()["prepared_count"].get<int>() < 2; ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  EXPECT_EQ(store.GetStats()["prepared_count"], 2);
  EXPECT_EQ(store.GetStats()["written_count"], 0);
  blocked_write.unlock();
  for (int i = 0; i < 100 && store.GetStats()["written_count"].get<int>() < 2; ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  EXPECT_EQ(store.GetStats()["written_count"], 2);
  EXPECT_EQ(store.GetStats()["dropped_count"], 0);
  store.QuiesceWriter(); store.Clear();
}

TEST(SnapshotAsyncArchive, StopPersistsPreparedAheadAndRawQueueWithoutDuplicates) {
  auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  auto cfg = LazyCfg(0); cfg.brightness_enabled = false;
  auto dir = std::filesystem::temp_directory_path() / ("snapshot-ahead-" + NewUuid4());
  {
    SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "overlap", "", "", 64, false, dir.string());
    store.Start(); store.Clear();
    // Block the write under test, not the asynchronous startup reconciliation.
    ASSERT_TRUE(SnapshotStoreTestAccess::WaitForInitialTrim(store));
    auto blocked_write = SnapshotStoreTestAccess::HoldHistory(store);
    cv::Mat image(64, 64, CV_8UC4, cv::Scalar(1, 2, 3, 255));
    Detection d; d.bbox = {10, 10, 20, 20};
    auto offer = [&](int n) {
      store.Offer(FrameProvider(image), kTestChannelId, "overlap", n, n, "m", "object_detection", {d}, {d}, false, cfg);
    };
    offer(1);
    for (int i = 0; i < 100 && store.GetStats()["prepared_count"].get<int>() < 1; ++i)
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    offer(2);
    for (int i = 0; i < 100 && store.GetStats()["prepared_ahead_targets"].get<int>() < 1; ++i)
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    ASSERT_EQ(store.GetStats()["prepared_ahead_targets"], 1);
    offer(3);
    EXPECT_EQ(store.GetStats()["queue_depth"], 1);
    store.RequestStop();
    blocked_write.unlock();
    store.QuiesceWriter();
    EXPECT_EQ(store.GetStats()["dropped_count"], 0);
    EXPECT_EQ(store.GetStats()["captured_frames"], 0);
  }
  int pending_count=0;
  for(const auto& file:std::filesystem::directory_iterator(dir))
    if(file.path().extension()==".cbor")++pending_count;
  EXPECT_EQ(pending_count, 2); // Clear() also persists deletions.json.
  SnapshotStore replay(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "replay", "", "", 64, false, dir.string());
  replay.Start();
  for (int i = 0; i < 100 && replay.GetStats()["written_count"].get<int>() < 2; ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  EXPECT_EQ(replay.GetOverview()["count"], 3);
  replay.QuiesceWriter(); replay.Clear();
  std::filesystem::remove_all(dir);
}

TEST(SnapshotStoreHotConfig, DisableReleasesBlockedOfferAndPreservesAcceptedJobs) {
  for (size_t capacity : {size_t(1), size_t(64)}) {
    auto cfg = LazyCfg(0);
    cfg.brightness_enabled = false;
    auto dir = std::filesystem::temp_directory_path() / ("snapshot-disable-" + NewUuid4());
    SnapshotStore store(cfg, "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=100",
                        "ainvr_snapshot_reuse_tests", kTestChannelId, "offline", "", "", capacity, false, dir.string());
    SnapshotStoreTestAccess::StartDisconnectedWriterForBackpressureTest(store);
    cv::Mat image(64, 64, CV_8UC4, cv::Scalar(1, 2, 3, 255));
    Detection d; d.bbox = {10, 10, 20, 20};
    std::atomic<bool> cancel{false};
    auto provider = FrameProvider(image);
    provider.cancelled = [&] { return cancel.load(); };
    const int queued = capacity == 1 ? 1 : 2;
    for (int i = 0; i < queued; ++i)
      store.Offer(provider, kTestChannelId, "offline", i, i, "m", "object_detection", {d}, {d}, false, cfg);
    auto blocked = std::async(std::launch::async, [&] {
      store.Offer(provider, kTestChannelId, "offline", 3, 3, "m", "object_detection", {d}, {d}, false, cfg);
    });
    EXPECT_EQ(blocked.wait_for(std::chrono::milliseconds(150)), std::future_status::timeout);
    auto disabled = cfg; disabled.enabled = false;
    store.UpdateConfig(disabled);
    const auto result = blocked.wait_for(std::chrono::milliseconds(200));
    EXPECT_EQ(result, std::future_status::ready);
    cancel.store(true);  // Bound cleanup on the unfixed implementation.
    blocked.get();
    store.QuiesceWriter();
    EXPECT_EQ(store.GetStats()["dropped_count"], 0);
    EXPECT_EQ(store.GetStats()["captured_frames"], 0);
    std::filesystem::remove_all(dir);
  }
}

TEST(SnapshotStoreHotConfig, DisabledCaptureDrainsAndTrimsPartialBatch) {
  auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  auto cfg = LazyCfg(0); cfg.brightness_enabled = false; cfg.max_count = 1;
  SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "drain", "", "", 64, false);
  store.Start(); store.Clear();
  cv::Mat image(64, 64, CV_8UC4, cv::Scalar(1, 2, 3, 255));
  Detection d; d.bbox = {10, 10, 20, 20};
  for (int i = 0; i < 3; ++i)
    store.Offer(FrameProvider(image), kTestChannelId, "drain", i, i, "m", "object_detection", {d}, {d}, false, cfg);
  cfg.enabled = false;
  store.UpdateConfig(cfg);
  for (int i = 0; i < 200; ++i) {
    if (store.GetStats()["written_count"].get<int>() == 3 && store.GetOverview()["count"] == 1) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
  EXPECT_EQ(store.GetStats()["written_count"], 3);
  EXPECT_EQ(store.GetStats()["dropped_count"], 0);
  EXPECT_EQ(store.GetOverview()["count"], 1);
  store.QuiesceWriter(); store.Clear();
}

TEST(SnapshotAsyncArchive, CorruptPendingDoesNotStarveLiveImages) {
  auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  auto cfg = LazyCfg(0); cfg.brightness_enabled = false;
  auto dir = std::filesystem::temp_directory_path() / ("snapshot-corrupt-" + NewUuid4());
  std::filesystem::create_directories(dir);
  std::ofstream(dir / "broken.cbor", std::ios::binary) << "truncated";
  SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "live", "", "", 64, false, dir.string());
  store.Start(); store.Clear();
  cv::Mat image(64, 64, CV_8UC4, cv::Scalar(1, 2, 3, 255));
  Detection d; d.bbox = {10, 10, 20, 20};
  store.Offer(FrameProvider(image), kTestChannelId, "live", 1, 1, "m", "object_detection", {d}, {d}, false, cfg);
  for (int i = 0; i < 100 && store.GetStats()["written_count"].get<int>() == 0; ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_EQ(store.GetStats()["written_count"], 1);
  EXPECT_TRUE(std::filesystem::exists(dir / "broken.cbor.bad"));
  EXPECT_TRUE(store.GetStats()["healthy"].get<bool>());
  EXPECT_TRUE(store.GetStats()["has_quarantined_data"].get<bool>());
  store.QuiesceWriter(); store.Clear();
  std::filesystem::remove_all(dir);
}

TEST(SnapshotAsyncArchive, UnencodablePendingDoesNotBlockHealthyTarget) {
  auto uri = TestMongoUri();
  if (uri.empty()) GTEST_SKIP() << kNoMongoReason;
  auto cfg = LazyCfg(0); cfg.brightness_enabled = false;
  auto dir = std::filesystem::temp_directory_path() / ("snapshot-encode-" + NewUuid4());
  std::filesystem::create_directories(dir);
  const auto id = NewUuid4();
  std::vector<uchar> png;
  cv::imencode(".png", cv::Mat(8, 8, CV_8UC1, cv::Scalar(20)), png);
  json invalid = {{"oid", "0123456789abcdef01234567"}, {"image_id", id},
    {"channel_id", kTestChannelId}, {"channel_name", "bad"}, {"pts", 0},
    {"timestamp", 0}, {"model", "m"}, {"task", "object_detection"},
    {"class_id", 0}, {"class_name", "object"}, {"confidence", 0.9},
    {"bbox", {0, 0, 8, 8}}, {"png", json::binary(png)}};
  auto bytes = json::to_cbor(invalid);
  { std::ofstream f(dir / (id + ".cbor"), std::ios::binary);
    f.write(reinterpret_cast<const char*>(bytes.data()), bytes.size()); }
  SnapshotStore store(cfg, uri, "ainvr_snapshot_reuse_tests", kTestChannelId, "live", "", "", 64, false, dir.string());
  store.Start(); store.Clear();
  cv::Mat image(64, 64, CV_8UC4, cv::Scalar(1, 2, 3, 255));
  Detection d; d.bbox = {10, 10, 20, 20};
  store.Offer(FrameProvider(image), kTestChannelId, "live", 1, 1, "m", "object_detection", {d}, {d}, false, cfg);
  for (int i = 0; i < 100 && store.GetStats()["written_count"].get<int>() == 0; ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_EQ(store.GetStats()["written_count"], 1);
  for (int i = 0; i < 100 && !std::filesystem::exists(dir / (id + ".cbor.bad")); ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  EXPECT_TRUE(std::filesystem::exists(dir / (id + ".cbor.bad")));
  store.QuiesceWriter(); store.Clear();
  std::filesystem::remove_all(dir);
}

TEST(SnapshotLazyFrame, PermanentDownloadFailureBackpressuresUntilExplicitCancellation) {
  auto cfg = LazyCfg(0);
  SnapshotStore store(cfg, "", "ainvr_snapshot_reuse_tests", kTestChannelId, "live", "", "", 64, false);
  Detection d; d.bbox = {10, 10, 20, 20};
  std::atomic<bool> cancel{false};
  int attempts = 0;
  pipeline::SnapshotSink::FrameProvider broken{{64, 64}, [&](const cv::Rect&, cv::Mat&) {
    ++attempts; throw std::runtime_error("persistent download failure");
  }};
  broken.cancelled = [&] { return cancel.load(); };
  auto result = std::async(std::launch::async, [&] {
    store.Offer(broken, kTestChannelId, "live", 1, 1, "m", "object_detection", {d}, {d}, false, cfg);
  });
  EXPECT_EQ(result.wait_for(std::chrono::milliseconds(500)), std::future_status::timeout);
  auto fault = store.GetStats();
  EXPECT_FALSE(fault["healthy"].get<bool>());
  EXPECT_FALSE(fault["faults"].empty());
  EXPECT_EQ(fault["faults"][0]["stage"], "capture");
  EXPECT_GT(fault["faults"][0]["duration_seconds"].get<double>(), 0);
  cancel.store(true); result.get();
  EXPECT_GE(attempts, 4);
  cv::Mat image(64, 64, CV_8UC4, cv::Scalar(1, 2, 3, 255));
  store.Offer(FrameProvider(image), kTestChannelId, "live", 2, 2, "m", "object_detection", {d}, {d}, false, cfg);
  EXPECT_EQ(store.GetStats()["enqueued_count"], 1);
  EXPECT_TRUE(store.GetStats()["faults"].empty());
}

TEST(SnapshotAsyncArchive, MissingConfiguredEngineIsVisibleBeforeFirstTarget) {
  auto cfg = LazyCfg(0);
  cfg.face_enhance_model = "gpen";
  SnapshotStore store(cfg, "mongodb://127.0.0.1:37017/?serverSelectionTimeoutMS=100",
                      "ainvr_snapshot_reuse_tests", kTestChannelId, "preflight", "", "", 64, true);
  store.Start();
  const auto stats = store.GetStats();
  EXPECT_FALSE(stats["healthy"].get<bool>());
  EXPECT_EQ(stats["faults"].size(), 1);
  if (!stats["faults"].empty()) {
    EXPECT_EQ(stats["faults"][0]["stage"], "processing");
    EXPECT_NE(stats["faults"][0]["message"].get<std::string>().find("engine path"), std::string::npos);
  }
  store.QuiesceWriter();
}

TEST(SnapshotAsyncArchive, RollingCountStaysExactAcrossDeletesAndLimitChanges) {
  auto uri=TestMongoUri();if(uri.empty())GTEST_SKIP()<<kNoMongoReason;
  auto cfg=LazyCfg(0);cfg.max_count=7;cfg.brightness_enabled=false;
  SnapshotStore store(cfg,uri,"ainvr_snapshot_reuse_tests",kTestChannelId,"trim","","",64,false);
  store.Start();store.Clear();
  cv::Mat frame(32,32,CV_8UC4,cv::Scalar(1,2,3,255));
  Detection d;d.bbox={2,2,12,12};
  int written=0;
  auto offer_twenty=[&] {
    std::vector<Detection> detections(20,d);
    store.Offer(FrameProvider(frame),kTestChannelId,"trim",written,written,"m","object_detection",detections,detections,false,cfg);
    written+=20;
    for(int n=0;n<100;++n) {
      if(store.GetStats()["written_count"].get<int>()==written && store.GetOverview()["count"].get<int>()==cfg.max_count)break;
      std::this_thread::sleep_for(std::chrono::milliseconds(30));
    }
    EXPECT_EQ(store.GetOverview()["count"],cfg.max_count);
  };
  offer_twenty();offer_twenty();
  auto page=store.ListPage({},10,0,{},{});
  EXPECT_TRUE(store.DeleteOne(page["items"][0]["image_id"].get<std::string>()));
  offer_twenty();
  EXPECT_GT(store.DeleteRange(-1,10000),0);
  offer_twenty();
  store.Clear();offer_twenty();
  cfg.max_count=3;store.UpdateConfig(cfg);offer_twenty();
  cfg.max_count=12;store.UpdateConfig(cfg);offer_twenty();
  EXPECT_EQ(store.GetStats()["write_error_count"],0);
  store.QuiesceWriter();store.Clear();
}

#ifdef AINVR_CUDA_REFERENCE_TESTS
TEST(SnapshotAsyncArchive, ParallelBilateralStreamsMatchLegacyPixels) {
  if(!GpuAvailable())GTEST_SKIP()<<"CUDA required";
  cv::Mat input(96,128,CV_32FC1); cv::RNG rng(41);rng.fill(input,cv::RNG::UNIFORM,0.,1.);
  cv::cuda::GpuMat gpu,out; gpu.upload(input);
  cv::cuda::bilateralFilter(gpu,out,9,0.1f,5.f,cv::BORDER_REFLECT_101);
  cv::Mat reference;out.download(reference);
  ArchiveExecutor pool;
  std::vector<std::future<void>> work;
  std::atomic<int> mismatches{0};
  for(int i=0;i<24;++i)work.push_back(pool.Submit([&] {
    auto actual=BilateralF32(input,9,0.1,5.);
    if(cv::norm(reference,actual,cv::NORM_INF)!=0)++mismatches;
  }));
  for(auto& f:work)f.get();
  EXPECT_EQ(mismatches.load(),0);
}
#endif

#ifdef AINVR_CUDA_REFERENCE_TESTS
TEST(SnapshotAsyncArchive, ReusedBilateralCapacityMatchesChangingShapesAndBorders) {
  if(!GpuAvailable())GTEST_SKIP()<<"CUDA required";
  ArchiveExecutor pool;
  std::vector<std::future<void>> work;
  std::atomic<int> mismatches{0};
  for(int worker=0;worker<4;++worker)work.push_back(pool.Submit([&,worker] {
    for(const auto size : {cv::Size(37,61),cv::Size(139,93),cv::Size(81,27),cv::Size(19,165),cv::Size(3,5)}) {
      cv::Mat input(size,CV_32FC1);cv::RNG rng(53+worker);rng.fill(input,cv::RNG::UNIFORM,0.,1.);
      cv::cuda::GpuMat gpu,out;gpu.upload(input);
      cv::cuda::bilateralFilter(gpu,out,9,0.1f,5.f,cv::BORDER_REFLECT_101);
      cv::Mat reference;out.download(reference);
      auto actual=BilateralF32(input,9,0.1,5.);
      if(cv::norm(reference,actual,cv::NORM_INF)!=0)++mismatches;
    }
  }));
  for(auto& f:work)f.get();
  EXPECT_EQ(mismatches.load(),0);
}
#endif

TEST(SnapshotSpool, StatsDoNotWaitForDiskIoLock) {
  config::SnapshotConfig cfg;
  SnapshotStore store(cfg, "mongodb://127.0.0.1:1", "test", "test", "test", "", "", 64, false);
  SnapshotStoreTestAccess::CheckStatsWhileDiskLocked(store);
}
