#include "index_runtime.hpp"
#include <filesystem>
#include <iostream>
#include <mongoc/mongoc.h>
#include <cstdlib>
#include <ctime>
#include <thread>
#include <sys/stat.h>
#include <unistd.h>
#include <regex>
using namespace ainvr::search;
namespace fs=std::filesystem;
class NeverEncoder final:public TextEncoder {
 public:
  explicit NeverEncoder(bool fixture=false):fixture_(fixture){}
  std::string ModelVersion()const override{return "search-v1-"+std::string(64,'a');}
  size_t Dimensions()const override{return 2;}
  std::vector<float> Encode(const std::string&)override{
    if(fixture_)return {1,0}; // Explicit software oracle only; no SDK/model is linked.
    throw std::logic_error("no_inference_in_lifecycle_test");
  }
 private: bool fixture_;
};
void Check(bool good,const char* text){if(!good)throw std::runtime_error(text);}

void ParameterIntegration(const std::string& url) {
  using Json=nlohmann::json;
  Check(std::regex_match(url,std::regex("http://127\\.0\\.0\\.1:25441")),"isolated_parameter_endpoint_required");
  Check(std::getenv("AINVR_SEARCH_TEST_MONGO")!=nullptr,"isolated_history_required");
  const auto now=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string database="ainvr_search_wire_"+std::to_string(now),source="22222222-2222-4222-8222-222222222222",token(48,'s');
  const std::string uri="mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=2000";
  const auto cleanup=[&] {
    auto* client=mongoc_client_new(uri.c_str()); bson_t command=BSON_INITIALIZER,reply; bson_error_t error{};
    BSON_APPEND_INT32(&command,"dropDatabase",1);
    const bool ok=mongoc_client_command_simple(client,database.c_str(),&command,nullptr,&reply,&error);
    bson_destroy(&command);bson_destroy(&reply);mongoc_client_destroy(client);Check(ok,"wire_history_cleanup_failed");
  };
  char name[]="/tmp/ainvr-index-parameter-wire-XXXXXX";const auto made=mkdtemp(name);Check(made,"test_tmp_failed");const fs::path root=made;
  try {
    HistoryMongo history(uri,database);history.Initialize();NeverEncoder encoder(true);MatchEngine engine(history,encoder,8);
    const Scope scope{{source},now-1000,now+1000,20};engine.Start(scope);
    auto files=IndexShardFiles::OpenForTesting(root);
    const IndexJobContext context{std::string(64,'b'),files->StorageGeneration(),"siglip2-base-full-int8",encoder.ModelVersion(),{source},30};
    httplib::Client control(url);control.set_connection_timeout(2);control.set_read_timeout(3);
    const httplib::Headers headers{{"x-service-token",token}};
    const auto configure=control.Post("/fixture/context",headers,Json{{"storage_generation",context.storage_generation}}.dump(),"application/json");
    Check(configure&&configure->status==200,"wire_context_not_ready");
    const auto put=[&](int n) {
      const auto id="00000000-0000-4000-8000-00000000000"+std::to_string(n);
      Sample sample;sample.record={id,source,"processor","session","track"+std::to_string(n),encoder.ModelVersion(),now-100+n,false,{1,float(n)}};
      sample.evidence={{"role","match"},{"input_path","/live/input"},{"output_path","/live/output"},
        {"source_input_id",source},{"output_channel_id",source},{"recording_channel_id",source},{"schema_version","1.0"},
        {"stream_session_id","session"},{"source_pts_ns",std::to_string((now-100+n)*1000000LL)},
        {"source_frame_index",std::to_string(n)},{"frame_id",id},{"frame_width",1920},{"frame_height",1080}};
      sample.jpeg={255,216,255,217};sample.expires_ms=now+120000;history.Put(sample);
    };
    put(1);put(2);
    const Json bootstrap{{"control_url",url},{"service_token",token}};
    auto admitted=std::make_shared<std::atomic<bool>>(true);
    const auto state=[&] {
      const auto response=control.Get("/fixture/state",headers);Check(response&&response->status==200,"wire_state_unavailable");
      return Json::parse(response->body);
    };
    const auto wait=[&](auto predicate,const char* error) {
      const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(16);
      while(std::chrono::steady_clock::now()<deadline) {if(predicate())return;std::this_thread::sleep_for(std::chrono::milliseconds(50));}
      throw std::runtime_error(error);
    };
    uint64_t first_revision=0;
    {
      ManagedIndexRuntime owner(bootstrap,history,engine,std::move(files),context,2,admitted);
      wait([&]{const auto s=owner.Status();return s.at("publications").template get<int>()==1&&s.at("verified_files").template get<int>()>=1&&!s.at("publication_unconfirmed").template get<bool>();},"wire_lost_publish_not_reconciled_or_warmed");
      Check(engine.Match("explicit software oracle",scope).at("items").size()==2,"wire_initial_rows_missing");
      const auto proof=state();Check(proof.at("lost_publication_responses")==1&&proof.at("shards").size()==1&&proof.at("shards")[0].at("record_count")==2,"wire_pg_publication_missing");
      first_revision=std::stoull(proof.at("shards")[0].at("published_revision").template get<std::string>());
      owner.Stop();
    }
    const auto recovery=control.Post("/fixture/recovery",headers,"{}","application/json");
    Check(recovery&&recovery->status==200,"wire_recovery_catalog_not_enabled");
    // Reopen both the file writer and the empty RAM working set. No BPU runs.
    engine.Start(scope);auto reopened=IndexShardFiles::OpenForTesting(root);
    {
      ManagedIndexRuntime owner(bootstrap,history,engine,std::move(reopened),context,2,admitted);
      wait([&]{return owner.Status().at("verified_files").template get<int>()>=1;},"wire_restart_did_not_restore");
      const auto restored=engine.Match("explicit software oracle",scope);
      Check(restored.at("items").size()==2&&restored.at("partial")==true,"wire_restart_query_incorrect");owner.Stop();
    }
    put(3);auto next=IndexShardFiles::OpenForTesting(root);
    {
      ManagedIndexRuntime owner(bootstrap,history,engine,std::move(next),context,2,admitted);
      wait([&]{const auto p=state();return p.at("shards").size()==1&&p.at("shards")[0].at("record_count")==3&&p.at("shards")[0].at("retired_revision").is_null();},"wire_refresh_or_retired_gc_missing");
      Check(owner.Status().at("publications").template get<int>()>=1&&owner.Status().at("verified_files").template get<int>()>=1,"wire_new_publication_not_warmed");
      wait([&]{return engine.Match("explicit software oracle",scope).at("items").size()==3;},"wire_refreshed_rows_not_warmed");
      owner.Stop();
    }
    const auto proof=state();const auto& shard=proof.at("shards")[0];
    const auto id=shard.at("id").template get<std::string>();
    const auto rev=std::stoull(shard.at("published_revision").template get<std::string>());
    Check(rev==first_revision+1&&fs::exists(root/id/(std::to_string(rev)+".manifest.json"))&&
      !fs::exists(root/id/(std::to_string(first_revision)+".manifest.json")),"wire_retired_file_still_exists_or_duplicate_revision");
    std::cout<<"real PG/Fastify -> Native builder -> Mongo/files: lost ACK, restart, refresh, retired GC passed (synthetic vectors, no BPU)\n";
  } catch(...) {cleanup();std::error_code ignored;fs::remove_all(root,ignored);throw;}
  cleanup();std::error_code ignored;fs::remove_all(root,ignored);
}

