#include <future>
// Copyright AINVR. Production queue + Mali pixels + JPU + isolated real Mongo.
// Synthetic pixels/detections and JPEG decoding are test fixtures/oracles only.
#include <gtest/gtest.h>
#include <opencv2/imgcodecs.hpp>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <set>
#include <map>
#include <thread>
#include <unistd.h>
#include "output/snapshot_store.hpp"
#include "output/snapshot_jpeg.hpp"
#include "output/exposure_backend.hpp"
#include "platform/gles_crop.hpp"
#ifdef AINVR_ARCHIVE_BPU_FACE_BACKEND
#include "output/face_enhancer_bpu.hpp"
#endif
using namespace ai_service;
using namespace ai_service::output;
using nlohmann::json;
namespace fs = std::filesystem;
namespace {
constexpr const char* kDatabase = "ainvr_gpu_snapshot_tests";
std::string Env(const char* name) {
  const char* value = std::getenv(name);
  if (!value || !*value) throw std::runtime_error(std::string("Missing test environment: ") + name);
  return value;
}
template<class F> bool Until(F predicate, int seconds = 20) {
  const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(seconds);
  do {
    if (predicate()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(40));
  } while (std::chrono::steady_clock::now() < end);
  return false;
}
class HardwareArchive : public testing::Test {
 protected:
  config::SnapshotConfig cfg;
  std::string id, uri;
  fs::path pending;
  std::unique_ptr<SnapshotStore> store;
  void SetUp() override {
#ifdef AINVR_ARCHIVE_BPU_FACE_BACKEND
    static const bool registered = [] {
      RegisterFaceEnhancerBpu(Env("AINVR_ARCHIVE_TEST_ROOT"));
      return true;
    }();
    (void)registered;
#endif
    uri = Env("AI_SERVICE_TEST_MONGO_URI");
    id = "hw-" + std::to_string(getpid()) + "-" + NewUuid4();
    pending = fs::path(Env("AINVR_ARCHIVE_TEST_ROOT")) / id;
    fs::create_directory(pending);
    cfg.enabled = true; cfg.min_interval_ms = 0; cfg.max_count = 100;
    cfg.max_crop_dimension = 128; cfg.padding_ratio = 0;
    cfg.jpeg_quality = 95; cfg.face_enhance_model = "none";
    cfg.brightness_enabled = false; cfg.projection_mode = "none";
  }
  void Start(bool disabled = false, bool proxy = false) {
    auto initial = cfg; if (disabled) initial.enabled = false;
    store = std::make_unique<SnapshotStore>(initial,
        proxy ? Env("AI_SERVICE_TEST_MONGO_PROXY_URI") : uri,
        kDatabase, id, "isolated-hardware-test",
#ifdef AINVR_ARCHIVE_BPU_FACE_BACKEND
        "missing-face-test.hbm", "missing-face-test.hbm",
#else
        "", "",
#endif
        8, false, pending.string());
    store->Start(disabled);
  }
  void TearDown() override {
    if (store) { store->Stop(); store.reset(); }
    Proxy(true);
    config::SnapshotStoreConfig db;
    db.mongo_uri = uri; db.db_name = kDatabase;
    SnapshotStore::DropChannelHistory(db, id);
    // Delete only this process's exact test directory under its SSD scratch root.
    const auto scratch = fs::canonical(Env("AINVR_ARCHIVE_TEST_ROOT"));
    if (fs::exists(pending) && fs::canonical(pending).parent_path() == scratch)
      fs::remove_all(pending);
  }
  void Proxy(bool online) {
    const auto control = fs::path(Env("AINVR_ARCHIVE_PROXY_CONTROL"));
    const auto flag = control / "offline";
    if (online) fs::remove(flag); else std::ofstream(flag) << "offline";
    if (!Until([&] {
      std::ifstream status(control / "status"); std::string value; status >> value;
      return value == (online ? "online" : "offline");
    }, 4)) throw std::runtime_error("isolated proxy did not acknowledge state");
  }
  Detection Det(std::array<double,4> box = {40,40,65,63}) {
    Detection d; d.class_id = 0; d.class_name = "fixture-person";
    d.confidence = .9; d.bbox = box; return d;
  }
  void Offer(cv::Mat& frame, int64_t pts, const config::SnapshotConfig& config,
             std::vector<Detection> detections = {}, bool square = false,
             const std::string& task = "object_detection") {
    if (detections.empty()) detections = {Det()};
    pipeline::SnapshotSink::FrameProvider provider{frame.size(), [&frame](const cv::Rect& roi, cv::Mat& out) {
      frame(roi).copyTo(out); // Bytes only; the accepted capture owns its memory.
    }};
    store->Offer(provider, id, "isolated-hardware-test", pts,
        1700000000.125 + double(pts) / 1000, "hardware-fixture", task,
        detections, detections, square, config);
  }
  json Page(int limit = 100, std::optional<std::string> cursor = std::nullopt) {
    return store->ListPage(cursor, limit, 0, std::nullopt, std::nullopt);
  }
  bool WaitCount(size_t count) {
    return Until([&] {
      try { return store->GetOverview()["count"] == count &&
          store->GetStats()["delivery"]["outstanding"] == 0; }
      catch (const SnapshotUnavailable&) { return false; }
    });
  }
  cv::Mat Image(const json& item, bool original) {
    auto bytes = store->GetImage(item.at("image_id"), original);
    if (!bytes || bytes->empty()) throw std::runtime_error("missing archived JPEG");
    EXPECT_EQ(bytes->at(0), 0xff); EXPECT_EQ(bytes->at(1), 0xd8);
    auto image = cv::imdecode(*bytes, cv::IMREAD_COLOR); // Test oracle only.
    EXPECT_EQ(image.cols, item.at("image_width"));
    EXPECT_EQ(image.rows, item.at("image_height"));
    return image;
  }
  size_t PendingCount() {
    size_t count = 0;
    for (const auto& e : fs::directory_iterator(pending))
      if (e.path().extension() == ".cbor") ++count;
    return count;
  }
  void Healthy(size_t count) {
    const auto s = store->GetStats();
    EXPECT_EQ(s["delivery"]["accepted"], count);
    EXPECT_EQ(s["delivery"]["committed"], count);
    EXPECT_EQ(s["delivery"]["outstanding"], 0);
    EXPECT_EQ(s["delivery"]["quarantined"], 0);
    EXPECT_EQ(s["dropped_count"], 0); EXPECT_EQ(s["crop_error_count"], 0);
    EXPECT_EQ(s["brightness_error_count"], 0); EXPECT_TRUE(s["healthy"].get<bool>());
    EXPECT_EQ(GetSnapshotJpegStats().cpu, 0);
    EXPECT_EQ(GetExposureBackendStats().cpu_runs, 0);
  }
};
TEST_F(HardwareArchive, Real4KErpQueueBrightnessDualImagesQueryDelete) {
  cfg.projection_mode = "erp_equirect"; cfg.brightness_enabled = true; cfg.brightness_target = 220;
  const auto crop = ainvr::GetGlesCropStats();
  const auto exposure = GetExposureBackendStats(); const auto jpeg = GetSnapshotJpegStats();
  Start(); ASSERT_TRUE(store->GetOverview()["connected"].get<bool>());
  cv::Mat frame(1920,3840,CV_8UC4,cv::Scalar(40,40,40,91));
  const auto begin = std::chrono::steady_clock::now();
  Offer(frame, 100, cfg, {Det({1700,800,160,160})}, true);
  ASSERT_TRUE(WaitCount(1));
  RecordProperty("offer_to_query_4k_erp_ms", std::to_string(
      std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-begin).count()));
  auto item = Page()["items"][0];
  EXPECT_EQ(item["frame_pts_ns"],100); EXPECT_EQ(item["channel_id"],id);
  EXPECT_EQ(item["model_name"],"hardware-fixture");
  EXPECT_FALSE(item["enhanced"].get<bool>());
  auto original = Image(item,true), processed = Image(item,false);
  EXPECT_NEAR(cv::mean(original)[0],40,3);
  EXPECT_GE(cv::mean(processed)[0],58); EXPECT_LE(cv::mean(processed)[0],83);
  EXPECT_EQ(original.size(), processed.size());
  EXPECT_EQ(store->GetStats()["captured_count"],1);
  EXPECT_EQ(store->GetStats()["brightness_corrected_count"],1);
  EXPECT_GE(ainvr::GetGlesCropStats().maps,crop.maps+1);
  EXPECT_GE(ainvr::GetGlesCropStats().crops,crop.crops+1);
  EXPECT_EQ(GetExposureBackendStats().gpu_runs,exposure.gpu_runs+1);
  EXPECT_EQ(GetSnapshotJpegStats().jpu,jpeg.jpu+2);
  EXPECT_EQ(GetSnapshotJpegStats().gpu_color,jpeg.gpu_color+2);
  Healthy(1);
  const std::string image_id = item["image_id"];
  EXPECT_TRUE(store->DeleteOne(image_id)); EXPECT_FALSE(store->DeleteOne(image_id));
  EXPECT_FALSE(store->GetImage(image_id)); EXPECT_FALSE(store->GetImage(image_id,true));
  store->Stop(); store.reset(); Start(true);
  EXPECT_TRUE(Page()["items"].empty()); EXPECT_FALSE(store->GetImage(image_id));
}
TEST_F(HardwareArchive, Sparse8KUsesSynchronousGpuRoiAndOddJpuDimensions) {
  Start(); const auto before = ainvr::GetGlesCropStats();
  cv::Mat frame(3840,7680,CV_8UC4,cv::Scalar(180,60,20,255));
  const auto begin = std::chrono::steady_clock::now();
  Offer(frame,200,cfg,{Det({4000,2000,65,63})});
  ASSERT_TRUE(WaitCount(1));
  RecordProperty("offer_to_query_8k_sparse_ms",std::to_string(
      std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-begin).count()));
  auto item = Page()["items"][0]; auto image = Image(item,false);
  EXPECT_EQ(image.size(),cv::Size(65,63));
  auto mean = cv::mean(image);
  EXPECT_NEAR(mean[0],20,5); EXPECT_NEAR(mean[1],60,5); EXPECT_NEAR(mean[2],180,5);
  EXPECT_EQ(store->GetStats()["captured_count"],0);
  EXPECT_EQ(store->GetStats()["last_download_bytes"],size_t(65*63*4));
  EXPECT_EQ(ainvr::GetGlesCropStats().crops,before.crops+1);
  EXPECT_EQ(*store->GetImage(item["image_id"]),*store->GetImage(item["image_id"],true));
  Healthy(1);
}
TEST_F(HardwareArchive, AsyncOwnsFramesPerJobConfigAndPagination) {
  Start(); const auto jpeg = GetSnapshotJpegStats();
  for (int i=0;i<6;++i) {
    cv::Mat frame(180,240,CV_8UC4,cv::Scalar::all(40));
    auto config = cfg; config.brightness_enabled = i%2 == 1; config.brightness_target = 220;
    Offer(frame,300+i,config);
    frame.setTo(cv::Scalar(230,0,0,255)); // Caller immediately reuses its fixture.
  }
  ASSERT_TRUE(WaitCount(6));
  std::set<std::string> ids; std::set<int64_t> pts;
  std::optional<std::string> cursor;
  do {
    auto page = Page(2,cursor);
    for (auto item : page["items"]) {
      EXPECT_TRUE(ids.insert(item["image_id"].get<std::string>()).second);
      int64_t point = item["frame_pts_ns"]; pts.insert(point);
      auto original = Image(item,true), processed = Image(item,false);
      EXPECT_NEAR(cv::mean(original)[0],40,3); EXPECT_NEAR(cv::mean(original)[2],40,3);
      if (point%2) EXPECT_GE(cv::mean(processed)[0],58);
      else EXPECT_EQ(cv::norm(original,processed,cv::NORM_INF),0);
    }
    cursor = page["next_cursor"].is_null() ? std::nullopt :
        std::optional<std::string>(page["next_cursor"].get<std::string>());
  } while(cursor);
  EXPECT_EQ(ids.size(),6); EXPECT_EQ(pts.size(),6);
  EXPECT_EQ(store->GetStats()["brightness_corrected_count"],3);
  EXPECT_EQ(store->GetStats()["captured_count"],6);
  EXPECT_EQ(GetSnapshotJpegStats().jpu,jpeg.jpu+9);
  Healthy(6);
  EXPECT_EQ(store->DeleteRange(1700000000.4285,1700000000.4305),2);
  EXPECT_EQ(Page()["items"].size(),4);
}
TEST_F(HardwareArchive, HotDisableDrainsAcceptedTargetsAndAppliesRetention) {
  Start(); cv::Mat frame(256,256,CV_8UC4,cv::Scalar::all(40));
  std::vector<Detection> targets(12,Det()); Offer(frame,500,cfg,targets);
  auto disabled = cfg; disabled.enabled = false; disabled.brightness_enabled = true;
  store->UpdateConfig(disabled);
  Offer(frame,501,cfg); // Stale inference cannot re-enable capture.
  ASSERT_TRUE(WaitCount(12)); Healthy(12);
  EXPECT_EQ(store->GetStats()["brightness_corrected_count"],0);
  disabled.max_count = 3; store->UpdateConfig(disabled);
  ASSERT_TRUE(Until([&]{ return store->GetOverview()["count"] == 3; }));
  EXPECT_EQ(store->GetOverview()["max_count"],3);
  EXPECT_EQ(Page()["items"].size(),3);
}
TEST_F(HardwareArchive, DatabaseOutageSpoolsExactRgbaAndRestartCompletesHardwareProcessing) {
  Proxy(false); cfg.projection_mode="erp_equirect"; cfg.brightness_enabled=true; cfg.brightness_target=220;
  const auto before_crop = ainvr::GetGlesCropStats(); const auto before_jpeg = GetSnapshotJpegStats();
  Start(false,true); EXPECT_FALSE(store->GetOverview()["connected"].get<bool>());
  cv::Mat frame(384,768,CV_8UC4,cv::Scalar(40,40,40,91));
  Offer(frame,600,cfg,{Det({300,150,65,63}),Det({380,150,65,63}),Det({460,150,65,63})},true);
  ASSERT_TRUE(Until([&]{return PendingCount()==3 && store->GetStats()["captured_frames"]==0;}));
  store->Stop(); store.reset();
  std::map<std::string,std::vector<uint8_t>> replay_bytes;
  for (const auto& e : fs::directory_iterator(pending)) if(e.path().extension()==".cbor") {
    std::ifstream in(e.path(),std::ios::binary);
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)),{});
    const auto data=json::from_cbor(bytes);
    replay_bytes.emplace(e.path().stem().string(),bytes);
    ASSERT_EQ(data["pending_version"],3); ASSERT_EQ(data["pixel_format"],"rgba8");
    EXPECT_FALSE(data.contains("png"));
    const auto& rgba=data["rgba"].get_binary();
    ASSERT_EQ(rgba.size(),data["image_width"].get<size_t>()*data["image_height"].get<size_t>()*4);
    for(size_t n=0;n<rgba.size();++n) EXPECT_EQ(rgba[n],n%4==3?91:40);
  }
  Proxy(true); Start(true,true); ASSERT_TRUE(WaitCount(3));
  EXPECT_EQ(PendingCount(),0); EXPECT_FALSE(store->GetStats()["enabled"].get<bool>());
  EXPECT_EQ(store->GetStats()["brightness_corrected_count"],3);
  const auto recovered=Page();
  for(auto item:recovered["items"]) {
    EXPECT_NEAR(cv::mean(Image(item,true))[0],40,3);
    EXPECT_GE(cv::mean(Image(item,false))[0],58);
  }
  EXPECT_GE(ainvr::GetGlesCropStats().crops,before_crop.crops+3);
  EXPECT_EQ(GetSnapshotJpegStats().jpu,before_jpeg.jpu+6); Healthy(3);
  // Reproduce a duplicate durable file after an ambiguous acknowledgement.
  // The original deletion epoch must suppress it after a real restart.
  const std::string deleted_id=recovered["items"][0]["image_id"];
  ASSERT_TRUE(store->DeleteOne(deleted_id)); store->Stop(); store.reset();
  const auto duplicate=pending/(deleted_id+".cbor");
  const auto& bytes=replay_bytes.at(deleted_id);
  {std::ofstream out(duplicate,std::ios::binary);out.write(reinterpret_cast<const char*>(bytes.data()),bytes.size());}
  Start(true,true);
  ASSERT_TRUE(Until([&]{return PendingCount()==0 && store->GetStats()["delivery"]["outstanding"]==0;}));
  EXPECT_EQ(Page()["items"].size(),2);
  EXPECT_FALSE(store->GetImage(deleted_id)); EXPECT_FALSE(store->GetImage(deleted_id,true));
  EXPECT_EQ(store->GetStats()["delivery"]["deleted"],1);
  store->UpdateConfig(cfg); Offer(frame,600,cfg,{Det({300,150,65,63})},true);
  ASSERT_TRUE(WaitCount(3)); // A new epoch with the same timestamp remains valid.
}
TEST_F(HardwareArchive, CorruptRawAndLegacyPendingPreserveBytesAndDoNotStarveHealthyJob) {
  Proxy(false); Start(false,true);
  cv::Mat frame(180,240,CV_8UC4,cv::Scalar::all(40)); Offer(frame,700,cfg);
  ASSERT_TRUE(Until([&]{return PendingCount()==1;})); store->Stop(); store.reset();
  fs::path file;
  for(const auto& e:fs::directory_iterator(pending)) if(e.path().extension()==".cbor") file=e.path();
  std::ifstream in(file,std::ios::binary); std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)),{});
  auto doc=json::from_cbor(bytes); doc["image_width"]=8193;
  auto corrupted=json::to_cbor(doc);
  {std::ofstream out(file,std::ios::binary|std::ios::trunc);out.write(reinterpret_cast<const char*>(corrupted.data()),corrupted.size());}
  auto legacy=doc; const std::string legacy_id=NewUuid4(); legacy["image_id"]=legacy_id;
  legacy.erase("rgba"); legacy["png"]=json::binary(std::vector<uint8_t>{1,2,3});
  auto legacy_bytes=json::to_cbor(legacy);
  const auto legacy_path=pending/(legacy_id+".cbor");
  {std::ofstream out(legacy_path,std::ios::binary);out.write(reinterpret_cast<const char*>(legacy_bytes.data()),legacy_bytes.size());}
  Proxy(true); Start(); Offer(frame,701,cfg);
  ASSERT_TRUE(WaitCount(1));
  EXPECT_TRUE(fs::exists(file.string()+".bad")); EXPECT_TRUE(fs::exists(legacy_path.string()+".bad"));
  EXPECT_TRUE(store->GetStats()["has_quarantined_data"].get<bool>());
  EXPECT_NEAR(cv::mean(Image(Page()["items"][0],true))[0],40,3);
  EXPECT_EQ(GetSnapshotJpegStats().cpu,0); EXPECT_EQ(GetExposureBackendStats().cpu_runs,0);
}
TEST_F(HardwareArchive, UnavailableBpuEnhancementIsVisibleWithoutBlockingHealthyArchive) {
#ifdef AINVR_ARCHIVE_BPU_FACE_BACKEND
  EXPECT_THROW(GetFaceEnhancer("gpen","missing-face-test.hbm")->EnsureLoaded(),std::runtime_error);
  RecordProperty("restoration_backend","registered_s100p_bpu_missing_hbm");
  RecordProperty("model_inference_verified","false");
#endif
  Start(); cv::Mat frame(180,240,CV_8UC4,cv::Scalar::all(40));
  auto enhancement=cfg; enhancement.face_enhance_model="gpen";
  Offer(frame,800,enhancement,{},false,"face_detection");
  Offer(frame,801,cfg);
  ASSERT_TRUE(WaitCount(1));
  EXPECT_EQ(Page()["items"][0]["frame_pts_ns"],801);
  const auto stats=store->GetStats();
  EXPECT_GE(stats["enhance_error_count"].get<int>(),3);
  EXPECT_EQ(stats["delivery"]["accepted"],2); EXPECT_EQ(stats["delivery"]["committed"],1);
  EXPECT_EQ(stats["delivery"]["quarantined"],1); EXPECT_FALSE(stats["healthy"].get<bool>());
  EXPECT_TRUE(stats["has_quarantined_data"].get<bool>());
  EXPECT_EQ(GetSnapshotJpegStats().cpu,0); EXPECT_EQ(GetExposureBackendStats().cpu_runs,0);
}
TEST_F(HardwareArchive, Continuous4KErpQueueMeasuresHardwareAndDurability) {
  cfg.projection_mode="erp_equirect";cfg.padding_ratio=.25;cfg.max_crop_dimension=320;cfg.max_count=500;
  Start();cv::Mat frame(1920,3840,CV_8UC4,cv::Scalar(40,40,40,91));
  const std::vector<Detection> targets{Det({1700,700,200,200}),Det({2200,700,200,200})};
  size_t count=0;int64_t pts=1000;
  for(bool brightness:{false,true}){
    auto config=cfg;config.brightness_enabled=brightness;config.brightness_target=220;
    const std::string phase=brightness?"with_exposure":"without_exposure";
    for(int i=0;i<4;++i){Offer(frame,pts++,config,targets,true);count+=targets.size();}
    ASSERT_TRUE(WaitCount(count)); // Include warm-up only in explicit separate counters.
    const auto crop_before=ainvr::GetGlesCropStats();
    const auto jpeg_before=GetSnapshotJpegStats();
    const auto exposure_before=GetExposureBackendStats();
    const auto before=store->GetStats();const auto start=std::chrono::steady_clock::now();
    constexpr int frames=30;constexpr int jobs=frames*2;
    for(int i=0;i<frames;++i){Offer(frame,pts++,config,targets,true);count+=targets.size();}
    ASSERT_TRUE(WaitCount(count));
    const double elapsed=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
    const auto after=store->GetStats();const auto gpu=ainvr::GetGlesCropStats();
    const double crop_ms=(after["crop_mean_ms"].get<double>()*after["prepared_count"].get<double>()-
        before["crop_mean_ms"].get<double>()*before["prepared_count"].get<double>())/jobs;
    RecordProperty("queue_frames_per_second_4k_"+phase,std::to_string(frames/elapsed));
    RecordProperty("queue_targets_per_second_4k_"+phase,std::to_string(jobs/elapsed));
    RecordProperty("worker_crop_mean_ms_"+phase,std::to_string(crop_ms));
    RecordProperty("new_contexts_during_60_targets_"+phase,std::to_string(gpu.contexts_created-crop_before.contexts_created));
    RecordProperty("shader_compilations_during_60_targets_"+phase,std::to_string(gpu.shader_compilations-crop_before.shader_compilations));
    EXPECT_GE(gpu.crops,crop_before.crops+jobs);
    if(!std::getenv("AINVR_CONTEXT_BASELINE")){
      EXPECT_LE(gpu.contexts_created-crop_before.contexts_created,store->GetStats()["archive_workers"].get<size_t>());
      EXPECT_LE(gpu.shader_compilations-crop_before.shader_compilations,store->GetStats()["archive_workers"].get<size_t>());
    }
    EXPECT_EQ(GetSnapshotJpegStats().jpu,jpeg_before.jpu+jobs*(brightness?2:1));
    EXPECT_EQ(GetExposureBackendStats().gpu_runs,exposure_before.gpu_runs+(brightness?jobs:0));
    EXPECT_EQ(after["delivery"]["committed"],count);
    auto page=Page(2);auto original=Image(page["items"][0],true);
    auto processed=Image(page["items"][0],false);
    EXPECT_NEAR(cv::mean(original)[0],40,3);
    if(brightness)EXPECT_GE(cv::mean(processed)[0],58);
    else EXPECT_EQ(cv::norm(original,processed,cv::NORM_INF),0);
  }
  Healthy(count);
  RecordProperty("source","synthetic resident RGBA; VPU and user-model inference excluded");
  RecordProperty("durable_target_count",std::to_string(count));
}
} // namespace

