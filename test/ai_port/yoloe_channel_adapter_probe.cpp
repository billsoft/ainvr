// Copyright AINVR. Bounded actual adapter validation, production untouched.
#include "adapters/model_family_adapters.hpp"
#include "stream/media_source.hpp"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>

int main(int argc, char** argv) {
  try {
    if (argc == 3 && std::string(argv[1]) == "--describe") {
      ainvr::BpuModel model(argv[2]);
      std::cout << model.Describe().dump() << '\n';
      return 0;
    }
    if (argc == 3 && std::string(argv[1]) == "--validate") {
      std::ifstream file(argv[2]);
      auto config = ai_service::config::ChannelConfigFromJson(nlohmann::json::parse(file));
      ai_service::adapters::BpuChannelAdapter::ValidateModel(config.model);
      std::cout << "PASS configuration and compiled component contract\n";
      return 0;
    }
    if (argc != 5) throw std::invalid_argument("Expected source, HBM, prompt groups JSON, new report");
    if (std::filesystem::exists(argv[4])) throw std::runtime_error("Report exists");
    std::ifstream input(argv[3]);
    const auto request = nlohmann::json::parse(input);
    const auto groups = request.at("groups").get<std::vector<std::vector<std::string>>>();
    const int slots = request.value("prompt_slots", 8);
    const bool labeled = request.value("use_prompt_labels", false);
    if (slots != 8 && slots != 32) throw std::invalid_argument("Expected 8 or 32 slots");
    if (groups.size() != 2) throw std::invalid_argument("Expected two runtime prompt groups");
    using Clock = std::chrono::steady_clock;
    auto deadline = Clock::now() + std::chrono::seconds(90);
    ainvr::MediaSource source(argv[1], 5000);
    const auto info = source.Info();
    ainvr::VpuDecoder decoder(info.codec, info.width, info.height);
    uint64_t submitted = 0, read = 0;
    bool started = false;
    std::map<uint64_t, std::optional<int64_t>> pending;
    auto rows = nlohmann::json::array();
    for (const auto& phrases : groups) {
      ai_service::config::ModelConfig cfg;
      cfg.name = slots == 32 ? "yoloe-26x-32" : "yoloe-26x"; cfg.adapter = "yoloe_bpu";
      cfg.provider = "bpu"; cfg.path = argv[2];
      cfg.class_names = phrases; cfg.label_id = "adapter-probe";
      if (labeled) for (size_t i=0; i<phrases.size(); ++i)
        cfg.prompts.push_back({phrases[i], "probe-id-"+std::to_string(i), "Probe "+std::to_string(i)});
      auto adapter_owner=ai_service::adapters::CreateBpuRuntimeAdapter(cfg);
      auto& adapter=*adapter_owner;
      const auto setup = Clock::now();
      adapter.Load(cfg.path, cfg.provider, "");
      const double setup_ms = std::chrono::duration<double, std::milli>(Clock::now() - setup).count();
      const auto metadata = adapter.ResultMetadata();
      if (metadata.at("prompt_phrases") != phrases || metadata.at("text_execution_backend") != "s100p_bpu")
        throw std::runtime_error("Runtime text metadata mismatch");
      if (adapter.TaskType() != "object_detection" || adapter.SquareSnapshotCrop())
        throw std::runtime_error("Free text incorrectly changed task to face detection");
      auto frames = nlohmann::json::array();
      auto receive = [&](int timeout) {
        auto frame = decoder.Receive(timeout);
        if (!frame) return;
        auto match = pending.find(frame->pts);
        if (match == pending.end()) throw std::runtime_error("Unknown decoder timestamp");
        pending.erase(match);
        if (frames.size() >= 6) return;
        const auto begin = Clock::now();
        auto result = adapter.RunFrame(*frame, adapter.DefaultPreprocess(), info.bt709, info.full_range);
        if (result.outputs.size() != 1 || result.outputs[0].size() != size_t(4 + slots) * 8400)
          throw std::runtime_error("Unexpected adapter tensor output");
        const auto [input_height, input_width] = adapter.InputSize();
        const auto scale = ai_service::pipeline::compute_scale(frame->width, frame->height, input_width, input_height);
        auto detections = adapter.Postprocess(result.outputs[0], scale, .25, .45, 300);
        auto encoded = nlohmann::json::array();
        for (const auto& item : detections) {
          if (item.class_id < 0 || size_t(item.class_id) >= phrases.size() ||
              item.query_description != phrases[size_t(item.class_id)])
            throw std::runtime_error("Detection/runtime prompt synchronization mismatch");
          if (labeled && (item.label_id != "probe-id-"+std::to_string(item.class_id) ||
              item.class_name != "Probe "+std::to_string(item.class_id)))
            throw std::runtime_error("Stable label ID/name mapping mismatch");
          encoded.push_back({{"class_id",item.class_id},{"class_name",item.class_name},
                             {"query_description",item.query_description},{"label_id",item.label_id},
                             {"confidence",item.confidence},{"bbox",item.bbox}});
        }
        frames.push_back({{"image_backend",result.image_backend},
                           {"preprocess_ms",result.preprocess_ms},
                           {"inference_ms",result.inference_ms},
                           {"total_adapter_ms",std::chrono::duration<double,std::milli>(Clock::now()-begin).count()},
                           {"detections",encoded}});
      };
      while (frames.size() < 6 && Clock::now() < deadline) {
        if (++read > 1200) throw std::runtime_error("Packet bound exceeded");
        auto packet = source.Read();
        if (!packet) break;
        if (!started) { if (!packet->key_frame) continue; started = true; }
        pending.emplace(submitted, packet->pts_ns);
        const auto submit_deadline = Clock::now() + std::chrono::seconds(5);
        while (!decoder.Submit(packet->bytes, submitted, 50)) {
          receive(50);
          if (Clock::now() > submit_deadline) throw std::runtime_error("Decoder stalled");
        }
        ++submitted; receive(50);
      }
      if (frames.size() != 6) throw std::runtime_error("Insufficient real frames");
      rows.push_back({{"metadata",metadata},{"setup_ms",setup_ms},{"frames",frames}});
    }
    source.Cancel();
    nlohmann::json report = {{"scope","Actual model subclass load, runtime prompts, VPU/GLES/BPU and metadata; isolated from production"},
      {"passed",true},{"prompt_slots",slots},{"prompt_labels_verified",labeled},{"cpu_neural_fallback",false},{"cpu_image_processing",false},
      {"source_size",{info.width,info.height}},{"groups",rows},
      {"same_hbm_runtime_prompt_reload_verified",true},{"service_and_web_ui_verified",false}};
    std::ofstream output(argv[4]); output << report.dump(2) << '\n'; output.close();
    if (!output) throw std::runtime_error("Report write failed");
    std::cout << "PASS two actual adapter loads and 12 live hardware frames\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}
