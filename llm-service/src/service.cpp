// Independent review service. No AI channel or alarm state is modified here.
#include "engine.hpp"
#include "image_pipeline.hpp"
#include "request.hpp"
#include "reservation.hpp"
#include <hb_mem_mgr.h>
#include "config_center.hpp"
#include "configuration_state.hpp"
#include "vpu_decoder.hpp"
#include <httplib.h>
#include <openssl/crypto.h>
#include <atomic>
#include <algorithm>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <fstream>
#include <future>
#include <iostream>
#include <mutex>
#include <thread>
#include <chrono>
#include <signal.h>
#include <pthread.h>
using Json=nlohmann::json;
using Clock=std::chrono::steady_clock;
namespace {
struct Job {
  ainvr::llm::ReviewRequest request;
  Clock::time_point queued=Clock::now();
  std::promise<Json> result;
  std::atomic<bool> canceled{false};
  int queue_timeout=30,execution_timeout=10;
  std::string caller;
};
struct Service {
  Json config,previous_config,failed_config;
  ainvr::llm::ConfigurationState configuration;
  std::shared_ptr<Job> active_job;
  std::mutex mutex;
  std::condition_variable cv;
  std::deque<std::shared_ptr<Job>> queue;
  std::string state="unloaded",last_error;
  bool desired=false,stop=false;
  uint64_t ok=0,failed=0;
  Json callers=Json::object();
  std::deque<double> latencies;
  std::string package_hash;
  std::thread worker;
  explicit Service(Json c):config(std::move(c)) { worker=std::thread([this]{Loop();}); }
  Json Settings(){std::lock_guard<std::mutex> lock(mutex);return config;}
  Json ConfigurationReport(){std::lock_guard<std::mutex> lock(mutex);return configuration.Report();}
  // Restore only the trusted management settings on restart. Do not report
  // model readiness or acknowledge the version until actual application.
  void SeedPrevious(Json previous){std::lock_guard<std::mutex> lock(mutex);
    if(config.empty())config=std::move(previous);
  }
  void Apply(Json next){std::lock_guard<std::mutex> lock(mutex);
    if(state=="loading")throw std::runtime_error("configuration busy loading model");
    previous_config=config;config=std::move(next);desired=config.value("enabled",false);failed_config=Json();
    configuration.Begin(config.at("config_version").get<int>());
    if(desired&&state=="ready")configuration.Commit(config.at("config_version").get<int>());
    if(!desired&&(state=="unloaded"||state=="fault")){
      state="unloaded";last_error.clear();configuration.Commit(config.at("config_version").get<int>());
    }
    if(!desired&&active_job)active_job->canceled=true;
    if(!desired){for(auto& job:queue)job->result.set_exception(std::make_exception_ptr(std::runtime_error("service_disabled")));queue.clear();}
    cv.notify_all();}
  void RequestStop(){
    {std::lock_guard<std::mutex> lock(mutex);stop=true;desired=false;
      if(active_job)active_job->canceled=true;
      for(auto& job:queue)job->result.set_exception(std::make_exception_ptr(std::runtime_error("service_stopping")));
      queue.clear();
    }cv.notify_all();
  }
  ~Service() {RequestStop();worker.join();}
  void Record(const std::shared_ptr<Job>& job,bool success){
    std::lock_guard<std::mutex> lock(mutex);
    if(success)++ok;else ++failed;
    auto& caller=callers[job->caller];if(caller.is_null())caller={{"ok",0},{"failed",0}};
    auto key=success?"ok":"failed";caller[key]=caller[key].get<uint64_t>()+1;
    while(callers.size()>64)callers.erase(callers.begin());
    latencies.push_back(std::chrono::duration<double,std::milli>(Clock::now()-job->queued).count());
    if(latencies.size()>256)latencies.pop_front();
  }
  Json Status() {
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<double> times(latencies.begin(),latencies.end());std::sort(times.begin(),times.end());
    auto percentile=[&](double q)->Json{return times.empty()?Json(nullptr):Json(times[size_t(std::ceil(q*times.size()))-1]);};
    return {{"admission",{{"mode","exclusive_large_model"},{"other_budget_bytes",1073741824},{"headroom_probe_bytes",536870912},{"free_memory_measured",false}}},
            {"package_sha256",package_hash},{"active_request",active_job!=nullptr},
            {"latency_ms",{{"p50",percentile(.5)},{"p95",percentile(.95)},{"samples",times.size()},{"window","last_256_completed"}}},
            {"submit_time_share",{{"window_s",10},{"cap_percent",config.value("submit_time_share_cap_percent",90)}}},
            {"ready",state=="ready"},{"model",state},{"config_version",configuration.committed()},{"package_id","qwen3vl-4b-review-v3"},
            {"queue",{{"length",queue.size()},{"capacity",config.value("queue_size",8)}}},
            {"requests",{{"ok",ok},{"failed",failed},{"by_caller",callers}}},{"last_error",last_error}};
  }
  void Loop() {
    // Declared first so the residency lock outlives every hardware resource.
    std::unique_ptr<ainvr::llm::Reservation> reservation;
    std::unique_ptr<ainvr::llm::Engine> engine;
    std::unique_ptr<ainvr::QwenReviewImagePipeline> image;
    std::deque<std::pair<Clock::time_point,double>> submissions;
    ainvr::llm::task_time_observer=[&](double seconds){submissions.emplace_back(Clock::now(),seconds);};
    while(true) {
      std::shared_ptr<Job> job;
      Json settings;
      { std::unique_lock<std::mutex> lock(mutex);
        cv.wait(lock,[&]{return stop||desired!=(engine!=nullptr)||!queue.empty();});
        if(stop)break;
        if(!desired) {engine.reset();image.reset();reservation.reset();state="unloaded";configuration.Commit(config.value("config_version",0));continue;}
        if(!engine)state="loading";
        else if(!queue.empty()){job=queue.front();queue.pop_front();active_job=job;}
        settings=config;
      }
      if(!engine) {
        try {
          auto next=std::make_unique<ainvr::llm::Engine>(settings.at("package_root"));
          uint64_t total=0;
          if(hb_mem_module_open()!=0)throw std::runtime_error("memory_module_unavailable");
          int heap_rc=hb_mem_get_heap_size(HB_MEM_USAGE_PRIV_HEAP_2_RESERVED,&total);
          hb_mem_module_close();
          if(heap_rc!=0)throw std::runtime_error("memory_pool_unknown");
          reservation=std::make_unique<ainvr::llm::Reservation>(settings.value("reservation_root",std::string("/run/ainvr")),
              next->manifest().at("resources").at("ion_bytes_measured").get<uint64_t>(),512ULL*1024*1024,total);
          next->Load();
          auto next_image=std::make_unique<ainvr::QwenReviewImagePipeline>(settings.at("package_root").get<std::string>()+"/normalize.f32");
          // Allocation probe is an additional check, not a measurement of free
          // memory or a guarantee of future video-buffer capacity.
          {ainvr::llm::DmaBuffer headroom(512ULL*1024*1024);}
          engine=std::move(next);image=std::move(next_image);
          reservation->Loaded();
          std::lock_guard<std::mutex> lock(mutex);state="ready";last_error.clear();failed_config=Json();package_hash=engine->package_sha256();
          if(desired)configuration.Commit(settings.value("config_version",0));
        }catch(const std::exception& e){engine.reset();image.reset();reservation.reset();std::lock_guard<std::mutex> lock(mutex);desired=false;state="fault";last_error=e.what();
          failed_config=settings;
          const int version=settings.value("config_version",0);
          configuration.Fail(version,"模型未能加载，配置未应用；请检查专用内存及模型校验状态");
          if(config.value("config_version",0)==version&&version>0)config=previous_config;}
        continue;
      }
      if(!job)continue;
      try {
        auto start=Clock::now();
        if(job->canceled||start-job->queued>std::chrono::seconds(job->queue_timeout))throw std::runtime_error("queue_timeout");
        auto ids=engine->Encode(job->request.kind,job->request.description);
        ainvr::VpuDecoder jpeg(ainvr::Codec::Jpeg,job->request.width,job->request.height);
        if(!jpeg.Submit(job->request.jpeg,1,1000))throw std::runtime_error("image_submit_timeout");
        auto frame=jpeg.Receive(3000);if(!frame)throw std::runtime_error("image_decode_timeout");
        auto patches=image->RunNv12(frame->pixels,frame->width,frame->height,false,true,job->request.letterbox);
        auto prepared=Clock::now();
        auto logits=engine->Infer(ids,patches,[&]{
          while(true){
            if(job->canceled)throw std::runtime_error("canceled");
            if(Clock::now()-start>std::chrono::seconds(job->execution_timeout))throw std::runtime_error("execution_timeout");
            while(!submissions.empty()&&Clock::now()-submissions.front().first>=std::chrono::seconds(10))submissions.pop_front();
            double used=0;for(auto& item:submissions)used+=item.second;
            if(used<settings.value("submit_time_share_cap_percent",90)*.1)break;
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
          }
        });
        Json result={{"schema","ainvr.alarm_review.v1"},{"request_id",job->request.id},
          {"real_score",ainvr::llm::Score(logits.at(0),logits.at(1),job->request.temperature)},
          {"score_kind","two_way_softmax_uncalibrated"},{"calibration_temperature",job->request.temperature},
          {"template","alarm-review-zh-v1"},{"validated",false},
          {"model",{{"package_id","qwen3vl-4b-review-v3"},{"package_sha256",engine->package_sha256()}}},
          {"logits",{{"yes",logits[0]},{"no",logits[1]}}},{"decision_logits",Json::object()},
          {"timing_ms",{{"queue",std::chrono::duration<double,std::milli>(start-job->queued).count()},
                        {"preprocess",std::chrono::duration<double,std::milli>(prepared-start).count()},
                        {"total",std::chrono::duration<double,std::milli>(Clock::now()-start).count()}}}};
        auto words=engine->manifest().at("decision_vocabulary").at("words");
        for(size_t i=0;i<logits.size();++i)result["decision_logits"][words[i].get<std::string>()]=logits[i];
        Record(job,true);job->result.set_value(result);
      }catch(...){Record(job,false);job->result.set_exception(std::current_exception());}
      {std::lock_guard<std::mutex> lock(mutex);active_job.reset();}
    }
    engine.reset(); image.reset(); reservation.reset();
    ainvr::llm::task_time_observer={};
  }
};
void Error(httplib::Response& res,int status,const std::string& code,const std::string& message) {
  res.status=status;res.set_content(Json({{"error",{{"message",message},{"type","invalid_request_error"},{"code",code}}}}).dump(),"application/json");
}
bool Authorized(const httplib::Request& req,const std::string& key) {
  auto actual=req.get_header_value("Authorization"),expected="Bearer "+key;
  return actual.size()==expected.size()&&CRYPTO_memcmp(actual.data(),expected.data(),expected.size())==0;
}
}
int main(int argc,char** argv) {
  try {
    if(argc!=2&&argc!=3)throw std::invalid_argument("usage: ainvr_llm_service PRIVATE_CONFIG_JSON | --bootstrap PRIVATE_BOOTSTRAP_JSON");
    bool managed=argc==3&&std::string(argv[1])=="--bootstrap";
    if(argc==3&&!managed)throw std::invalid_argument("unsupported command");
    Json config=managed?Json::object():ainvr::llm::ReadPrivateJson(argv[1]);
    std::unique_ptr<ainvr::llm::ConfigTransport> transport;
    if(managed)transport=std::make_unique<ainvr::llm::ConfigTransport>(ainvr::llm::ReadPrivateJson(argv[2]));
    if(!managed){
      std::string inference=config.at("inference_key"),admin=config.at("admin_key");
      if(inference.size()<32||admin.size()<32||inference==admin)throw std::invalid_argument("distinct strong service keys required");
      if(!config.contains("enabled"))config["enabled"]=true;
      config["api_keys"]=Json::array({{{"name","isolated-test"},{"scope","inference"},{"key",inference}}});
    }
    sigset_t signals;sigemptyset(&signals);sigaddset(&signals,SIGTERM);sigaddset(&signals,SIGINT);
    if(pthread_sigmask(SIG_BLOCK,&signals,nullptr)!=0)throw std::runtime_error("cannot configure shutdown signals");
    Service service(config);httplib::Server server;
    auto authorize=[&](const httplib::Request& req,bool management){
      auto settings=service.Settings();
      if(management)return settings.contains("admin_key")&&Authorized(req,settings.at("admin_key"));
      for(auto& c:settings.value("api_keys",Json::array()))if(Authorized(req,c.at("key")))return true;
      return false;
    };
    server.set_payload_max_length(12*1024*1024+16384);
    server.new_task_queue=[] {return new httplib::ThreadPool(40);};
    server.set_read_timeout(15,0);server.set_write_timeout(30,0);
    server.Get("/health",[&](const auto&,auto& res){res.set_content(service.Status().dump(),"application/json");});
    server.Get("/v1/status",[&](const auto& req,auto& res){if(!authorize(req,true)){Error(res,401,"unauthorized","Invalid service key");return;}res.set_content(service.Status().dump(),"application/json");});
    server.Get("/v1/models",[&](const auto& req,auto& res){
      if(!authorize(req,false)&&!authorize(req,true)){Error(res,401,"unauthorized","Invalid service key");return;}
      res.set_content(Json({{"object","list"},{"data",Json::array({{{"id","qwen3vl-4b-review-v3"},{"object","model"},{"created",0},{"owned_by","ainvr"},{"capabilities",{"task:alarm-review-zh-v1","decision_tokens"}}}})}}).dump(),"application/json");
    });
    server.Post("/v1/admin/(load|unload)",[&](const auto& req,auto& res){
      if(!authorize(req,true)){Error(res,401,"unauthorized","Invalid management key");return;}
      {std::lock_guard<std::mutex> lock(service.mutex);
        if(!service.queue.empty()||service.active_job){Error(res,409,"busy","Requests are running or queued");return;}
        if(req.matches[1]=="load"&&!service.config.value("enabled",false)){
          if(service.state=="fault"&&service.failed_config.is_object()&&service.failed_config.value("enabled",false)){
            service.previous_config=service.config;service.config=service.failed_config;
            service.configuration.Begin(service.config.value("config_version",0));
          }else{Error(res,409,"service_disabled","Enable the service in system configuration first");return;}
        }
        service.desired=req.matches[1]=="load";
        if(service.desired&&service.state=="fault")service.configuration.Begin(service.config.value("config_version",0));
      }service.cv.notify_all();res.status=202;res.set_content(service.Status().dump(),"application/json");
    });
    auto review=[&](const httplib::Request& req,httplib::Response& res,bool openai){
      if(!authorize(req,false)){Error(res,401,"unauthorized","Invalid inference key");return;}
      try {
        auto body=Json::parse(req.body);
        if(openai){
          if(!body.contains("ainvr")||!body["ainvr"].contains("decision")){
            Error(res,400,"capability_not_available","This model supports the fixed image review task, not free chat");return;}
          if(body.value("stream",false)||body.contains("logprobs")||body.contains("tools")||body.contains("temperature")||body.contains("top_p")||body.contains("max_tokens")||body.contains("max_completion_tokens")){
            Error(res,400,"unsupported_parameter","Streaming, logprobs and tools are not available for this review adapter");return;}
          if(body.value("model",std::string("qwen3vl-4b-review-v3"))!="qwen3vl-4b-review-v3"){Error(res,404,"model_not_found","Unknown model");return;}
          body=body.at("ainvr").at("decision");
        }
        auto job=std::make_shared<Job>();job->request=ainvr::llm::ParseReview(body);
        auto settings=service.Settings();
        for(auto& caller:settings.value("api_keys",Json::array()))if(Authorized(req,caller.at("key")))job->caller=caller.at("name").get<std::string>();
        if(job->caller.empty()){Error(res,401,"unauthorized","Caller key was revoked");return;}
        job->request.temperature=settings.value("calibration_temperature",1.0);
        job->queue_timeout=settings.value("queue_timeout_s",30);job->execution_timeout=settings.value("exec_timeout_s",10);
        auto future=job->result.get_future();
        {std::lock_guard<std::mutex> lock(service.mutex);
          if(service.state!="ready"||!service.desired){Error(res,503,"model_not_loaded","Model is not ready");return;}
          if(service.queue.size()>=service.config.value("queue_size",8u)){Error(res,429,"queue_full","Inference queue is full");return;}
          service.queue.push_back(job);
        }service.cv.notify_all();
        auto limit=std::chrono::seconds(job->queue_timeout+job->execution_timeout+15);
        if(future.wait_for(limit)!=std::future_status::ready){job->canceled=true;Error(res,504,"timeout","Request timed out");return;}
        auto result=future.get();
        if(openai)result=Json({{"id",job->request.id},{"object","chat.completion"},{"created",time(nullptr)},
          {"model","qwen3vl-4b-review-v3"},{"choices",Json::array({{{"index",0},{"message",{{"role","assistant"},{"content",result["real_score"].get<double>()>=0.5?"是":"否"}}},{"finish_reason","stop"}}})},{"ainvr",result}});
        res.set_content(result.dump(),"application/json");
      }catch(const nlohmann::json::exception&){Error(res,400,"invalid_request","Invalid request fields");}
      catch(const std::invalid_argument& e){Error(res,400,"invalid_request",e.what());}
      catch(const std::exception& e){
        std::string code=e.what();
        if(code=="queue_timeout"||code=="execution_timeout")Error(res,504,code,"Request exceeded its configured deadline");
        else Error(res,503,"inference_failed","Inference unavailable; consult service status");
      }
    };
    server.Post("/v1/ainvr/tasks/alarm-review-zh-v1",[&](const auto& req,auto& res){review(req,res,false);});
    server.Post("/v1/chat/completions",[&](const auto& req,auto& res){review(req,res,true);});
    // Poll configuration separately: a slow model load cannot block reporting.
    std::atomic<bool> stop_config{false};
    std::thread polling;
    if(managed)polling=std::thread([&]{
      int attempted=0;
      while(!stop_config){
        try{
          auto state=transport->Request("service-states/llm-service");int desired=state.value("desiredVersion",0);
          if(attempted==0&&service.Settings().empty()&&state.contains("appliedVersion")&&state["appliedVersion"].is_number_integer()&&state["appliedVersion"].get<int>()>0){
            int applied=state["appliedVersion"].get<int>();
            auto previous=transport->Request("versions/"+std::to_string(applied)+"/snapshot?service=llm-service");
            if(!previous.is_array()||previous.size()!=1||previous[0].at("service")!="llm-service"||previous[0].at("group")!="system"||previous[0].at("name")!="settings")throw std::runtime_error("invalid applied snapshot");
            service.SeedPrevious(ainvr::llm::NormalizeSettings(previous[0].at("config"),applied));
          }
          if(desired>0&&desired!=attempted){
            auto docs=transport->Request("versions/"+std::to_string(desired)+"/snapshot?service=llm-service");
            if(!docs.is_array()||docs.size()!=1||docs[0].at("service")!="llm-service"||docs[0].at("group")!="system"||docs[0].at("name")!="settings")throw std::runtime_error("invalid service snapshot");
            auto next=ainvr::llm::NormalizeSettings(docs[0].at("config"),desired);service.Apply(std::move(next));attempted=desired;
          }
          if(attempted){auto report=service.ConfigurationReport();transport->Request("service-states/llm-service",&report);}
        }catch(...){
          try{Json report={{"status","failed"},{"restartRequired",false},{"errorMessage","大模型服务配置未应用，请检查参数和本机服务连接"}};
            auto committed=service.ConfigurationReport();if(committed.contains("appliedVersion"))report["appliedVersion"]=committed["appliedVersion"];transport->Request("service-states/llm-service",&report);}catch(...){}
        }
        for(int i=0;i<50&&!stop_config;++i)std::this_thread::sleep_for(std::chrono::milliseconds(100));
      }
    });
    bool bound=server.bind_to_port("127.0.0.1",8300);
    std::atomic<bool> signal_done{false};
    std::thread shutdown([&]{
      while(!signal_done){timespec timeout{0,100000000};int received=sigtimedwait(&signals,nullptr,&timeout);
        if(received==SIGTERM||received==SIGINT){service.RequestStop();server.stop();break;}}
    });
    bool listened=bound&&server.listen_after_bind();
    signal_done=true;shutdown.join();stop_config=true;if(polling.joinable())polling.join();
    if(!listened)throw std::runtime_error("cannot listen on loopback:8300");
  }catch(const std::exception& e){std::cerr<<e.what()<<std::endl;return 1;}
}