TEST_F(HardwareArchive, DetachedProviderRunsOnlyOnArchiveWorkerAndKeepsOwnerAlive) {
  Start();
  const auto producer=std::this_thread::get_id();
  auto pixels=std::make_shared<cv::Mat>(1920,3840,CV_8UC4,cv::Scalar(40,40,40,255));
  std::weak_ptr<cv::Mat> lifetime=pixels;
  std::atomic<int> synchronous=0,background=0;
  std::atomic<bool> same_thread=false;
  pipeline::SnapshotSink::FrameProvider provider{pixels->size(),
    [&](const cv::Rect&,cv::Mat&){++synchronous;throw std::runtime_error("unexpected synchronous download");},
    []{return false;},
    [pixels,producer,&background,&same_thread](const cv::Rect& roi,cv::Mat& out){
      same_thread=std::this_thread::get_id()==producer;
      ++background; out=(*pixels)(roi);
    }};
  store->Offer(provider,id,"owned-provider-test",777,1700000000.777,"hardware-fixture",
    "object_detection",{Det()},{Det()},false,cfg);
  provider.owned_download={};pixels.reset();
  ASSERT_TRUE(WaitCount(1));
  EXPECT_EQ(synchronous.load(),0);EXPECT_EQ(background.load(),1);EXPECT_FALSE(same_thread.load());
  EXPECT_TRUE(Until([&]{return lifetime.expired();}));
  auto item=Page()["items"][0];auto original=Image(item,true);
  EXPECT_NEAR(cv::mean(original)[0],40,3);
  EXPECT_EQ(*store->GetImage(item["image_id"]),*store->GetImage(item["image_id"],true));
  EXPECT_EQ(store->GetStats()["last_download_bytes"],0);
  Healthy(1);
}

