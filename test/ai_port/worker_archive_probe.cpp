// Copyright AINVR. Tests worker/sink ownership with injected archive behavior.
#include "pipeline/channel_worker.hpp"
#include <iostream>
#include "utils/coco.hpp"
#include <atomic>
using Ticket=ai_service::output::ArchiveAdmission::Ticket;
struct Sink:ainvr::FrameArchiveSink {
 std::string mode;std::atomic<int>& calls;std::vector<Ticket> held;
 Sink(std::string m,std::atomic<int>& n):mode(m),calls(n){}
 void Stage(ainvr::Nv12Frame f,ainvr::FrameContext c,ai_service::FrameResult r,Ticket ticket) override {
  if(f.pixels.empty()||r.frame_width!=f.width||r.frame_height!=f.height||r.channel_id!=c.channel_id)
   throw std::runtime_error("Frame metadata mismatch");
  ++calls;
  if(mode=="fail")throw std::runtime_error("Injected durable staging failure");
  if(mode=="hold")held.push_back(std::move(ticket));
 }
};
int main(int argc,char**argv){try{
 if(argc!=4)throw std::runtime_error("model source pass|hold|fail");
 std::string mode=argv[3];if(mode!="pass"&&mode!="hold"&&mode!="fail")throw std::runtime_error("Invalid mode");
 std::atomic<int> calls=0;
 ainvr::ChannelWorkerOptions o;o.id="archive-hook-test";o.url=argv[2];o.processor.model_path=argv[1];
 for(auto name:ai_service::utils::kCocoNames)o.processor.classes.emplace_back(name);
 o.archive_factory=[&]{return std::make_unique<Sink>(mode,calls);};
 ainvr::OnnxChannelWorker worker(o,[]{return true;});worker.Start();
 auto until=std::chrono::steady_clock::now()+std::chrono::seconds(20);
 while(std::chrono::steady_clock::now()<until){
  auto s=worker.Status();if(s["state"]=="error"||s["completed"].get<int>()>=3||(mode=="hold"&&s["completed"].get<int>()>=2))break;
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
 }
 if(mode=="hold")std::this_thread::sleep_for(std::chrono::seconds(2));
 auto before=worker.Status();std::cerr<<before.dump()<<"\n";auto start=std::chrono::steady_clock::now();worker.Stop();
 double stop_ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
 if(stop_ms>6000)throw std::runtime_error("Archive admission blocked stop");
 if(mode=="fail"){
  if(calls!=1||before["state"]!="error"||before["completed"]!=0)throw std::runtime_error("Unaccepted result counted");
 }else if(mode=="hold"){
  if(calls!=2||before["selected"]!=2||before["completed"]!=2)throw std::runtime_error("Admission did not backpressure frame selection");
 }else if(calls<3||before["completed"].get<int>()<3)throw std::runtime_error("Sink did not receive live frames");
 std::cout<<nlohmann::json({{"passed",true},{"mode",mode},{"calls",calls.load()},{"status",before},{"stop_ms",stop_ms},{"scope","Injected sink; no actual archive persistence"}}).dump()<<'\n';
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
