// Explicit manual paired-model integration fixture. Never an automatic CTest.
// This binary links ONLY native search's httplib 0.63, not AI's system 0.10.
#include "bpu_text_encoder.hpp"
#include "http_service.hpp"
#include "model_package.hpp"
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <mutex>
#include <thread>
#include <unistd.h>
namespace {
using namespace ainvr::search;
using Json=nlohmann::json;
using Clock=std::chrono::steady_clock;
volatile std::sig_atomic_t stop_requested=0;
void Stop(int){stop_requested=1;}
constexpr const char* input="00000000-0000-4000-8000-000000000001";
constexpr const char* output="00000000-0000-4000-8000-000000000002";
constexpr const char* processor="search-bpu-fixture";
constexpr const char* input_path="/live/search-fixture-raw";
constexpr const char* output_path="/live/search-fixture-ai";
constexpr const char* uri="mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=1000&connectTimeoutMS=1000&socketTimeoutMS=2000";
int64_t Now(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
bool Database(const std::string& name){
 const std::string prefix="ainvr_search_bpu_e2e_";
 return name.size()>prefix.size()&&name.size()<=63&&name.rfind(prefix,0)==0&&
  std::all_of(name.begin()+prefix.size(),name.end(),[](unsigned char c){return (c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_';});
}
void Help(std::ostream& out){
 out<<"Usage: ainvr_search_bpu_integration_server --run-hardware --database ainvr_search_bpu_e2e_<run_id>\n"
    <<"Requires AINVR_SEARCH_TEST_MONGO=1. Manual hardware harness only; no CPU/fake encoder.\n"
    <<"Fixed loopback HTTP :8400 and Mongo :25440; no URI/model/path override.\n"
    <<"--help exits before model, reservation, database, socket or hardware initialization.\n";
}
// Deadline includes startup and teardown. Normal SIGTERM drains HTTP before
// unloading the real encoder. A hung library cannot leave this test indefinitely.
class Deadline{
 public:
 Deadline():thread_([this]{std::unique_lock<std::mutex> lock(mutex_);
  if(!done_.wait_for(lock,std::chrono::seconds(120),[this]{return finished_;})){
   std::cerr<<"bpu_search_server_deadline_exceeded\n"<<std::flush;std::_Exit(124);
  }
 }){}
 ~Deadline(){ {std::lock_guard<std::mutex> lock(mutex_);finished_=true;}done_.notify_one();thread_.join();}
 private:
 std::mutex mutex_;std::condition_variable done_;bool finished_=false;std::thread thread_;
};
class Listener{
 public:
 explicit Listener(httplib::Server& server):server_(server),thread_([this]{server_.listen_after_bind();}){
  for(int i=0;i<200&&!server_.is_running();++i)std::this_thread::sleep_for(std::chrono::milliseconds(5));
  if(!server_.is_running()){Drain();throw std::runtime_error("fixture_listener_failed");}
 }
 ~Listener(){Drain();}
 void Drain(){server_.stop();if(thread_.joinable())thread_.join();}
 private:
 httplib::Server& server_;std::thread thread_;
};
int Run(const std::string& database){
 Deadline deadline;const auto began=Clock::now();
 // Leave twenty seconds for bounded socket drains, Mongo and device teardown.
 const auto accepting_until=began+std::chrono::seconds(100);
 HistoryBudget budget;budget.max_samples=64;budget.max_bytes=32LL*1024*1024;
 budget.retention_ms=30LL*86400000;budget.max_coverage=64;budget.max_searches=64;
 HistoryMongo history(uri,database,budget);history.Initialize();
 if(history.Usage().at("samples")!=0)throw std::runtime_error("fixture_database_not_empty");
 auto package=VerifyPackage("siglip2-base-full-int8");
 const std::string verified_version=package.model_version;
 auto encoder=BpuTextEncoder::Load(std::move(package));
 if(encoder->ModelVersion()!=verified_version||encoder->Dimensions()!=768||!encoder->Healthy())
  throw std::runtime_error("fixture_encoder_contract_failed");
 auto engine=std::make_unique<MatchEngine>(history,*encoder,64);
 const int64_t at=Now();const Scope scope{{output},at-30000,at+120000,64};
 engine->Rebuild(scope);
 if(!engine->Ready())throw std::runtime_error("fixture_empty_projection_not_ready");
 HttpAccess access;access.console_key=std::string(48,'c');access.producer_key=std::string(48,'p');
 access.management_key=std::string(48,'m');access.revision=std::string(64,'a');
 access.enabled=true;access.unavailable_reason.clear();access.ingestion_model=verified_version;
 access.workers=2;access.queue=2;access.image_max_bytes=8*1024*1024;
 access.sources.emplace(output,ProducerSource{input,processor,output,true,true,input_path,output_path});
 bool timed_out=false;
 {
  HttpService api(&history,std::move(access),engine.get());httplib::Server server;api.Register(server);
  if(stop_requested)return 0;
  if(!server.bind_to_port("127.0.0.1",8400))throw std::runtime_error("fixture_bind_8400_failed");
  Listener listener(server);
  std::cout<<"AINVR_BPU_SEARCH_READY "<<Json{{"ready",true},{"pid",getpid()},{"port",8400},{"database",database},
   {"package_id","siglip2-base-full-int8"},{"model_version",verified_version},{"channel_id",output},
   {"source_input_id",input},{"recording_channel_id",output},{"processor_id",processor},
   {"input_path",input_path},{"output_path",output_path},{"from_ms",scope.from_ms},{"to_ms",scope.to_ms},
   {"capacity",64},{"real_text_encoder",true},{"production_accuracy_verified",false}}.dump()<<'\n'<<std::flush;
  while(!stop_requested&&server.is_running()&&Clock::now()<accepting_until)
   std::this_thread::sleep_for(std::chrono::milliseconds(20));
  timed_out=!stop_requested;
  listener.Drain();
 }
 const auto usage=history.Usage();const bool healthy=encoder->Healthy();engine.reset();encoder.reset();
 std::cout<<"AINVR_BPU_SEARCH_STOPPED "<<Json{{"drained",true},{"encoder_owner_released",true},{"text_healthy_before_release",healthy},{"timed_out",timed_out},
  {"samples",usage.at("samples")},{"bytes",usage.at("bytes")},{"production_accuracy_verified",false}}.dump()<<'\n'<<std::flush;
 // Parent owns the labeled isolated Mongo container and its tmpfs data cleanup.
 return timed_out?124:healthy?0:1;
}
} // namespace
int main(int argc,char** argv){
 if(argc==2&&std::string(argv[1])=="--help"){Help(std::cout);return 0;}
 // All safety gates precede every resource-creating call. No alternate URI,
 // port, model package, database family or filesystem argument is accepted.
 if(argc!=4||std::string(argv[1])!="--run-hardware"||std::string(argv[2])!="--database"||!Database(argv[3])){
  Help(std::cerr);return 2;
 }
 const auto* enabled=std::getenv("AINVR_SEARCH_TEST_MONGO");
 if(!enabled||std::string(enabled)!="1"){
  std::cerr<<"explicit_isolated_hardware_test_authorization_required\n";return 2;
 }
 std::signal(SIGTERM,Stop);std::signal(SIGINT,Stop);
 try{return Run(argv[3]);}
 catch(...){std::cerr<<"bpu_search_server_failed\n";return 1;}
}