TEST_F(HardwareArchive, FrameReleaseWakesAdmissionWithoutQueuePollingTimeout) {
  Start();
  cv::Mat frame(256,256,CV_8UC4,cv::Scalar::all(40));
  Offer(frame,800,cfg,std::vector<Detection>(4,Det()));
  ASSERT_TRUE(WaitCount(4));
  std::promise<void> release;auto gate=release.get_future().share();
  std::atomic<int> entered=0;
  pipeline::SnapshotSink::FrameProvider provider{frame.size(),
    [&](const cv::Rect& roi,cv::Mat& out){out=frame(roi);},[]{return false;},
    [frame,gate,&entered](const cv::Rect& roi,cv::Mat& out){++entered;gate.wait();out=frame(roi);}};
  for(int i=0;i<2;++i)store->Offer(provider,id,"admission-test",801+i,1700000001+i,
    "hardware-fixture","object_detection",{Det()},{Det()},false,cfg);
  EXPECT_TRUE(Until([&]{return entered.load()==2;}));
  auto waiter=std::async(std::launch::async,[&]{store->WaitForCapacity([]{return false;});});
  EXPECT_EQ(waiter.wait_for(std::chrono::milliseconds(20)),std::future_status::timeout);
  auto start=std::chrono::steady_clock::now();release.set_value();waiter.get();
  const auto ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
  RecordProperty("capture_release_wakeup_ms",std::to_string(ms));
  EXPECT_LT(ms,75.0); // Old unrelated condition variable waits about 80ms here.
  ASSERT_TRUE(WaitCount(6));Healthy(6);
}