void Integration() {
  if(!std::getenv("AINVR_SEARCH_TEST_MONGO")) {
    std::cout<<"Mongo runtime integration not requested; lifecycle remains software-only\n"; return;
  }
  using Json=nlohmann::json;
  const auto now=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const auto database="ainvr_search_runtime_"+std::to_string(now);
  const std::string uri="mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=2000";
  const std::string source="22222222-2222-4222-8222-222222222222",revision(64,'b'),token(48,'s');
  const auto cleanup=[&] {
    auto* client=mongoc_client_new(uri.c_str()); bson_t command=BSON_INITIALIZER,reply; bson_error_t error{};
    BSON_APPEND_INT32(&command,"dropDatabase",1);
    const auto ok=mongoc_client_command_simple(client,database.c_str(),&command,nullptr,&reply,&error);
    bson_destroy(&command);bson_destroy(&reply);mongoc_client_destroy(client);Check(ok,"fixture_cleanup_failed");
  };
  char name[]="/tmp/ainvr-index-runtime-live-XXXXXX";const auto made=mkdtemp(name);Check(made,"test_tmp_failed");const fs::path root=made;
  try {
    HistoryMongo history(uri,database);history.Initialize();NeverEncoder encoder(true);MatchEngine engine(history,encoder,8);
    engine.Start({{source},now-1000,now+1000,20});
    for(int n=1;n<=2;++n){
      const auto id="00000000-0000-4000-8000-00000000000"+std::to_string(n);
      Sample sample; sample.record={id,source,"processor","session","track"+std::to_string(n),encoder.ModelVersion(),now-100+n,false,{1,float(n)}};
      sample.evidence={{"role","match"},{"input_path","/live/input"},{"output_path","/live/output"},
        {"source_input_id",source},{"output_channel_id",source},{"recording_channel_id",source},{"schema_version","1.0"},
        {"stream_session_id","session"},{"source_pts_ns",std::to_string((now-100+n)*1000000LL)},
        {"source_frame_index",std::to_string(n)},{"frame_id",id},{"frame_width",1920},{"frame_height",1080}};
      sample.jpeg={255,216,255,217}; sample.expires_ms=now+60000;history.Put(sample);
    }
    const auto changes=history.ScanIndexChanges(encoder.ModelVersion(),{source},0);
    const auto seconds=std::time_t(now/1000);std::tm utc{};gmtime_r(&seconds,&utc);char day[11]{};strftime(day,sizeof(day),"%Y-%m-%d",&utc);
    auto files=IndexShardFiles::OpenForTesting(root);
    IndexJobContext context{revision,files->StorageGeneration(),"siglip2-base-full-int8",encoder.ModelVersion(),{source},30};
    IndexShardIdentity identity{"11111111-1111-4111-8111-111111111111",1,source,encoder.ModelVersion(),day,2,changes.checkpoint,context.storage_generation};
    const auto batch=history.Scan(encoder.ModelVersion(),{{source},now-1000,now+1000,20},0,10);
    std::vector<Record> rows;for(const auto& sample:batch.samples)rows.push_back(sample.record);
    const auto publication=files->Publish(identity,rows);
    const Json published={{"id",identity.id},{"channel_id",source},{"model_version",identity.model_version},{"day",day},
      {"published_revision",1},{"manifest_key",publication.manifest_key},{"manifest_sha256",publication.manifest_sha256},
      {"checkpoint",changes.checkpoint},{"record_count",publication.record_count},{"byte_count",publication.byte_count},{"partial",false}};
    httplib::Server server;std::atomic<bool> malformed{false};std::atomic<int> requests{0},refreshes{0},repairs{0};
    server.Post("/api/internal/search/index-jobs",[&](const auto& req,auto& res){
      ++requests;Json output;
      const auto body=Json::parse(req.body);
      if(req.get_header_value("x-service-token")!=token||body.at("revision")!=revision)malformed.store(true);
      const auto action=body.at("action").template get<std::string>();
      if(action=="claim")output={{"job",nullptr}};
      else if(action=="catalog")output={{"revision",revision},{"storage_generation",context.storage_generation},{"items",Json::array({published})},{"next_cursor",nullptr}};
      else if(action=="retired_catalog")output={{"revision",revision},{"storage_generation",context.storage_generation},{"items",Json::array()},{"next_cursor",nullptr}};
      else if(action=="refresh"){
        ++refreshes;if(body.at("channel_id")!=source||body.at("model_version")!=encoder.ModelVersion()||body.at("day")!=day)malformed.store(true);
        output={{"job_id","33333333-3333-4333-8333-333333333333"},{"shard_id",identity.id},{"state","pending"},{"accepted_checkpoint",body.at("minimum_checkpoint")}};
      }else if(action=="published")output={{"shard",published}};
      else if(action=="enqueue") {
        ++repairs;if(body.at("kind")!="index"||body.at("channel_id")!=source)malformed.store(true);
        output={{"job_id","44444444-4444-4444-8444-444444444444"},{"shard_id",identity.id},{"state","pending"}};
      }else{malformed.store(true);output=Json::object();}
      res.set_content(output.dump(),"application/json");
    });
    const int port=server.bind_to_any_port("127.0.0.1");Check(port>0,"mock_bind_failed");
    std::thread listener([&]{server.listen_after_bind();});
    try{
      for(int n=0;n<200&&!server.is_running();++n)std::this_thread::sleep_for(std::chrono::milliseconds(5));
      Check(server.is_running(),"mock_start_failed");
      const Json bootstrap{{"control_url","http://127.0.0.1:"+std::to_string(port)},{"service_token",token}};
      auto admitted=std::make_shared<std::atomic<bool>>(false);
      auto owner=std::make_unique<ManagedIndexRuntime>(bootstrap,history,engine,std::move(files),context,2,admitted);
      std::this_thread::sleep_for(std::chrono::milliseconds(20));Check(requests.load()==0,"unacknowledged_admission_wrote");
      admitted->store(true);
      const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(6);
      while(std::chrono::steady_clock::now()<deadline){
        const auto state=owner->Status();
        if(state.at("verified_files").template get<int>()>=1&&refreshes.load()>=1)break;
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
      }
      const auto state=owner->Status();
      Check(state.at("verified_files").template get<int>()>=1&&refreshes.load()>=1&&!malformed.load(),"metadata_discovery_or_disk_restore_failed");
      const auto matches=engine.Match("explicit software oracle",{{source},now-1000,now+1000,20});
      Check(matches.at("items").size()==2&&matches.at("partial")==false,"restored_scope_not_certified_or_lost_rows");
      owner->Stop(); owner.reset();Check(history.Usage().at("samples")==2,"background_changed_history");
      Check(fs::remove(root/identity.id/"1.records.f32le"),"fixture_file_missing");
      auto repair_files=IndexShardFiles::OpenForTesting(root);
      ManagedIndexRuntime repair_owner(bootstrap,history,engine,std::move(repair_files),context,2,admitted);
      const auto repair_deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
      while(repairs.load()==0&&std::chrono::steady_clock::now()<repair_deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
      Check(repairs.load()==1&&!malformed.load(),"broken_cache_not_scheduled_for_repair");
      Check(engine.Match("explicit software oracle",{{source},now-1000,now+1000,20}).at("items").size()==2,
        "broken_derived_file_blocked_core_query");
      repair_owner.Stop();
      server.stop();listener.join();
    }catch(...){server.stop();if(listener.joinable())listener.join();throw;}
    std::cout<<"managed Mongo metadata -> coalesced refresh and SSD restore integration passed (software fixture)\n";
  }catch(...){cleanup();std::error_code ignored;fs::remove_all(root,ignored);throw;}
  cleanup();std::error_code ignored;fs::remove_all(root,ignored);
}

int main(){try{
  // Construction of the unconnected Mongo owner does not access a database.
  // No server, credentials, SDK or hardware models exist in this test.
  HistoryMongo history("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=100", "ainvr_search_runtime_unused");
  NeverEncoder encoder; MatchEngine engine(history,encoder,8);
  const auto source="22222222-2222-4222-8222-222222222222";
  engine.Start({{source},0,86400000,20});
  const auto bootstrap=nlohmann::json{{"control_url","http://127.0.0.1:1"},{"service_token",std::string(48,'s')}};
  for(int run=0;run<32;++run){
    char name[]="/tmp/ainvr-index-runtime-XXXXXX";
    const auto made=mkdtemp(name);Check(made,"test_tmp_failed");const fs::path root=made;
    try{
      auto files=IndexShardFiles::OpenForTesting(root);
      IndexJobContext context{std::string(64,'b'),files->StorageGeneration(),"siglip2-base-full-int8",encoder.ModelVersion(),{source},30};
      auto admitted=std::make_shared<std::atomic<bool>>(false);
      const auto before=std::chrono::steady_clock::now();
      {
        ManagedIndexRuntime owner(bootstrap,history,engine,std::move(files),context,2,admitted);
        const auto state=owner.Status();
        Check(state.at("verified_files")==0 && state.at("publications")==0 && state.at("discovery_checkpoint")==0,
          "unacknowledged_generation_started_work");
        owner.Stop(); owner.Stop();
      }
      Check(std::chrono::steady_clock::now()-before<std::chrono::seconds(2),"stop_not_woken_or_joined");
      // Stop/drain released the file writer before a new config generation.
      auto reopened=IndexShardFiles::OpenForTesting(root);Check(bool(reopened),"writer_lock_leaked");
      ManagedIndexRuntime metadata_only(bootstrap,history,static_cast<MatchEngine*>(nullptr),std::move(reopened),context,0,admitted);
      Check(metadata_only.Status().at("verified_files")==0,"missing encoder faked source warm");metadata_only.Stop();
    }catch(...){std::error_code ignored;fs::remove_all(root,ignored);throw;}
    std::error_code ignored;fs::remove_all(root,ignored);
  }
  std::cout<<"32 managed index generation/drain checks passed; no DB/model/hardware used\n";
  if(const char* control=std::getenv("AINVR_SEARCH_TEST_CONTROL_URL")) ParameterIntegration(control);
  else Integration();
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
