// Copyright AINVR. Real production worker/store with isolated Mongo history.
#include "pipeline/reused_channel_worker.hpp"
#include "output/snapshot_store.hpp"
#include "output/snapshot_jpeg.hpp"
#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
#include <unistd.h>

int main(int argc, char** argv) {
  try {
    const char* uri = std::getenv("AINVR_TEST_MONGO_URI");
    const char* database = std::getenv("AINVR_TEST_MONGO_DB");
    if (argc != 3 || !uri || !database) throw std::invalid_argument("Expected model root and new SSD output plus private Mongo environment and allowed DB");
    auto directory = std::filesystem::path(argv[2]);
    if (std::filesystem::exists(directory)) throw std::runtime_error("Output already exists");
    std::filesystem::create_directories(directory);
    const std::string id = "yoloe-live-test-" + std::to_string(getpid());
    nlohmann::json input = {{"id",id},{"name","YOLOE native archive validation"},
      {"stream",{{"url","rtmp://127.0.0.1:1935/live/xm"}}},{"inference_fps",6},
      {"model",{{"name","yoloe-26x"},{"adapter","yoloe_bpu"},{"provider","bpu"},
         {"path","models/derived/s100p/yoloe-26x.hbm"},{"description","person"},
         {"label_id","yoloe-test-person"},{"label_name","YOLOE 行人"}}},
      {"snapshot",{{"enabled",true},{"max_count",1000},{"face_enhance_model","none"}}}};
    auto cfg = ai_service::config::ChannelConfigFromJson(input);
    ai_service::config::SnapshotStoreConfig storage;
    storage.mongo_uri = uri; storage.db_name = database;
    auto store = std::make_shared<ai_service::output::SnapshotStore>(cfg.snapshot, uri,
      storage.db_name, id, cfg.name, "", "", 8, false, (directory/"pending").string());
    store->Start();
    if (store->GetOverview().at("count") != 0) throw std::runtime_error("Test collection not empty");
    ai_service::pipeline::ReusedChannelWorker worker(cfg, storage, argv[1]);
    worker.SetSnapshotSink(store);
    worker.Start();
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(45);
    while (std::chrono::steady_clock::now() < deadline) {
      if (worker.State() == ai_service::pipeline::ChannelState::kError)
        throw std::runtime_error("Actual worker failed: " + worker.GetStats().dump());
      if (store->GetOverview().at("count").get<int>() >= 12) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    auto status = worker.GetStats();
    worker.Stop();
    // Stop destroys the Mongo client pool. Drain and retrieve evidence while
    // the store is still alive, then close it after all read APIs have finished.
    const auto drain_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(25);
    while (store->GetStats().at("delivery").at("outstanding").get<int>() > 0 &&
           std::chrono::steady_clock::now() < drain_deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    const auto page = store->ListPage(std::nullopt,100,0,std::nullopt,std::nullopt);
    const auto stats = store->GetStats();
    const auto jpeg = ai_service::output::GetSnapshotJpegStats();
    auto ids = nlohmann::json::array();
    for (const auto& item : page.at("items")) {
      if (item.at("model_name") != "yoloe-26x" || item.at("label_id") != "yoloe-test-person" ||
          item.at("query_description") != "person")
        throw std::runtime_error("YOLOE archive model/query/label metadata mismatch");
      const auto image_id = item.at("image_id").get<std::string>();
      auto bytes = store->GetImage(image_id);
      if (!bytes || bytes->size()<4 || bytes->at(0)!=255 || bytes->at(1)!=216)
        throw std::runtime_error("Missing hardware JPEG from actual Mongo");
      if (ids.empty()) {
        std::ofstream file(directory/"sample.jpg",std::ios::binary);
        file.write(reinterpret_cast<const char*>(bytes->data()),bytes->size());
      }
      ids.push_back(image_id);
    }
    if (ids.size()<12 || jpeg.cpu!=0 || stats.at("delivery").at("outstanding")!=0 ||
        stats.at("delivery").at("quarantined")!=0 || !stats.at("healthy").get<bool>())
      throw std::runtime_error("Hardware archive did not fully commit and drain");
    nlohmann::json report = {{"passed",true},{"scope","Production ReusedChannelWorker and SnapshotStore, actual YOLOE BPU, VPU/GLES/JPU and Mongo; isolated DB/history; no production config mutation"},
      {"database",storage.db_name},{"channel_id",id},{"image_ids",ids},
      {"records_verified",ids.size()},{"worker_stats",status},{"archive_stats",stats},
      {"jpeg_jpu",jpeg.jpu},{"jpeg_cpu",jpeg.cpu},{"sample_records",page},
      {"cpu_neural_fallback",false},{"test_history_retained",true}};
    store->Stop();
    std::ofstream(directory/"summary.json") << report.dump(2) << '\n';
    std::cout << "PASS " << ids.size() << " actual YOLOE hardware archive records\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}