TEST(HardwareJpegReuse, OddVisibleSizesReuseAlignedContextWithoutChangingPixels) {
  std::vector<std::vector<uint8_t>> reference;
  for (const cv::Size size : {cv::Size(65,65),cv::Size(67,67),cv::Size(71,69)}) {
    cv::Mat image(size,CV_8UC4,cv::Scalar(31,93,171,255));
    std::vector<uint8_t> bytes;
    ASSERT_TRUE(EncodeSnapshotRgbaJpeg(image,bytes,82));
    const auto decoded=cv::imdecode(bytes,cv::IMREAD_COLOR);
    ASSERT_EQ(decoded.size(),size);
    reference.push_back(std::move(bytes));
  }
  const auto before=GetSnapshotJpegStats();
  for (int pass=0;pass<3;++pass) {
    int i=0;
    for (const cv::Size size : {cv::Size(65,65),cv::Size(67,67),cv::Size(71,69)}) {
      cv::Mat image(size,CV_8UC4,cv::Scalar(31,93,171,255));
      std::vector<uint8_t> bytes;
      ASSERT_TRUE(EncodeSnapshotRgbaJpeg(image,bytes,82));
      EXPECT_EQ(bytes,reference[i++]);
    }
  }
  EXPECT_EQ(GetSnapshotJpegStats().encoder_creates,before.encoder_creates);
  EXPECT_EQ(GetSnapshotJpegStats().encoder_reuses,before.encoder_reuses+9);
}
