// Copyright AINVR. Bounded integration harness, not a production service entry.
#include "pipeline/channel_worker.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <filesystem>
int main(int argc, char** argv) {
  try {
    if (argc != 7) throw std::invalid_argument("model.onnx source classes.json seconds output.json allow|deny|revoke|throw");
    int seconds = std::stoi(argv[4]);
    std::string mode = argv[6];
    if (seconds < 1 || seconds > 120 || (mode != "allow" && mode != "deny" && mode != "revoke" && mode != "throw"))
      throw std::invalid_argument("Invalid bounded test options");
    if (std::filesystem::exists(argv[5])) throw std::invalid_argument("Report already exists");
    ainvr::ChannelWorkerOptions options;
    options.id = "online-test"; options.url = argv[2]; options.processor.model_path = argv[1];
    options.source_timeout_ms = 2000; options.reconnect_initial_ms = 300; options.reconnect_max_ms = 1000;
    std::ifstream classes(argv[3]); nlohmann::json names; classes >> names;
    options.processor.classes = names.get<std::vector<std::string>>();
    auto start = std::chrono::steady_clock::now();
    // Deliberate injected test policy. Production manager must bind LicenseClient.
    ainvr::OnnxChannelWorker worker(options, [&] {
      if (mode == "throw") throw std::runtime_error("Injected license callback error");
      if (mode == "deny") return false;
      return mode != "revoke" || std::chrono::steady_clock::now() - start < std::chrono::seconds(6);
    });
    worker.Start();
    nlohmann::json timeline = nlohmann::json::array();
    for (int i = 0; i < seconds * 5; ++i) {
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
      auto status = worker.Status();
      status["sample_elapsed_s"] = std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
      timeline.push_back(std::move(status));
    }
    auto stopping = std::chrono::steady_clock::now(); worker.Stop();
    double stop_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now()-stopping).count();
    nlohmann::json frames = nlohmann::json::array();
    for (const auto& frame : worker.Results()) frames.push_back(frame.ToDict());
    std::ofstream report(argv[5]);
    report << nlohmann::json({{"status",worker.Status()},{"timeline",timeline},{"stop_ms",stop_ms},
      {"frames",frames},{"scope","Bounded native worker test; injected license policy; no production API or archive"}}).dump(2);
    report.close(); if (!report) throw std::runtime_error("Report write failed");
    return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
