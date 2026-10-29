// Actual isolated Mongo/files/HTTP; PG is a named bounded authority fixture.
// Synthetic vectors only. No text/vision encoder, SDK or model access exists.
#include "migration_artifacts.hpp"
#include "migration_sample.hpp"
#include "http_service.hpp"
#include <filesystem>
#include <mongoc/mongoc.h>
#include <unistd.h>
#include <iostream>
using namespace ainvr::search;using Json=nlohmann::json;namespace fs=std::filesystem;
namespace {
int checks=0;void Check(bool v,const char*m){++checks;if(!v)throw std::runtime_error(m);}
int64_t Now(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
std::string Stamp(int64_t ms){time_t seconds=ms/1000;std::tm utc{};gmtime_r(&seconds,&utc);char out[25];strftime(out,sizeof(out),"%Y-%m-%dT%H:%M:%SZ",&utc);return out;}
std::string Id(int n){char out[37];std::snprintf(out,sizeof(out),"10000000-0000-4000-8000-%012d",n);return out;}
Json Pin(const RuntimeModelPin&p){return{{"package_id",p.package_id},{"package_sha256",p.package_sha256},{"model_version",p.model_version}};}
struct Server{httplib::Server value;int port=0;std::thread thread;void Start(){port=value.bind_to_any_port("127.0.0.1");Check(port>0,"bind");thread=std::thread([this]{value.listen_after_bind();});for(int n=0;n<200&&!value.is_running();++n)std::this_thread::sleep_for(std::chrono::milliseconds(5));Check(value.is_running(),"listen");}~Server(){value.stop();if(thread.joinable())thread.join();}};
}
int main(){if(!std::getenv("AINVR_SEARCH_TEST_MONGO"))return 77;try{
  const std::string uri="mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=2000",database="ainvr_migration_artifacts_"+std::to_string(getpid());
  auto mongo=mongoc_client_new(uri.c_str());auto db=mongoc_client_get_database(mongo,database.c_str());
  char path[]="/tmp/ainvr-migration-artifacts-XXXXXX";Check(mkdtemp(path),"private_tmp");const fs::path root=path;
  const auto cleanup=[&]{bson_error_t error{};const bool ok=mongoc_database_drop(db,&error);mongoc_database_destroy(db);mongoc_client_destroy(mongo);fs::remove_all(root);Check(ok,"drop_fixture");};
  try{
    HistoryMongo history(uri,database);history.Initialize();const auto now=Now(),expiry=now+60000;
    const RuntimeModelPin source_pin{"siglip-so400m-i18n-full-int8",std::string(64,'a'),"search-v1-"+std::string(64,'a')},
      target_pin{"siglip2-base-full-int8",std::string(64,'b'),"search-v1-"+std::string(64,'b')};
    Sample source;source.record={Id(1),Id(2),"processor","session","track",source_pin.model_version,now-100,false,{1,0}};source.track_slot=0;
    source.evidence={{"schema_version","1.0"},{"role","match"},{"source_input_id",Id(3)},{"output_channel_id",Id(2)},{"recording_channel_id",Id(2)},
      {"stream_session_id","session"},{"frame_id",Id(4)},{"source_pts_ns","1000"},{"source_frame_index","1"},{"input_path","/live/in"},{"output_path","/live/out"},
      {"frame_width",1920},{"frame_height",1080},{"input_spec_version","old-spec"}};
    source.jpeg={255,216,255,217};source.expires_ms=expiry;history.ReplaceTrackSlot(source,0,"","initial");source=history.Get(Id(1),true).value();
    const Scope scope{{Id(2)},now-1000,now+1000,20};const auto original=history.ReadReencodeSource(Id(1),source.fingerprint,source_pin.model_version,scope).value();
    std::vector<float> vector(768);vector[0]=1;auto target=MakeReencodedSample(source,source_pin,target_pin,FindPackageSpec(target_pin.package_id),vector,source.fingerprint,original.jpeg_sha256,now);
    history.WriteReencodedSample(target,original);target=history.Get(target.record.id,true).value();
    const auto target_meta=history.ReadReencodeSource(target.record.id,target.fingerprint,target_pin.model_version,scope,false).value();
    auto files=IndexShardFiles::OpenForTesting(root);IndexJobContext base{std::string(64,'c'),files->StorageGeneration(),source_pin.package_id,source_pin.model_version,{Id(2)},30};
    const time_t seconds=source.record.captured_ms/1000;std::tm date{};gmtime_r(&seconds,&date);char day[11];strftime(day,sizeof(day),"%Y-%m-%d",&date);
    IndexShardIdentity shard{Id(5),1,Id(2),target_pin.model_version,day,768,target_meta.ordinal,base.storage_generation};
    const auto pub=files->Publish(shard,{target.record});
    Json published{{"id",shard.id},{"channel_id",shard.channel_id},{"model_version",shard.model_version},{"day",day},{"published_revision",1},
      {"manifest_key",pub.manifest_key},{"manifest_sha256",pub.manifest_sha256},{"checkpoint",pub.checkpoint},{"record_count",pub.record_count},{"byte_count",pub.byte_count},{"partial",true}};
    MigrationWriteProof proof{Id(6),Id(7),"fixture-actor",std::string(64,'d'),2};
    MigrationWriteGrant grant;grant.source=source_pin;grant.target=target_pin;grant.scope=scope;grant.source_high_watermark=original.ordinal;
    grant.lease_until_ms=now+40000;grant.job_expires_ms=expiry;grant.target_checkpoint=target_meta.ordinal;
    const auto authorize=[&](const Json&request)->Json{
      if(request.at("job_id")!=proof.job_id||request.at("actor")!=proof.actor||request.at("generation")!=proof.generation||request.at("payload_fingerprint")!=proof.payload_fingerprint)return{{"grant",nullptr}};
      Json body{{"job_id",proof.job_id},{"generation",proof.generation},{"payload_fingerprint",proof.payload_fingerprint},
        {"source",Pin(source_pin)},{"target",Pin(target_pin)},{"scope",{{"channel_ids",{Id(2)}},{"from_ms",scope.from_ms},{"to_ms",scope.to_ms}}},
        {"source_high_watermark",std::to_string(original.ordinal)},{"job_expires_ms",expiry},{"target_checkpoint",std::to_string(target_meta.ordinal)}};
      if(request.at("action")=="authorize_report_read"){body["mode"]="report_read";body["actor"]=proof.actor;}
      else{Check(request.at("action")=="authorize_artifacts"&&request.at("worker")==proof.worker,"wrong_write_authority");body["worker"]=proof.worker;body["lease_until_ms"]=grant.lease_until_ms;}
      return{{"grant",body}};
    };
    Server control;int index_calls=0;bool index_ready=true,index_failed=false;int builds=0;
    control.value.Post("/api/internal/search/model-migrations",[&](const auto&req,auto&res){res.set_content(authorize(Json::parse(req.body)).dump(),"application/json");});
    control.value.Post("/api/internal/search/index-jobs",[&](const auto&req,auto&res){++index_calls;const auto b=Json::parse(req.body);
      Check(b.at("migration_lease").at("job_id")==proof.job_id&&b.at("revision")==base.revision,"target_index_without_PG_proof");Json out;
      if(b.at("action")=="retired_catalog")out={{"revision",base.revision},{"storage_generation",base.storage_generation},{"items",Json::array()},{"next_cursor",nullptr}};
      else if(b.at("action")=="refresh")out={{"job_id",Id(8)},{"shard_id",shard.id},{"state",index_failed?"failed":index_ready?"succeeded":"pending"},{"accepted_checkpoint",b.at("minimum_checkpoint")}};
      else if(b.at("action")=="published")out={{"shard",published}};
      else if(b.at("action")=="claim")out={{"job",{{"id",Id(8)},{"actor","internal-search-index"},{"kind","index"},{"state","running"},
        {"generation",1},{"attempts",1},{"lease_owner",proof.worker},{"lease_until",Stamp(now+40000)},{"expires_at",Stamp(expiry)},
        {"minimum_checkpoint",target_meta.ordinal},{"result_ref",nullptr},{"error_code",nullptr},
        {"payload",{{"shard_id",shard.id},{"channel_id",Id(2)},{"model_version",target_pin.model_version},{"day",day},
          {"storage_generation",base.storage_generation},{"config_revision",base.revision},{"package_id",target_pin.package_id}}}}}};
      else if(b.at("action")=="renew")out={{"renewed",true}};
      else if(b.at("action")=="begin")out={{"lease",{{"id",shard.id},{"revision",2},{"jobId",Id(8)},{"jobGeneration",1},
        {"worker",proof.worker},{"storageGeneration",base.storage_generation}}},{"manifest_key",shard.id+"/2.manifest.json"}};
      else if(b.at("action")=="publish"){
        ++builds;index_ready=true;const auto& actual=b.at("publication");published["published_revision"]=2;
        published["manifest_key"]=shard.id+"/2.manifest.json";published["manifest_sha256"]=actual.at("manifestSha256");
        published["checkpoint"]=actual.at("checkpoint");published["record_count"]=actual.at("records");published["byte_count"]=actual.at("bytes");out={{"published",true}};
      }
      else throw std::runtime_error("unexpected_index_work");
      res.set_content(out.dump(),"application/json");});
    control.Start();const Json bootstrap{{"control_url","http://127.0.0.1:"+std::to_string(control.port)},{"service_token",std::string(48,'s')}};
    auto admitted=std::make_shared<std::atomic<bool>>(true);MigrationArtifactsRuntime runtime(bootstrap,history,*files,base,admitted);
    HttpAccess access;access.revision=base.revision;access.enabled=true;access.unavailable_reason.clear();access.admitted=admitted;access.management_key=std::string(48,'m');access.console_key=std::string(48,'c');access.producer_key=std::string(48,'p');access.migration_authorization=authorize;
    HttpService http(&history,access,nullptr);http.SetMigrationArtifacts([&](const auto&p,const auto&g){return runtime.Activate(p,g);});Server api;http.Register(api.value);api.Start();httplib::Client client("127.0.0.1",api.port);
    Json request{{"action","start"},{"job_id",proof.job_id},{"worker",proof.worker},{"generation",proof.generation},{"actor",proof.actor},{"payload_fingerprint",proof.payload_fingerprint}};
    const auto call=[&](const Json&body,int expected,char key='m'){const auto reply=client.Post("/v1/model-migrations/artifacts",{{"x-service-token",std::string(48,key)}},body.dump(),"application/json");Check(reply&&reply->status==expected,"HTTP_artifact_status");return Json::parse(reply->body);};
    call(request,403,'c');call(request,403,'p');Check(call(request,200).at("state")=="building_report","start_scanned_or_missing");
    request["action"]="status";for(int n=0;n<6;++n){runtime.Step();if(call(request,200).at("state")=="ready")break;}
    const auto ready=call(request,200);Check(ready.at("state")=="ready"&&ready.at("coverage_snapshot").at("matched")==1&&ready.at("source_completed_through")==std::to_string(original.ordinal),"no_encoder_target_artifacts_not_ready");
    const auto model_status=client.Get("/v1/status",httplib::Headers{{"x-service-token",std::string(48,'c')}});
    Check(model_status&&model_status->status==200&&Json::parse(model_status->body).at("ready")==false&&
      Json::parse(model_status->body).at("reason")=="model_pending","artifact readiness faked text model readiness");
    const auto artifact=Json::array({shard.id,shard.channel_id,shard.model_version,std::string(day),"1",base.storage_generation,pub.manifest_sha256,std::to_string(pub.checkpoint),pub.record_count,std::to_string(pub.byte_count)});
    Check(ready.at("index_manifest_sha256")==SampleSha256(Json::array({"ainvr-search-migration-index-v1",proof.payload_fingerprint,std::to_string(target_meta.ordinal),Json::array({artifact})}).dump()),"Node_Native_manifest_digest_disagrees");
    Json read=request;read.erase("worker");read["action"]="read";read["after"]=nullptr;read["limit"]=32;
    const auto page=call(read,200);Check(page.at("partitions").size()==1&&page.at("encoded")==1&&page.at("unavailable")==0,"report_wire_not_actual_current_lineage");
    auto bad=read;bad["worker"]=proof.worker;call(bad,400);bad=read;bad["actor"]="wrong";call(bad,409);bad=read;bad["after"]="not_a_partition";call(bad,400);
    Check(index_calls>=3&&history.Usage().at("samples")==2,"artifact_pass_changed_original_history");
    fs::remove(root/shard.id/"1.records.f32le");++proof.generation;request["generation"]=proof.generation;call(request,200);
    for(int n=0;n<4;++n)runtime.Step();
    Check(call(request,200).at("state")!="ready","missing_actual_file_was_marked_ready");
    ++proof.generation;request["generation"]=proof.generation;index_ready=false;call(request,200);
    for(int n=0;n<8;++n){runtime.Step();if(call(request,200).at("state")=="ready")break;}
    Check(call(request,200).at("state")=="ready"&&builds==1&&fs::exists(root/shard.id/"2.manifest.json"),
      "real target Claim/Scan/Publish did not recover without an old encoder");
    Check(history.Get(source.record.id)->fingerprint==source.fingerprint,"target builder changed source authority");
    ++proof.generation;request["generation"]=proof.generation;index_failed=true;call(request,200);
    for(int n=0;n<5;++n)runtime.Step();
    const auto failed=call(request,200);Check(failed.at("state")=="unavailable"&&failed.at("reason")=="migration_index_failed", "terminal index failure stayed pending or ready");
    runtime.Stop();
  }catch(...){cleanup();throw;}cleanup();std::cout<<checks<<" actual Mongo/files/HTTP artifact checks passed; synthetic vectors, no encoder/BPU\n";
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
