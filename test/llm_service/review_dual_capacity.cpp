// Isolated second detector subscriber. No channel configuration, archive or SEI writes.
#include "adapters/bpu_channel_adapter.hpp"
#include "stream/source.hpp"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
int main(int argc,char**argv){
 try{
  if(argc!=4&&argc!=5)throw std::invalid_argument("config report seconds [pipeline]");
  const bool pipelined=argc==5&&std::string(argv[4])=="pipeline";
  const int seconds=std::stoi(argv[3]);if(seconds<30||seconds>900)throw std::invalid_argument("bounded duration required");
  std::ifstream input(argv[1]);auto cfg=ai_service::config::ChannelConfigFromJson(nlohmann::json::parse(input));
  auto model=std::filesystem::path(cfg.model.path);if(model.is_relative())model=std::filesystem::path("/home/sunrise/ainvr/ai-service")/model;
  cfg.model.path=model.string();
  ai_service::stream::StreamSource source(cfg.stream.url,"review-capacity-isolated",false);source.Start();
  ai_service::adapters::BpuChannelAdapter adapter(cfg.model);adapter.Load(model.string(),"bpu","");auto pre=adapter.DefaultPreprocess();
  auto start=std::chrono::steady_clock::now(),next=start;int count=0,empty=0;double total=0;
  std::future<ainvr::BpuImageResult> pending;
  std::shared_ptr<ai_service::stream::FrameRef> held;
  auto save=[&](bool finished){const double elapsed=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();nlohmann::json out={{"scope","one production source plus isolated second decoder/detector on same source; no second archive/SEI output"},{"mode",pipelined?"two_slot_pipeline":"synchronous"},{"elapsed_s",elapsed},{"frames",count},{"fps",count/std::max(elapsed,.001)},{"pull_timeouts",empty},{"step_mean_ms",total/std::max(count,1)},{"finished",finished},{"channel_configuration_changed",false}};std::ofstream f(argv[2]);f<<out.dump(2);};
  while(std::chrono::steady_clock::now()-start<std::chrono::seconds(seconds)){
   auto frame=source.PullFrameRef(100);if(!frame){++empty;continue;}
   auto before=std::chrono::steady_clock::now();
   if(pipelined){auto nextJob=adapter.RunFrameAsync(frame->nv12,pre,frame->bt709,frame->full_range);if(pending.valid()){pending.get();++count;}pending=std::move(nextJob);held=frame;}
   else{adapter.RunFrame(frame->nv12,pre,frame->bt709,frame->full_range);++count;}
   total+=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-before).count();
   if(count%20==0)save(false);
   next+=std::chrono::milliseconds(100);if(next<std::chrono::steady_clock::now())next=std::chrono::steady_clock::now();std::this_thread::sleep_until(next);
  }
  if(pending.valid()){pending.get();++count;}held.reset();source.Stop();save(true);return 0;
 }catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}
}
