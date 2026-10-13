// Copyright AINVR. Bounded production-worker throughput measurement.
#include "pipeline/reused_channel_worker.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <filesystem>
#include <sys/resource.h>
#include <thread>

int main(int argc,char** argv) {
  try {
    if(argc!=5)throw std::invalid_argument("config JSON, model root, seconds [15..120], new report");
    int seconds=std::stoi(argv[3]);
    if(seconds<15||seconds>120||std::filesystem::exists(argv[4]))throw std::invalid_argument("Invalid duration or existing report");
    std::ifstream f(argv[1]);auto j=nlohmann::json::parse(f);
    auto cfg=ai_service::config::ChannelConfigFromJson(j);
    if(cfg.snapshot.enabled)throw std::invalid_argument("Throughput probe must not write archive");
    ai_service::pipeline::ReusedChannelWorker worker(cfg,{},argv[2]);
    worker.Start();auto start=std::chrono::steady_clock::now();
    auto samples=nlohmann::json::array();
    for(int i=0;i<seconds;++i){
      std::this_thread::sleep_for(std::chrono::seconds(1));
      auto s=worker.GetStats();s["elapsed_monotonic"]=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
      std::ifstream ratio("/sys/devices/system/bpu/ratio");double value=-1;ratio>>value;s["bpu_percent"]=value;
      if(worker.State()==ai_service::pipeline::ChannelState::kError)throw std::runtime_error(s.dump());
      samples.push_back(std::move(s));
    }
    auto status=worker.GetStats();auto begin_stop=std::chrono::steady_clock::now();worker.Stop();
    auto a=samples.at(7),b=samples.back();double elapsed=b.at("elapsed_monotonic").get<double>()-a.at("elapsed_monotonic").get<double>();
    double bpu=0;for(size_t i=8;i<samples.size();++i)bpu+=samples[i].at("bpu_percent").get<double>();
    rusage usage{};getrusage(RUSAGE_SELF,&usage);
    nlohmann::json report={{"scope","Actual production worker with unchanged HBM and preprocessing, isolated output; 8 second warmup"},
      {"config",j},{"samples",samples},{"status",status},
      {"measured_fps",(b.at("inference_count").get<double>()-a.at("inference_count").get<double>())/elapsed},
      {"decoded_fps",(b.at("frame_count").get<double>()-a.at("frame_count").get<double>())/elapsed},
      {"mean_bpu_percent",bpu/(samples.size()-8)},{"peak_rss_kib",usage.ru_maxrss},
      {"stop_ms",std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-begin_stop).count()}};
    auto results=nlohmann::json::array();for(const auto& r:worker.GetResultBuffer().All())results.push_back(r.ToDict());
    report["results"]=results;
    std::ofstream out(argv[4]);out<<report.dump(2)<<'\n';out.close();if(!out)throw std::runtime_error("Cannot write report");
    std::cout<<"FPS "<<report["measured_fps"]<<" BPU "<<report["mean_bpu_percent"]<<"\n";
  }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
