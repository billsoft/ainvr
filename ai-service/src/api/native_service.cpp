// Copyright AINVR. Native S100P control plane and licensed channel lifecycle.
#include "pipeline/channel_options.hpp"
#include "api/archive_read_routes.hpp"
#include "output/channel_archive.hpp"
#include "config/config_store.hpp"
#include "licensing/license_client.hpp"
#include <httplib.h>
#include <openssl/crypto.h>
#include <algorithm>
#include <csignal>
#include <iostream>
#include <map>
#include <regex>

using json=nlohmann::json;
namespace cfg=ai_service::config;
namespace lic=ai_service::licensing;
using Clock=std::chrono::steady_clock;
struct ApiError:std::runtime_error {
  int status;std::string code;
  ApiError(int s,std::string c,std::string text):std::runtime_error(text),status(s),code(std::move(c)){}
};
struct Entry {
  cfg::ChannelConfig config;
  std::shared_ptr<ainvr::OnnxChannelWorker> worker;
  std::string error;
  Clock::time_point started=Clock::now();
};
class Manager {
 public:
  Manager(std::shared_ptr<cfg::ConfigStore> store,std::filesystem::path root,lic::LicenseClient& license,std::filesystem::path archive_root)
      :store_(std::move(store)),root_(std::move(root)),license_(license),archive_root_(std::move(archive_root)) {
    for(const auto& c:store_->Load().channels) {
      Entry entry;entry.config=c;
      try{entry=Build(c);}catch(const std::exception& e){entry.error=e.what();}
      entries_.emplace(c.id,std::move(entry));
    }
  }
  ~Manager(){Shutdown();}
  void Shutdown(){std::lock_guard op(operations_);for(auto& e:Entries())if(e.worker)e.worker->Stop();}
  void Tick() {
    std::unique_lock op(operations_,std::try_to_lock);
    if(!op || !license_.IsLicensed())return;
    for(auto& e:Entries()) {
      if(!e.worker || !e.config.enabled || e.config.manually_stopped || e.config.deletion_pending)continue;
      auto s=e.worker->Status();
      if(s["state"]=="idle" || s.value("license_revoked",false)) {
        e.worker->Stop();e.worker->Start();ResetStart(e.config.id);
      }
    }
  }
  Entry Get(const std::string& id)const {
    std::lock_guard lock(map_);auto it=entries_.find(id);
    if(it==entries_.end())throw ApiError(404,"unknown_channel","Channel does not exist");
    return it->second;
  }
  std::vector<Entry> Entries()const {
    std::lock_guard lock(map_);std::vector<Entry> result;
    for(auto& [id,e]:entries_)result.push_back(e);return result;
  }
  json View(const Entry& e)const {
    auto s=e.worker?e.worker->Status():json{{"state","error"},{"last_error",e.error}};
    auto frames=e.worker?e.worker->Results():std::vector<ai_service::FrameResult>{};
    double elapsed=std::chrono::duration<double>(Clock::now()-e.started).count();
    auto timing=[&](auto getter) {
      std::vector<double> values;double sum=0;
      for(const auto& f:frames){double v=getter(f);values.push_back(v);sum+=v;}
      std::sort(values.begin(),values.end());
      auto quantile=[&](double q){return values.empty()?0:values[std::min(values.size()-1,size_t(std::ceil(q*values.size())-1))];};
      return json{{"count",values.size()},{"mean_ms",values.empty()?0:sum/values.size()},
        {"p50_ms",quantile(.5)},{"p95_ms",quantile(.95)}};
    };
    auto stats=s;stats.update({{"elapsed_seconds",elapsed},{"frame_count",s.value("decoded",0ULL)},
      {"inference_count",s.value("completed",0ULL)},{"dropped_count",s.value("superseded_before_inference",0ULL)},
      {"consecutive_errors",s.value("source_failures",0ULL)},
      {"inference_fps_actual",elapsed>0?s.value("completed",0ULL)/elapsed:0},
      {"result_buffer_size",frames.size()},
      {"timing",{{"preprocess",timing([](auto&f){return f.time_preprocess_ms;})},
                 {"inference",timing([](auto&f){return f.time_inference_ms;})},
                 {"postprocess",timing([](auto&f){return f.time_postprocess_ms;})},
                 {"total",timing([](auto&f){return f.time_preprocess_ms+f.time_inference_ms+f.time_postprocess_ms;})}}}});
    auto config_view=cfg::ChannelConfigToJson(e.config,false);
    config_view["publish"]["effective_target_url"]=e.config.publish.target_url.has_value()?json(*e.config.publish.target_url):json(nullptr);
    return {{"id",e.config.id},{"name",e.config.name},{"state",s["state"]},
      {"config",config_view},{"stats",stats}};
  }
  json List()const {json result=json::array();for(auto&e:Entries())result.push_back(View(e));return result;}
  json Create(const json& patch) {
    RejectInternal(patch);std::lock_guard op(operations_);
    auto config=cfg::ChannelConfigFromJson(patch);ValidateId(config.id);
    {std::lock_guard lock(map_);if(entries_.contains(config.id))throw ApiError(409,"channel_exists","Channel already exists");}
    auto entry=Build(config);auto next=Entries();next.push_back(entry);Persist(next);
    {std::lock_guard lock(map_);entries_.emplace(config.id,entry);}
    if(config.enabled && license_.IsLicensed())entry.worker->Start();
    return View(Get(config.id));
  }
  void Start(const std::string& id) {
    std::lock_guard op(operations_);auto e=Get(id);
    if(!license_.IsLicensed())throw ApiError(403,"license_required","Valid device license required");
    if(!e.worker)throw ApiError(422,"unsupported_runtime",e.error);
    if(e.config.deletion_pending)throw ApiError(409,"channel_deleting","Channel is being deleted");
    auto state=e.worker->Status()["state"];
    if(state=="running"||state=="starting"||state=="reconnecting")throw ApiError(409,"already_running","Channel is already active");
    e.config.manually_stopped=false;e.config.enabled=true;ReplaceConfig(e);
    e.worker->Stop();e.worker->Start();ResetStart(id);
  }
  void Stop(const std::string& id) {
    std::lock_guard op(operations_);auto e=Get(id);
    e.config.manually_stopped=true;ReplaceConfig(e);
    if(e.worker)e.worker->Stop();
  }
  json Update(const std::string& id,const json& patch) {
    RejectInternal(patch);if(patch.contains("id"))throw ApiError(422,"immutable_id","Channel id cannot change");
    std::lock_guard op(operations_);auto old=Get(id);
    auto config=cfg::ChannelConfigFromJson(cfg::DeepMerge(cfg::ChannelConfigToJson(old.config),patch));
    auto next=Build(config);ReplaceConfig(next);
    if(old.worker)old.worker->Stop();
    if(config.enabled&&!config.manually_stopped&&license_.IsLicensed())next.worker->Start();
    return {{"applied",true},{"applied_via","restart"},{"hot_fields",json::array()},
      {"restart",{{"reason","Native channel configuration changed"},{"status","starting"}}},{"channel",View(Get(id))}};
  }
  void Delete(const std::string& id) {
    std::lock_guard op(operations_);auto e=Get(id);
    // Persist stop intent first; a crash cannot restart a channel being removed.
    e.config.deletion_pending=true;ReplaceConfig(e);if(e.worker)e.worker->Stop();
    std::shared_ptr<ainvr::ChannelArchive> archive;
    {std::lock_guard lock(archives_mutex_);auto it=archives_.find(id);if(it!=archives_.end())archive=it->second;}
    if(archive)archive->Delete(json::object());
    auto next=Entries();std::erase_if(next,[&](auto& x){return x.config.id==id;});Persist(next);
    std::lock_guard lock(map_);entries_.erase(id);
  }
  std::shared_ptr<ainvr::ChannelArchive> History(const std::string& id){
    auto entry=Get(id);
    if(entry.config.deletion_pending)throw ApiError(409,"channel_deleting","Channel is being deleted");
    if(!license_.IsLicensed())throw ApiError(503,"archive_unavailable","Device license is not ready");
    return ArchiveFor(id);
  }
  int64_t DeleteSnapshots(const std::string& id,const json& filter){
    std::lock_guard op(operations_);auto archive=History(id);
    try{return archive->Delete(filter);}
    catch(const std::runtime_error&){throw ApiError(503,"archive_unavailable","Archive deletion is not ready; retry later");}
  }
 private:
  std::shared_ptr<ainvr::ChannelArchive> ArchiveFor(const std::string& id){
    ValidateId(id);std::lock_guard lock(archives_mutex_);auto& archive=archives_[id];
    if(!archive){auto config=store_->Load().snapshot_store;
      archive=std::make_shared<ainvr::ChannelArchive>(archive_root_/id,config.mongo_uri,config.db_name,id);}
    return archive;
  }
  static void ValidateId(const std::string& id) {
    if(!std::regex_match(id,std::regex("[A-Za-z0-9_-]{1,128}")))throw ApiError(422,"invalid_id","Invalid channel identifier");
  }
  static void RejectInternal(const json& patch) {
    if(!patch.is_object())throw ApiError(422,"invalid_json","JSON object required");
    if(patch.contains("manually_stopped")||patch.contains("deletion_pending"))throw ApiError(422,"internal_field","Lifecycle fields are managed by the service");
  }
  Entry Build(const cfg::ChannelConfig& config) {
    ValidateId(config.id);auto executable=config;
    executable.enabled=true;executable.manually_stopped=false;executable.deletion_pending=false;
    if(config.snapshot.enabled){ainvr::ChannelArchive::Validate(config.snapshot);executable.snapshot.enabled=false;}
    auto options=ainvr::OnnxOptions(executable,root_);
    if(config.snapshot.enabled){
      auto archive=ArchiveFor(config.id);
      options.archive_factory=[archive,snapshot=config.snapshot,name=config.name]{return archive->MakeSink(snapshot,name);};
    }
    auto worker=std::make_shared<ainvr::OnnxChannelWorker>(options,[this]{return license_.IsLicensed();});
    return {config,worker,"",Clock::now()};
  }
  void Persist(const std::vector<Entry>& entries) {
    json channels=json::array();for(auto&e:entries)channels.push_back(cfg::ChannelConfigToJson(e.config));
    store_->SaveOverlay({{"channels",channels}});
  }
  void ReplaceConfig(const Entry& entry) {
    auto all=Entries();for(auto& e:all)if(e.config.id==entry.config.id)e=entry;Persist(all);
    std::lock_guard lock(map_);entries_.at(entry.config.id)=entry;
  }
  void ResetStart(const std::string& id){std::lock_guard lock(map_);entries_.at(id).started=Clock::now();}
  std::shared_ptr<cfg::ConfigStore> store_;std::filesystem::path root_;lic::LicenseClient& license_;
  mutable std::mutex map_;std::mutex operations_;std::map<std::string,Entry> entries_;
  std::filesystem::path archive_root_;std::mutex archives_mutex_;
  std::map<std::string,std::shared_ptr<ainvr::ChannelArchive>> archives_;
};
static volatile std::sig_atomic_t stopping=0;
static void Signal(int){stopping=1;}
static void Reply(httplib::Response& r,int status,const json& body){r.status=status;r.set_content(body.dump(),"application/json");}
int main(int argc,char**argv) {
  try {
    if(argc!=5)throw std::runtime_error("usage: ainvr_ai_service CONFIG OVERLAY MODEL_ROOT LICENSE_ENV");
    auto store=std::make_shared<cfg::ConfigStore>(argv[1],argv[2]);auto config=store->Load();
    if(config.server.host!="127.0.0.1")throw std::runtime_error("Native control API must bind loopback");
    if(!config.server.api_key || config.server.api_key->size()<32)throw std::runtime_error("Control API key of at least 32 characters required");
    auto license_config=lic::LoadConfigFromEnv(argv[4]);
    lic::LicenseClient license(license_config,lic::MakeHttpFetcher(license_config));license.Start();
    Manager manager(store,argv[3],license,std::filesystem::path(argv[2]).parent_path()/"archive");httplib::Server server;
    // Preserve the reference service's proxy compatibility: the distro
    // httplib shared library otherwise compresses responses behind the BFF.
    server.set_pre_routing_handler([](const httplib::Request& q, httplib::Response&) {
      const_cast<httplib::Request&>(q).headers.erase("Accept-Encoding");
      return httplib::Server::HandlerResponse::Unhandled;
    });
    server.set_payload_max_length(1024*1024);server.set_read_timeout(5);server.set_write_timeout(5);
    const auto started=Clock::now();
    auto route=[&](auto fn){return [&,fn](const httplib::Request& q,httplib::Response&r){
      const auto key=q.get_header_value("x-api-key");
      if(key.size()!=config.server.api_key->size() || CRYPTO_memcmp(key.data(),config.server.api_key->data(),key.size())!=0){Reply(r,401,{{"error",{{"code","unauthorized"},{"message","API key required"}}}});return;}
      try{fn(q,r);}catch(const ainvr::ArchiveHttpError&e){Reply(r,e.status,{{"error",{{"code",e.code},{"message",e.what()}}}});}
      catch(const ApiError&e){Reply(r,e.status,{{"error",{{"code",e.code},{"message",e.what()}}}});}
      catch(const cfg::ConfigValidationError&e){Reply(r,422,{{"error",{{"code","invalid_config"},{"message",e.what()}}}});}
      catch(const std::invalid_argument&e){Reply(r,422,{{"error",{{"code","unsupported_runtime"},{"message",e.what()}}}});}
      catch(const json::exception&){Reply(r,422,{{"error",{{"code","invalid_json"},{"message","Invalid JSON value"}}}});}
      catch(const std::exception&){Reply(r,500,{{"error",{{"code","operation_failed"},{"message","Channel operation failed"}}}});}
    };};
    server.Get("/livez",[](auto&,auto&r){r.set_content("alive","text/plain");});
    server.Get("/health",[&](auto&,auto&r){
      auto list=manager.List();size_t running=0;for(auto&c:list)if(c["state"]=="running")++running;
      auto space=std::filesystem::space(std::filesystem::path(argv[2]).parent_path());
      Reply(r,200,{{"status","ok"},{"version","ainvr-s100p-native-0.1"},
        {"uptime_seconds",std::chrono::duration<double>(Clock::now()-started).count()},
        {"channels",list.size()},{"channels_running",running},{"disk_free_bytes",space.free},{"disk_total_bytes",space.capacity},
        {"business",{{"ready",license.IsLicensed()},{"license_phase",license.Phase()},{"license_error",license.LastError()}}},
        {"capabilities",{{"codecs",{"h264","h265"}},{"publish_formats",json::array()},
          {"model_providers",{"cpu"}},{"snapshot_archive",false},{"sei_publish",false}}}});
    });
    server.Get("/api/v1/channels",route([&](auto&,auto&r){Reply(r,200,{{"channels",manager.List()}});}));
    server.Post("/api/v1/channels",route([&](auto&q,auto&r){Reply(r,201,manager.Create(json::parse(q.body)));}));
    server.Get(R"(/api/v1/channels/([^/]+))",route([&](auto&q,auto&r){Reply(r,200,manager.View(manager.Get(q.matches[1])));}));
    server.Post(R"(/api/v1/channels/([^/]+)/start)",route([&](auto&q,auto&r){manager.Start(q.matches[1]);Reply(r,200,{{"status","starting"},{"channel_id",std::string(q.matches[1])}});}));
    server.Post(R"(/api/v1/channels/([^/]+)/stop)",route([&](auto&q,auto&r){manager.Stop(q.matches[1]);Reply(r,200,{{"status","stopping"},{"channel_id",std::string(q.matches[1])}});}));
    server.Put(R"(/api/v1/channels/([^/]+)/config)",route([&](auto&q,auto&r){Reply(r,200,manager.Update(q.matches[1],json::parse(q.body)));}));
    server.Delete(R"(/api/v1/channels/([^/]+))",route([&](auto&q,auto&r){manager.Delete(q.matches[1]);Reply(r,200,{{"id",std::string(q.matches[1])},{"deleted",true}});}));
    server.Get(R"(/api/v1/channels/([^/]+)/results/latest)",route([&](auto&q,auto&r){auto e=manager.Get(q.matches[1]);auto frames=e.worker?e.worker->Results():std::vector<ai_service::FrameResult>{};Reply(r,200,{{"channel_id",e.config.id},{"has_result",!frames.empty()},{"result",frames.empty()?json(nullptr):frames.back().ToDict()}});}));
    server.Get(R"(/api/v1/channels/([^/]+)/results)",route([&](auto&q,auto&r){
      size_t limit=30;if(q.has_param("limit")){auto v=q.get_param_value("limit");if(!std::regex_match(v,std::regex("[0-9]{1,5}")))throw ApiError(422,"invalid_limit","Invalid result limit");limit=std::min<size_t>(std::stoul(v),10000);}
      auto e=manager.Get(q.matches[1]);auto frames=e.worker?e.worker->Results():std::vector<ai_service::FrameResult>{};json result=json::array();
      for(size_t i=frames.size()>limit?frames.size()-limit:0;i<frames.size();++i)result.push_back(frames[i].ToDict());
      Reply(r,200,{{"channel_id",e.config.id},{"count",result.size()},{"results",result}});
    }));
    server.Delete(R"(/api/v1/channels/([^/]+)/snapshots/([^/]+))",route([&](auto&q,auto&r){
      const std::string id=q.matches[1],image=q.matches[2];
      if(!manager.DeleteSnapshots(id,{{"image_id",image}}))throw ApiError(404,"not_found","Snapshot does not exist");
      Reply(r,200,{{"image_id",image},{"deleted",true}});
    }));
    server.Delete(R"(/api/v1/channels/([^/]+)/snapshots)",route([&](auto&q,auto&r){
      const std::string id=q.matches[1];manager.Get(id);
      if(q.has_param("from_ts")!=q.has_param("to_ts"))throw ApiError(422,"invalid_range","Both time bounds are required");
      auto from=ainvr::ArchiveDouble(q,"from_ts"),to=ainvr::ArchiveDouble(q,"to_ts");
      json filter=json::object();
      if(from){if(*from>*to)throw ApiError(422,"invalid_range","Start time exceeds end time");filter["timestamp"]={{"$gte",*from},{"$lte",*to}};}
      Reply(r,200,{{"deleted_count",manager.DeleteSnapshots(id,filter)}});
    }));
    server.Get("/api/v1/stats",route([&](auto&,auto&r){Reply(r,200,{{"channels",manager.List()}});}));
    // Return raw configuration, matching the reference service contract.
    server.Get("/api/v1/config",route([&](auto&,auto&r){
      auto merged=store->LoadRawMerged();auto view=merged.value("server",json::object());
      view["api_key_set"]=view.contains("api_key")&&!view["api_key"].is_null();
      view.erase("api_key");
      Reply(r,200,{{"server",view},{"channels",merged.value("channels",json::array())}});
    }));
    server.Put("/api/v1/config",route([&](auto&q,auto&){
      auto patch=json::parse(q.body,nullptr,false);
      if(patch.is_object()&&patch.contains("server"))
        throw ApiError(409,"process_level_rejected","Server configuration requires a service restart");
      throw ApiError(422,"invalid_field","Use the channel configuration endpoints");
    }));
    ainvr::RegisterArchiveReadRoutes(server,route,[&](const std::string& id){
      auto archive=manager.History(id);
      return std::shared_ptr<ainvr::ArchiveMongo>(archive,&archive->Mongo());
    },[&](const std::string& id){return manager.Get(id).config.snapshot;});
    if(!server.bind_to_port(config.server.host.c_str(),config.server.port))throw std::runtime_error("Could not bind control API");
    std::signal(SIGINT,Signal);std::signal(SIGTERM,Signal);
    std::atomic<bool> listener_stopped{false};
    std::thread http([&]{server.listen_after_bind();listener_stopped=true;});
    while(!stopping&&!listener_stopped){try{manager.Tick();}catch(const std::exception&e){std::cerr<<"Lifecycle transition failed\n";}std::this_thread::sleep_for(std::chrono::milliseconds(250));}
    server.stop();http.join();manager.Shutdown();license.Stop();return 0;
  }catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}
}
