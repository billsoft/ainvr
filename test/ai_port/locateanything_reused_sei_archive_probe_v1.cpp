// Derived from existing archive probe SHA63ea90246c66c35cd714ce7f8335cd132b61b1c419c22a341e9b9d5c55ce9a9c
// Copyright AINVR. Real production worker/store with isolated Mongo history.
#include "pipeline/reused_channel_worker.hpp"
#include "output/snapshot_store.hpp"
#include "output/snapshot_jpeg.hpp"
#include "stream/media_source.hpp"
#include "stream/sei.hpp"
#include <algorithm>
#include <atomic>
#include <mutex>
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
      {"stream",{{"url","rtmp://127.0.0.1:1935/live/xm"}}},{"inference_fps",1.0/240.0},
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
    const std::string output_url="rtmp://127.0.0.1:1935/locate_diag/"+id;
    input["publish"]={{"enabled",true},{"target_url",output_url},{"sei",{{"max_payload_bytes",4096}}}};
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
    std::atomic<bool> reader_done{false},reader_stop{false};
    std::mutex read_mutex;
    nlohmann::json received=nlohmann::json::array();
    std::exception_ptr read_error;
    // The existing publisher waits for its model-owned SSD AU delay before
    // opening SRS. Connection refusals before that are expected; decoded
    // metadata is never fabricated or injected by this observer.
    std::thread reader([&] {
      try {
        std::unique_ptr<ainvr::MediaSource> source;
        while(!reader_stop.load() && !source) {
          try { source=std::make_unique<ainvr::MediaSource>(output_url,5000); }
          catch(const std::exception&) { std::this_thread::sleep_for(std::chrono::seconds(1)); }
        }
        if(!source)return;
        const auto info=source->Info();
        if(info.width!=3840 || info.height!=1920)throw std::runtime_error("Published source dimensions changed");
        const auto codec=info.codec==ainvr::Codec::H264?ai_service::stream::VideoCodec::kH264:ai_service::stream::VideoCodec::kH265;
        std::set<int64_t> seen;
        while(!reader_stop.load()) {
          auto packet=source->Read();if(!packet)throw std::runtime_error("Published stream ended");
          const auto starts=ai_service::sei::find_annexb_nals(packet->bytes);
          for(size_t i=0;i<starts.size();++i) {
            const size_t begin=starts[i].first;
            size_t end=i+1<starts.size()?starts[i+1].first-starts[i+1].second:packet->bytes.size();
            while(end>begin && packet->bytes[end-1]==0)--end;
            if(end<=begin)continue;
            std::vector<uint8_t> nal(packet->bytes.begin()+begin,packet->bytes.begin()+end);
            if(ai_service::stream::NalType(codec,nal[0])!=(codec==ai_service::stream::VideoCodec::kH264?6:39))continue;
            for(const auto& [type,payload]:ai_service::sei::parse_sei_nal(nal,codec)) {
              const auto& uuid=ai_service::sei::SEI_UUID;
              if(type!=5 || payload.size()<uuid.size() || !std::equal(uuid.begin(),uuid.end(),payload.begin()))continue;
              auto value=nlohmann::json::parse(payload.begin()+uuid.size(),payload.end());
              if(value.at("ch")!=id)throw std::runtime_error("Wrong inference channel in private output");
              if(!packet->pts_ns)throw std::runtime_error("Missing real output AU timestamp");
              const auto pts=value.at("pts").get<int64_t>();
              if(!seen.insert(pts).second)continue;
              std::lock_guard<std::mutex> lock(read_mutex);
              received.push_back({{"metadata",value},{"packet_pts_ns",*packet->pts_ns}});
              if(received.size()>=2){reader_done=true;return;}
            }
          }
        }
      }catch(...){read_error=std::current_exception();reader_done=true;}
    });
    nlohmann::json status;
    std::vector<ai_service::FrameResult> actual_results;
    try {
      while(true) {
        status=worker.GetStats();
        if(worker.State()==ai_service::pipeline::ChannelState::kError || status.at("consecutive_errors").get<int>()>0)
          throw std::runtime_error("Actual worker failed during private SEI validation");
        const int count=status.at("inference_count");
        if(count>2)throw std::runtime_error("Finite two-inference test boundary reached before both SEI samples");
        if(reader_done.load()) { if(read_error)std::rethrow_exception(read_error); if(count==2)break; }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
      }
      actual_results=worker.GetResultBuffer().All();
    }catch(...) {
      reader_stop=true;reader.join();worker.Stop();throw;
    }
    reader_stop=true;reader.join();worker.Stop();
    if(actual_results.size()!=2 || received.size()!=2)throw std::runtime_error("Expected two complete native results and two actual output SEI samples");
    nlohmann::json frame_proofs=nlohmann::json::array();
    std::optional<int64_t> timeline_offset;
    for(const auto& observed:received) {
      const auto& wire=observed.at("metadata");
      auto found=std::find_if(actual_results.begin(),actual_results.end(),[&](const auto& result){return result.frame_pts_ns==wire.at("pts").get<int64_t>();});
      if(found==actual_results.end() || found->frame_width!=3840 || found->frame_height!=1920 || found->model_provider!="bpu")
        throw std::runtime_error("Output SEI does not identify an actual native inference frame");
      // Compare original serializer output byte semantics with SRS readback;
      // this is an oracle only and is never sent into any video stream.
      const auto expected=ai_service::sei::build_result_payload(id,found->frame_pts_ns,0,found->detections,4096,found->model_extra);
      const auto& uuid=ai_service::sei::SEI_UUID;
      auto expected_json=nlohmann::json::parse(expected.begin()+uuid.size(),expected.end());
      if(wire!=expected_json)throw std::runtime_error("Real published SEI differs from actual model result");
      const auto& grounding=wire.at("model_extra").at("grounding");
      if(!grounding.at("complete").get<bool>() || grounding.at("neural_provider")!="bpu" || grounding.at("neural_cpu_fallback").get<bool>() || grounding.at("points").empty() || !wire.at("det").empty())
        throw std::runtime_error("Real point output contract did not reach the stream");
      for(const auto& point:grounding.at("points"))
        if(point.at("label_id")!=cfg.model.label_id)throw std::runtime_error("Point label mismatch");
      const int64_t offset=observed.at("packet_pts_ns").get<int64_t>()-found->frame_pts_ns;
      if(timeline_offset && std::abs(offset-*timeline_offset)>1000000)
        throw std::runtime_error("SEI frames drift from published access-unit timestamps");
      timeline_offset=offset;
      frame_proofs.push_back({{"actual_result",found->ToDict()},{"readback",observed},{"timestamp_offset_ns",offset}});
    }
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
      {"frozen_quality_override_accepted",false},{"production_channel_modified",false},{"stream_published",true},{"actual_sei_readback",frame_proofs},{"metadata_injected_by_observer",false},{"video_reencoded",false},
      {"complete_model_inferences",status.at("inference_count")}};
    store->Stop();
    std::ofstream(directory/"summary.json") << report.dump(2) << '\n';
    std::cout << "PASS private SEI and " << ids.size() << " actual LocateAnything hardware archive records\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}
