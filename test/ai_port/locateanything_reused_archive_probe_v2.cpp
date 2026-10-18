// Derived from existing archive probe SHA63ea90246c66c35cd714ce7f8335cd132b61b1c419c22a341e9b9d5c55ce9a9c
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
    if ((argc != 3 && argc != 4) || !uri || !database) throw std::invalid_argument("Expected model root and new SSD output plus private Mongo environment and allowed DB");
    auto directory = std::filesystem::path(argv[2]);
    if (std::filesystem::exists(directory)) throw std::runtime_error("Output already exists");
    std::filesystem::create_directories(directory);
    const std::string id = "locate-live-test-" + std::to_string(getpid());
    nlohmann::json input = {{"id",id},{"name","LocateAnything actual BPU archive validation"},
      {"stream",{{"url","rtmp://127.0.0.1:1935/live/xm"}}},{"inference_fps",1.0/60.0},
      {"model",{{"name","yoloe-26x"},{"adapter","yoloe_bpu"},{"provider","bpu"},
         {"path","models/derived/s100p/yoloe-26x.hbm"},{"description","person"},
         {"label_id","yoloe-test-person"},{"label_name","YOLOE 行人"}}},
      {"snapshot",{{"enabled",true},{"max_count",1000},{"face_enhance_model","none"}}}};
    if (argc == 4) {
      if (std::filesystem::file_size(argv[3]) > 32768) throw std::runtime_error("Model request too large");
      std::ifstream model_file(argv[3]);input["model"] = nlohmann::json::parse(model_file);
      if (input["model"].value("adapter", "") != "locateanything_bpu") throw std::runtime_error("Expected full LocateAnything BPU model");
    }
    if (argc != 4) throw std::runtime_error("Explicit final LocateAnything request required");
    input["preprocess"] = {{"letterbox",false},{"interpolation","bicubic"},{"normalize",true},
      {"rgb_order",true},{"mean",{127.5,127.5,127.5}},{"std",{127.5,127.5,127.5}}};
    auto cfg = ai_service::config::ChannelConfigFromJson(input);
    if (cfg.model.name != "locateanything-3b" || cfg.model.input_size != std::vector<int>{224,448} ||
        cfg.model.max_new_tokens != 256 || cfg.model.provider != "bpu")
      throw std::runtime_error("Actual frozen complete-model profile required");
    ai_service::config::SnapshotStoreConfig storage;
    storage.mongo_uri = uri; storage.db_name = database;
    auto store = std::make_shared<ai_service::output::SnapshotStore>(cfg.snapshot, uri,
      storage.db_name, id, cfg.name, "", "", 8, false, (directory/"pending").string());
    store->Start();
    if (store->GetOverview().at("count") != 0) throw std::runtime_error("Test collection not empty");
    ai_service::pipeline::ReusedChannelWorker worker(cfg, storage, argv[1]);
    worker.SetSnapshotSink(store);
    worker.Start();
    // Exactly two completed model inferences;request watchdog and error state
    // remain bounded,but there is no blanket elapsed experiment deadline.
    while (true) {
      if (worker.State() == ai_service::pipeline::ChannelState::kError)
        throw std::runtime_error("Actual worker failed: " + worker.GetStats().dump());
      if (worker.GetStats().at("inference_count").get<int>() >= 2) break;
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
    auto stats = store->GetStats();
    const auto jpeg = ai_service::output::GetSnapshotJpegStats();
    auto ids = nlohmann::json::array();
    for (const auto& item : page.at("items")) {
      if (item.at("model_name") != cfg.model.name)
        throw std::runtime_error("LocateAnything archive model mismatch");
      bool matched = cfg.model.prompts.empty() && item.at("label_id") == cfg.model.label_id &&
        item.at("query_description") == cfg.model.description;
      for (const auto& label : cfg.model.prompts)
        matched |= item.at("label_id") == label.label_id && item.at("query_description") == label.description;
      if (!matched) throw std::runtime_error("LocateAnything archive label/query mismatch");
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
    if (status.at("inference_count").get<int>()!=2 || status.at("consecutive_errors")!=0 || !status.at("last_error").is_null() || stats.at("write_error_count")!=0 || ids.empty() || jpeg.jpu==0 || jpeg.cpu!=0 || stats.at("delivery").at("outstanding")!=0 ||
        stats.at("delivery").at("quarantined")!=0 || !stats.at("healthy").get<bool>())
      throw std::runtime_error("Hardware archive did not fully commit and drain");
    // URI-bearing diagnostic strings must not enter a persisted proof.
    stats.erase("last_error"); stats.erase("faults");
    nlohmann::json report = {{"passed",true},{"scope","Production ReusedChannelWorker and SnapshotStore, actual complete LocateAnything BPU, VPU/GLES/JPU and Mongo; isolated DB/history; no production config mutation"},
      {"database",storage.db_name},{"channel_id",id},{"image_ids",ids},
      {"records_verified",ids.size()},{"worker_stats",status},{"archive_stats",stats},
      {"jpeg_jpu",jpeg.jpu},{"jpeg_cpu",jpeg.cpu},{"sample_records",page},
      {"cpu_neural_fallback",false},{"test_history_retained",true},{"diagnostic_only",true},
      {"frozen_quality_override_accepted",false},{"production_channel_modified",false},{"stream_published",false},
      {"complete_model_inferences",status.at("inference_count")}};
    store->Stop();
    std::ofstream(directory/"summary.json") << report.dump(2) << '\n';
    std::cout << "PASS " << ids.size() << " actual LocateAnything hardware archive records\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}
