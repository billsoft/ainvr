// Independent review service. No AI channel or alarm state is modified here.
#include "engine.hpp"
#include "image_pipeline.hpp"
#include "request.hpp"
#include "task_scheduling.hpp"
#include "submission_budget.hpp"
#include <variant>
#include "reservation.hpp"
#include "../../shared/cpp/bpu_reserved_pool.hpp"
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
struct Job : ainvr::llm::TaskIdentity {
  std::variant<ainvr::llm::ReviewRequest,ainvr::llm::SearchRequest> request;
  std::promise<Json> result;
  int queue_timeout=30,execution_timeout=10;
  const ainvr::llm::ImageRequest& Image() const {
    return std::visit([](const auto& value)->const ainvr::llm::ImageRequest& {return value;},request);
  }
};
struct Service {
  Json config,previous_config,failed_config;
  ainvr::llm::ConfigurationState configuration;
  std::shared_ptr<Job> active_job;
  std::mutex mutex;
  std::condition_variable cv;
  std::deque<std::shared_ptr<Job>> queue;
  std::string state="unloaded",last_error;
  bool desired=false,stop=false,previous_search=false,search_parsing=false,search_supported=false;
  uint64_t ok=0,failed=0;
  Json callers=Json::object();
  std::deque<double> latencies;
  std::string package_hash;
  Json admission;  // last protocol-3 admission decision; null while no model is resident
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
    if(!ainvr::llm::kSearchVerificationEnabled) {
      if(active_job&&active_job->task==ainvr::llm::ReviewTask::Search)active_job->canceled=true;
      for(auto it=queue.begin();it!=queue.end();) {
        if((*it)->task!=ainvr::llm::ReviewTask::Search){++it;continue;}
        auto job=*it;it=queue.erase(it);job->canceled=true;
        job->result.set_exception(std::make_exception_ptr(std::runtime_error("task_disabled")));
      }
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
    std::lock_guard<std::mutex> lock(mutex);RecordLocked(job,success);
  }
  void RecordLocked(const std::shared_ptr<Job>& job,bool success){
    if(success)++ok;else ++failed;
    auto& caller=callers[job->caller];if(caller.is_null())caller={{"ok",0},{"failed",0}};
    auto key=success?"ok":"failed";caller[key]=caller[key].get<uint64_t>()+1;
    while(callers.size()>64)callers.erase(callers.begin());
    latencies.push_back(std::chrono::duration<double,std::milli>(Clock::now()-job->queued).count());
    if(latencies.size()>256)latencies.pop_front();
  }
  Json SearchProfile() {
    std::lock_guard<std::mutex> lock(mutex);
    const bool enabled=config.value("enabled",false)&&ainvr::llm::kSearchVerificationEnabled;
    return ainvr::llm::SearchProfileMetadata(enabled,desired,state=="ready",search_supported,package_hash);
  }
  Json Status() {
    std::lock_guard<std::mutex> lock(mutex);
    std::vector<double> times(latencies.begin(),latencies.end());std::sort(times.begin(),times.end());
    auto percentile=[&](double q)->Json{return times.empty()?Json(nullptr):Json(times[size_t(std::ceil(q*times.size()))-1]);};
    return {{"admission",admission.is_null()?Json({{"mode","byte_accounted_coexistence"},{"ok",nullptr}}):admission},
            {"package_sha256",package_hash},{"active_request",active_job!=nullptr},
            {"latency_ms",{{"p50",percentile(.5)},{"p95",percentile(.95)},{"samples",times.size()},{"window","last_256_completed"}}},
            {"submit_time_share",{{"window_s",10},{"cap_percent",config.value("submit_time_share_cap_percent",90)}}},
            {"ready",state=="ready"},{"model",state},{"config_version",configuration.committed()},{"package_id","qwen3vl-4b-review-v3"},
            {"tasks",{{"search-verify-zh-v1",{{"enabled",ainvr::llm::kSearchVerificationEnabled},
              {"template_sha256",ainvr::llm::SearchTemplateHash()},{"preprocessing_version",ainvr::llm::kSearchPreprocessing},{"validated",false}}}}},
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
        if(!desired) {engine.reset();image.reset();reservation.reset();admission=Json();search_supported=false;state="unloaded";configuration.Commit(config.value("config_version",0));continue;}
        if(!engine)state="loading";
        else if(!queue.empty()){job=ainvr::llm::TakeTask(queue,previous_search);previous_search=job->task==ainvr::llm::ReviewTask::Search;active_job=job;}
        settings=config;
      }
      if(!engine) {
        try {
          auto next=std::make_unique<ainvr::llm::Engine>(settings.at("package_root"));
          const uint64_t total=ainvr::ReadBpuIonBudgetBytes();
          // Default margin 256 MiB; it is also the size of the post-load allocation probe below.
          const uint64_t min_free=uint64_t(settings.value("min_free_mib",256))*1024*1024;
          reservation=std::make_unique<ainvr::llm::Reservation>(settings.value("reservation_root",std::string("/run/ainvr")),
              next->manifest().at("resources").at("ion_bytes_measured").get<uint64_t>(),min_free,total);
          next->Load();
          auto next_image=std::make_unique<ainvr::QwenReviewImagePipeline>(settings.at("package_root").get<std::string>()+"/normalize.f32");
          // Allocation probe is an additional check, not a measurement of free
          // memory or a guarantee of future video-buffer capacity.
          {ainvr::llm::DmaBuffer headroom(min_free);}
          engine=std::move(next);image=std::move(next_image);
          reservation->Loaded();
          bool supports_search=false;
          try{(void)ainvr::llm::SearchDecisionIndices(engine->manifest().at("decision_vocabulary"));supports_search=true;}catch(...){}
          std::lock_guard<std::mutex> lock(mutex);search_supported=supports_search;admission=reservation->Decision().ToJson();admission["mode"]="byte_accounted_coexistence";admission["min_free_bytes"]=min_free;state="ready";last_error.clear();failed_config=Json();package_hash=engine->package_sha256();
          if(desired)configuration.Commit(settings.value("config_version",0));
        }catch(const std::exception& e){engine.reset();image.reset();reservation.reset();std::lock_guard<std::mutex> lock(mutex);admission=Json();desired=false;state="fault";last_error=e.what();
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
        auto* alarm=std::get_if<ainvr::llm::ReviewRequest>(&job->request);
        auto* search=std::get_if<ainvr::llm::SearchRequest>(&job->request);
        const auto& input=job->Image();
        auto ids=search?engine->EncodeSearch(*search):engine->Encode(alarm->kind,alarm->description);
        if(job->canceled)throw std::runtime_error("canceled");
        Json result;
        if(search&&search->question_scope=="temporal") {
          // Actual tokenizer/layout capacity is still checked above. A single
          // frame cannot establish a temporal claim; no hardware inference.
          result=ainvr::llm::SearchResponse(*search,{},engine->manifest().at("decision_vocabulary"),engine->package_sha256());
          result["timing_ms"]={{"queue",std::chrono::duration<double,std::milli>(start-job->queued).count()},
            {"preprocess",0},{"total",std::chrono::duration<double,std::milli>(Clock::now()-start).count()}};
        } else {
          const bool padded_jpeg=input.letterbox;
          const int decode_width=padded_jpeg?(input.width+63)/64*64:input.width;
          const int decode_height=padded_jpeg?(input.height+63)/64*64:input.height;
          ainvr::VpuDecoder jpeg(ainvr::Codec::Jpeg,decode_width,decode_height,padded_jpeg?ainvr::JpegOutputLayout::EvenPaddedSurface:ainvr::JpegOutputLayout::StrictVisible);
          if(!jpeg.Submit(input.jpeg,1,1000))throw std::runtime_error("image_submit_timeout");
          auto frame=jpeg.Receive(3000);if(!frame)throw std::runtime_error("image_decode_timeout");
          if(frame->visible_width!=input.width||frame->visible_height!=input.height)throw std::runtime_error("image_visible_geometry_mismatch");
          std::vector<float> patches;std::vector<uint8_t> actualImage;
          if(alarm&&alarm->target){auto preparedImage=image->RunTarget(frame->pixels,frame->width,frame->height,*alarm->target,input.width,input.height);patches=std::move(preparedImage.first);actualImage=std::move(preparedImage.second);}
          else patches=image->RunNv12(frame->pixels,frame->width,frame->height,false,true,input.letterbox,input.width,input.height);
          auto prepared=Clock::now();
          auto logits=engine->Infer(ids,patches,[&]{
            while(true){
              if(job->canceled)throw std::runtime_error("canceled");
              if(Clock::now()-start>std::chrono::seconds(job->execution_timeout))throw std::runtime_error("execution_timeout");
              if(ainvr::llm::SubmissionAllowed(submissions,Clock::now(),settings.value("submit_time_share_cap_percent",90)))break;
              std::this_thread::sleep_for(std::chrono::milliseconds(20));
            }
          });
          if(job->canceled)throw std::runtime_error("canceled");
          if(search) result=ainvr::llm::SearchResponse(*search,logits,engine->manifest().at("decision_vocabulary"),engine->package_sha256());
          else {
            result={{"schema","ainvr.alarm_review.v1"},{"request_id",input.id},
              {"real_score",ainvr::llm::Score(logits.at(0),logits.at(1),alarm->temperature)},
              {"score_kind","two_way_softmax_uncalibrated"},{"calibration_temperature",alarm->temperature},
              {"template","alarm-review-zh-v1"},{"validated",false},
              {"model",{{"package_id","qwen3vl-4b-review-v3"},{"package_sha256",engine->package_sha256()}}},
              {"logits",{{"yes",logits[0]},{"no",logits[1]}}},{"decision_logits",Json::object()}};
            if(!actualImage.empty()){
              std::string encoded(4*((actualImage.size()+2)/3),'\0');EVP_EncodeBlock(reinterpret_cast<unsigned char*>(encoded.data()),actualImage.data(),int(actualImage.size()));
              result["prepared_image"]={{"layout","target-crop-v1"},{"jpeg_base64",encoded},{"width",896},{"height",448},{"target",*alarm->target},{"expansion",1.5}};
              const auto marked=image->RunContext(frame->pixels,frame->width,frame->height,*alarm->target,alarm->region,alarm->approach,input.width,input.height);
              std::string context64(4*((marked.size()+2)/3),'\0');EVP_EncodeBlock(reinterpret_cast<unsigned char*>(context64.data()),marked.data(),int(marked.size()));
              result["context_image"]={{"layout","context-marked-v1"},{"jpeg_base64",context64},{"width",896},{"height",448},{"target",*alarm->target},{"region",alarm->region},{"approach_width_fraction",alarm->approach},{"fit","letterbox"}};
            }
            auto words=engine->manifest().at("decision_vocabulary").at("words");
            for(size_t i=0;i<logits.size();++i)result["decision_logits"][words[i].get<std::string>()]=logits[i];
          }
          result["timing_ms"]={{"queue",std::chrono::duration<double,std::milli>(start-job->queued).count()},
            {"preprocess",std::chrono::duration<double,std::milli>(prepared-start).count()},
            {"total",std::chrono::duration<double,std::milli>(Clock::now()-start).count()}};
        }
        if(job->canceled)throw std::runtime_error("canceled");
        {std::lock_guard<std::mutex> lock(mutex);
          if(job->canceled)throw std::runtime_error("canceled");
          RecordLocked(job,true);job->result.set_value(result);active_job.reset();
        }
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
      res.set_content(Json({{"object","list"},{"data",Json::array({{{"id","qwen3vl-4b-review-v3"},{"object","model"},{"created",0},{"owned_by","ainvr"},{"capabilities",{"task:alarm-review-zh-v1","task:search-verify-zh-v1","decision_tokens"}}}})}}).dump(),"application/json");
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
        auto job=std::make_shared<Job>();job->request=ainvr::llm::ParseReview(body);job->request_id=job->Image().id;
        auto settings=service.Settings();
        for(auto& caller:settings.value("api_keys",Json::array()))if(Authorized(req,caller.at("key")))job->caller=caller.at("name").get<std::string>();
        if(job->caller.empty()){Error(res,401,"unauthorized","Caller key was revoked");return;}
        std::get<ainvr::llm::ReviewRequest>(job->request).temperature=settings.value("calibration_temperature",1.0);
        job->queue_timeout=settings.value("queue_timeout_s",30);job->execution_timeout=settings.value("exec_timeout_s",10);
        auto future=job->result.get_future();
        {std::lock_guard<std::mutex> lock(service.mutex);
          if(service.state!="ready"||!service.desired){Error(res,503,"model_not_loaded","Model is not ready");return;}
          ainvr::llm::PreemptQueuedSearch(service.queue,service.config.value("queue_size",8u),[](const auto& background){
            background->result.set_exception(std::make_exception_ptr(std::runtime_error("search_preempted")));
          });
          if(service.queue.size()>=service.config.value("queue_size",8u)){Error(res,429,"queue_full","Inference queue is full");return;}
          service.queue.push_back(job);
        }service.cv.notify_all();
        auto limit=std::chrono::seconds(job->queue_timeout+job->execution_timeout+15);
        if(future.wait_for(limit)!=std::future_status::ready){job->canceled=true;Error(res,504,"timeout","Request timed out");return;}
        auto result=future.get();
        if(openai)result=Json({{"id",job->Image().id},{"object","chat.completion"},{"created",time(nullptr)},
          {"model","qwen3vl-4b-review-v3"},{"choices",Json::array({{{"index",0},{"message",{{"role","assistant"},{"content",result["real_score"].get<double>()>=0.5?"是":"否"}}},{"finish_reason","stop"}}})},{"ainvr",result}});
        res.set_content(result.dump(),"application/json");
      }catch(const ainvr::llm::InputError& e){Error(res,422,e.code,e.what());}
      catch(const nlohmann::json::exception&){Error(res,400,"invalid_request","Invalid request fields");}
      catch(const std::invalid_argument& e){Error(res,400,"invalid_request",e.what());}
      catch(const std::exception& e){
        std::string code=e.what();
        if(code=="queue_timeout"||code=="execution_timeout")Error(res,504,code,"Request exceeded its configured deadline");
        else Error(res,503,"inference_failed","Inference unavailable; consult service status");
      }
    };
    server.Get("/v1/ainvr/tasks/search-verify-zh-v1/profile",[&](const auto& req,auto& res){
      res.set_header("Cache-Control","no-store");
      if(!authorize(req,false)){Error(res,401,"unauthorized","Invalid inference key");return;}
      res.set_content(service.SearchProfile().dump(),"application/json");
    });
    server.Post("/v1/ainvr/tasks/search-verify-zh-v1/cancel",[&](const auto& req,auto& res){
      res.set_header("Cache-Control","no-store");
      if(!authorize(req,false)){Error(res,401,"unauthorized","Invalid inference key");return;}
      try {
        const auto body=Json::parse(req.body);ainvr::llm::SearchShape(body,{"request_id"});
        const auto id=ainvr::llm::SearchRequestId(body.at("request_id"));
        std::lock_guard<std::mutex> lock(service.mutex);std::string caller;
        for(const auto& item:service.config.value("api_keys",Json::array()))if(Authorized(req,item.at("key")))caller=item.at("name").template get<std::string>();
        if(caller.empty()){Error(res,401,"unauthorized","Caller key was revoked");return;}
        const auto canceled=ainvr::llm::CancelSearchTasks(service.queue,service.active_job,caller,id,[](const auto& job){
          job->result.set_exception(std::make_exception_ptr(std::runtime_error("canceled")));
        });
        res.set_content(Json({{"request_id",id},{"cancelled",canceled.active||canceled.queued!=0}}).dump(),"application/json");
      }catch(...){Error(res,400,"invalid_request","Invalid cancellation identity");}
    });
    server.Post("/v1/ainvr/tasks/search-verify-zh-v1",[&](const auto& req,auto& res){
      res.set_header("Cache-Control","no-store");
      if(!authorize(req,false)){Error(res,401,"unauthorized","Invalid inference key");return;}
      try {
        ainvr::llm::SearchParsingPermit parsing(service.mutex,service.search_parsing);
        auto job=std::make_shared<Job>();job->task=ainvr::llm::ReviewTask::Search;
        job->request=ainvr::llm::ParseSearchRequest(Json::parse(req.body));job->request_id=job->Image().id;
        auto future=job->result.get_future();
        {
          std::lock_guard<std::mutex> lock(service.mutex);
          for(const auto& caller:service.config.value("api_keys",Json::array()))if(Authorized(req,caller.at("key")))job->caller=caller.at("name").template get<std::string>();
          if(job->caller.empty()){Error(res,401,"unauthorized","Caller key was revoked");return;}
          if(service.state!="ready"||!service.desired){Error(res,503,"model_not_loaded","Model is not ready");return;}
          if(!ainvr::llm::kSearchVerificationEnabled){Error(res,410,"task_disabled","The model is reserved for alarm review");return;}
          if(!service.search_supported){Error(res,503,"search_profile_unavailable","Search decision vocabulary is unavailable");return;}
          job->queue_timeout=service.config.value("queue_timeout_s",30);job->execution_timeout=service.config.value("exec_timeout_s",10);
          const auto admission=ainvr::llm::AdmitTask(service.queue,service.active_job,*job,service.config.value("queue_size",8u));
          if(admission!=ainvr::llm::TaskAdmission::Accepted){
            const bool duplicate=admission==ainvr::llm::TaskAdmission::Duplicate;
            Error(res,duplicate?409:429,duplicate?"request_in_progress":"search_busy","Search verification capacity is occupied");return;
          }
          service.queue.push_back(job);parsing.ReleaseLocked();
        }
        service.cv.notify_all();
        if(future.wait_for(std::chrono::seconds(job->queue_timeout+job->execution_timeout+15))!=std::future_status::ready){
          // The original operation remains cancelled even if the HTTP caller
          // retries. Never relabel a timed-out result as a completed review.
          std::lock_guard<std::mutex> lock(service.mutex);
          ainvr::llm::CancelSearchTasks(service.queue,service.active_job,job->caller,job->request_id,[](const auto& queued){
            queued->result.set_exception(std::make_exception_ptr(std::runtime_error("canceled")));
          });
          Error(res,504,"timeout","Search verification timed out");return;
        }
        res.set_content(future.get().dump(),"application/json");
      }catch(const ainvr::llm::InputError& e){Error(res,422,e.code,e.what());}
      catch(const nlohmann::json::exception&){Error(res,400,"invalid_request","Invalid search task fields");}
      catch(const std::invalid_argument&){Error(res,400,"invalid_request","Invalid search task input");}
      catch(const std::exception& e){
        const std::string code=e.what();
        if(code=="canceled")Error(res,410,"cancelled","Search verification was cancelled");
        else if(code=="search_preempted"||code=="search_busy")Error(res,429,"search_busy","Search verification yielded to higher priority work");
        else if(code=="queue_timeout"||code=="execution_timeout")Error(res,504,code,"Search verification exceeded its deadline");
        else if(code=="task_disabled"||code=="service_disabled"||code=="service_stopping")Error(res,503,"task_unavailable","Search verification is unavailable");
        else Error(res,503,"inference_failed","Search verification is unavailable");
      }
    });
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
