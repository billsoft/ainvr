// Throughput of actual Mongo/coverage/file/HTTP code with synthetic vectors.
// This is not BPU, model accuracy or real-camera evidence. PG is a bounded
// control-plane fixture; source/target metadata and derived files are real.
#include "index_runtime.hpp"
#include "migration_sample.hpp"
#include <mongoc/mongoc.h>
#include <filesystem>
#include <fstream>
#include <algorithm>
#include <cstdio>
#include <ctime>
#include <mutex>
#include <thread>
#include <unistd.h>
using namespace ainvr::search;using Json=nlohmann::json;namespace fs=std::filesystem;
namespace {
using Clock=std::chrono::steady_clock;
void Check(bool ok,const char*why){if(!ok)throw std::runtime_error(why);}
int64_t Now(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
double Millis(Clock::duration elapsed){return std::chrono::duration<double,std::milli>(elapsed).count();}
std::string Id(int n){char out[37];snprintf(out,sizeof(out),"20000000-0000-4000-8000-%012d",n);return out;}
Json Pin(const RuntimeModelPin&p){return{{"package_id",p.package_id},{"package_sha256",p.package_sha256},{"model_version",p.model_version}};}
struct Server {httplib::Server value;std::thread thread;int port=0;void Start(){port=value.bind_to_any_port("127.0.0.1");Check(port>0,"bind");thread=std::thread([this]{value.listen_after_bind();});for(int n=0;n<200&&!value.is_running();++n)std::this_thread::sleep_for(std::chrono::milliseconds(5));Check(value.is_running(),"listen");}~Server(){value.stop();if(thread.joinable())thread.join();}};
struct Oracle final:TextEncoder {std::string model;explicit Oracle(std::string m):model(std::move(m)){}std::string ModelVersion()const override{return model;}size_t Dimensions()const override{return 2;}std::vector<float>Encode(const std::string&)override{return{1,0};}};
Json Latencies(std::vector<double> values){Check(!values.empty(),"no_foreground_queries");std::sort(values.begin(),values.end());const auto p=[&](double f){return values[std::min(values.size()-1,size_t(f*(values.size()-1)))];};return{{"count",values.size()},{"p50_ms",p(.50)},{"p95_ms",p(.95)},{"max_ms",values.back()}};}
struct SeedDocument {
  bson_t* value;
  explicit SeedDocument(bson_t* doc):value(doc){}
  SeedDocument(const SeedDocument&)=delete;
  SeedDocument&operator=(const SeedDocument&)=delete;
  SeedDocument(SeedDocument&& other)noexcept:value(other.value){other.value=nullptr;}
  ~SeedDocument(){if(value)bson_destroy(value);}
};
void Bulk(mongoc_client_t*client,const std::string&database,std::vector<SeedDocument>&rows){
  if(rows.empty())return;
  Check(rows.size()<=256,"bounded_seed_batch");
  auto collection=mongoc_client_get_collection(client,database.c_str(),"search_samples");bson_t reply;bson_error_t error{};
  bson_t options=BSON_INITIALIZER;auto wc=mongoc_write_concern_new();mongoc_write_concern_set_w(wc,1);mongoc_write_concern_set_journal(wc,true);mongoc_write_concern_append(wc,&options);mongoc_write_concern_destroy(wc);
  const bson_t* views[256]{};for(size_t i=0;i<rows.size();++i)views[i]=rows[i].value;
  const bool ok=mongoc_collection_insert_many(collection,views,rows.size(),&options,&reply,&error);
  bson_destroy(&reply);bson_destroy(&options);mongoc_collection_destroy(collection);rows.clear();Check(ok,"bulk_seed_failed");
}
bson_t* Document(const Sample&s,int64_t ordinal){
  const auto d=ComputeSampleContractDigest(s);Json j{{"_id",s.record.id},{"channel",s.record.channel},{"model",s.record.model},{"captured_ms",s.record.captured_ms},
    {"metadata",d.metadata},{"fingerprint",d.fingerprint},{"metadata_sha",d.metadata_sha},{"vector_sha",d.vector_sha},{"jpeg_sha",d.jpeg_sha},
    {"ordinal",ordinal},{"expires_at",{{"$date",{{"$numberLong",std::to_string(s.expires_ms)}}}}},{"bytes",{{"$numberLong","0"}}}};
  bson_error_t error{};const auto text=j.dump();auto doc=bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),-1,&error);Check(doc,"seed_document");
  BSON_APPEND_BINARY(doc,"vector",BSON_SUBTYPE_BINARY,d.vector_bytes.data(),d.vector_bytes.size());BSON_APPEND_BINARY(doc,"jpeg",BSON_SUBTYPE_BINARY,s.jpeg.data(),s.jpeg.size());
  bson_iter_t bytes;bson_iter_init_find(&bytes,doc,"bytes");bson_iter_overwrite_int64(&bytes,doc->len);return doc;
}
Json Run(size_t count,size_t channels){
  const std::string uri="mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=2000",database="ainvr_migration_perf_"+std::to_string(getpid())+"_"+std::to_string(count);
  auto client=mongoc_client_new(uri.c_str());auto db=mongoc_client_get_database(client,database.c_str());
  char temp[]="/tmp/ainvr-migration-perf-XXXXXX";Check(mkdtemp(temp),"private_tmp");const fs::path root=temp;
  const auto cleanup=[&]{bson_error_t error{};const bool ok=mongoc_database_drop(db,&error);mongoc_database_destroy(db);mongoc_client_destroy(client);fs::remove_all(root);Check(ok,"drop_fixture");};
  try{
    HistoryBudget limits;limits.max_samples=100000;limits.max_bytes=512LL*1024*1024;HistoryMongo history(uri,database,limits);history.Initialize();
    const auto now=Now();const RuntimeModelPin old{"siglip-so400m-i18n-full-int8",std::string(64,'a'),"search-v1-"+std::string(64,'a')},target{"siglip2-base-full-int8",std::string(64,'b'),"search-v1-"+std::string(64,'b')};
    Scope scope;scope.from_ms=now-20000;scope.to_ms=now+1;for(size_t c=0;c<channels;++c)scope.channels.insert(Id(c+1));
    std::map<std::string,std::vector<Record>> target_rows;std::map<std::string,int64_t> checkpoint;std::vector<float> vector(768);vector[0]=1;
    std::vector<SeedDocument> pending;const auto seed_at=Clock::now();
    for(size_t i=0;i<count;++i){
      Sample source;source.record={SampleStorageUuid("perf-source-v1",Json::array({count,i})),Id(1+i%channels),"processor","session","track-"+std::to_string(i),old.model_version,now-10000,false,{1,0}};
      source.evidence={{"schema_version","1.0"},{"role","match"},{"source_input_id",Id(100)},{"output_channel_id",source.record.channel},{"recording_channel_id",source.record.channel},
        {"stream_session_id","session"},{"frame_id",SampleStorageUuid("perf-frame-v1",Json::array({count,i}))},{"source_pts_ns",std::to_string(source.record.captured_ms*1000000)},
        {"source_frame_index",std::to_string(i)},{"input_path","/live/in"},{"output_path","/live/out"},{"input_spec_version","synthetic-old-vector"},{"frame_width",1920},{"frame_height",1080}};
      source.jpeg={255,216,255,217};source.expires_ms=now+3600000;source.fingerprint=source.record.fingerprint=ComputeSampleContractDigest(source).fingerprint;
      const auto derivative=MakeReencodedSample(source,old,target,FindPackageSpec(target.package_id),vector,source.fingerprint,SampleSha256(source.jpeg.data(),source.jpeg.size()),now);
      pending.emplace_back(Document(source,int64_t(2*i+1)));pending.emplace_back(Document(derivative,int64_t(2*i+2)));
      target_rows[source.record.channel].push_back(derivative.record);checkpoint[source.record.channel]=int64_t(2*i+2);
      if(pending.size()>=256)Bulk(client,database,pending);
    }Bulk(client,database,pending);const auto seed_ms=Millis(Clock::now()-seed_at);
    IndexShardFileLimits file_limits;file_limits.max_records=10000;file_limits.max_shard_bytes=64ULL*1024*1024;
    auto files=IndexShardFiles::OpenForTesting(root,file_limits);IndexJobContext context{std::string(64,'c'),files->StorageGeneration(),old.package_id,old.model_version,std::vector<std::string>(scope.channels.begin(),scope.channels.end()),30};
    const std::time_t seconds=(now-10000)/1000;std::tm utc{};gmtime_r(&seconds,&utc);char day[11];strftime(day,sizeof(day),"%Y-%m-%d",&utc);
    std::map<std::string,Json> published;int n=0;
    for(auto&[channel,rows]:target_rows){IndexShardIdentity shard{Id(200+n++),1,channel,target.model_version,day,768,checkpoint[channel],context.storage_generation};const auto pub=files->Publish(shard,rows);
      published[channel]={{"id",shard.id},{"channel_id",channel},{"model_version",target.model_version},{"day",day},{"published_revision",1},
        {"manifest_key",pub.manifest_key},{"manifest_sha256",pub.manifest_sha256},{"checkpoint",pub.checkpoint},{"record_count",pub.record_count},{"byte_count",pub.byte_count},{"partial",true}};
    }
    target_rows.clear(); // Seeding vectors do not coexist with the measured pass.
    MigrationWriteProof proof{Id(300),Id(301),"software-perf",std::string(64,'d'),1};MigrationWriteGrant grant;grant.source=old;grant.target=target;grant.scope=scope;
    grant.source_high_watermark=int64_t(count*2-1);grant.target_checkpoint=int64_t(count*2);grant.lease_until_ms=Now()+30000;grant.job_expires_ms=now+3600000;
    Server control;std::atomic<size_t> source_calls{0},migration_calls{0};
    control.value.Post("/api/internal/search/model-migrations",[&](const auto&req,auto&res){++migration_calls;const Json b=Json::parse(req.body);
      Check(b.at("action")=="authorize_artifacts"&&b.at("job_id")==proof.job_id,"unexpected_authority");
      res.set_content(Json{{"grant",{{"job_id",proof.job_id},{"worker",proof.worker},{"generation",proof.generation},{"payload_fingerprint",proof.payload_fingerprint},
        {"source",Pin(old)},{"target",Pin(target)},{"scope",{{"channel_ids",std::vector<std::string>(scope.channels.begin(),scope.channels.end())},{"from_ms",scope.from_ms},{"to_ms",scope.to_ms}}},
        {"source_high_watermark",std::to_string(grant.source_high_watermark)},{"target_checkpoint",std::to_string(grant.target_checkpoint)},
        {"job_expires_ms",grant.job_expires_ms},{"lease_until_ms",Now()+30000}}}}.dump(),"application/json");});
    control.value.Post("/api/internal/search/index-jobs",[&](const auto&req,auto&res){const Json b=Json::parse(req.body);Json out;const bool migration=b.contains("migration_lease");if(!migration)++source_calls;
      const auto action=b.at("action").get<std::string>();
      if(action=="claim")out={{"job",nullptr}};
      else if(action=="catalog"||action=="retired_catalog")out={{"revision",context.revision},{"storage_generation",context.storage_generation},{"items",Json::array()},{"next_cursor",nullptr}};
      else if(action=="refresh"){
        const auto channel=b.at("channel_id").get<std::string>();out={{"job_id",Id(400)},{"shard_id",migration?published.at(channel).at("id"):Json(Id(401))},{"state","succeeded"},{"accepted_checkpoint",b.at("minimum_checkpoint")}};
      }else if(action=="published"){
        out={{"shard",nullptr}};for(const auto&[channel,pub]:published)if(pub.at("id")==b.at("shard_id"))out["shard"]=pub;
      }else throw std::runtime_error("unexpected_index_operation");
      res.set_content(out.dump(),"application/json");});
    control.Start();const Json bootstrap{{"control_url","http://127.0.0.1:"+std::to_string(control.port)},{"service_token",std::string(48,'s')}};
    Oracle oracle(old.model_version);MatchEngine engine(history,oracle,512);engine.Start(scope);
    HttpAccess access;access.revision=context.revision;access.enabled=true;access.unavailable_reason.clear();access.console_key=std::string(48,'c');access.producer_key=std::string(48,'p');
    HttpService api(&history,access,&engine);Server web;api.Register(web.value);web.Start();
    const Json query{{"query","explicit software vector oracle"},{"scope",{{"channel_ids",std::vector<std::string>(scope.channels.begin(),scope.channels.end())},{"from_ms",scope.from_ms},{"to_ms",scope.to_ms},{"limit",20}}}};
    const auto read=[&](httplib::Client&http){const auto reply=http.Post("/v1/match",httplib::Headers{{"x-service-token",std::string(48,'c')}},query.dump(),"application/json");Check(reply&&reply->status==200,"foreground_query_failed");const auto body=Json::parse(reply->body);Check(body.at("partial")==true&&!body.at("items").empty(),"foreground_false_complete_or_missing");};
    httplib::Client baseline_client("127.0.0.1",web.port);baseline_client.set_read_timeout(10);std::vector<double> baseline;
    for(int i=0;i<20;++i){const auto begin=Clock::now();read(baseline_client);baseline.push_back(Millis(Clock::now()-begin));}
    auto admitted=std::make_shared<std::atomic<bool>>(true);ManagedIndexRuntime owner(bootstrap,history,engine,std::move(files),context,2,admitted);
    std::atomic<bool> done{false},failed{false};std::vector<double> foreground;
    std::thread queries([&]{try{httplib::Client http("127.0.0.1",web.port);http.set_read_timeout(10);while(!done.load()){
      const auto begin=Clock::now();read(http);foreground.push_back(Millis(Clock::now()-begin));std::this_thread::sleep_for(std::chrono::milliseconds(20));}}
      catch(...){failed=true;}});
    const auto started=Clock::now();Json status;
    try{owner.ActivateMigration(proof,grant);const auto deadline=Clock::now()+std::chrono::seconds(110);
      do{std::this_thread::sleep_for(std::chrono::milliseconds(20));grant.lease_until_ms=Now()+30000;status=owner.ActivateMigration(proof,grant);if(status.at("state")=="ready")break;
        Check(status.at("state")!="unavailable","artifacts_capacity_failed");}
      while(Clock::now()<deadline);done=true;queries.join();owner.Stop();
    }catch(...){done=true;queries.join();owner.Stop();throw;}
    const auto elapsed=Millis(Clock::now()-started);Check(status.at("state")=="ready"&&!failed,"complete_pass_failed_or_foreground_interrupted");
    Check(status.at("coverage_snapshot").at("required")==count&&status.at("coverage_snapshot").at("matched")==count&&status.at("coverage_snapshot").at("unavailable")==0,"coverage_not_full_current_scope");
    const Json report{{"source_rows",count},{"target_rows",count},{"channels",channels},{"dimensions_target",768},{"seed_ms",seed_ms},{"full_pass_and_file_verification_ms",elapsed},
      {"rows_per_second",count*1000.0/elapsed},{"baseline_query",Latencies(baseline)},{"concurrent_query",Latencies(foreground)},
      {"source_maintenance_calls",source_calls.load()},{"migration_authorization_calls",migration_calls.load()},{"max_source_day_records",10000},{"max_vector_bytes",64*1024*1024},
      {"synthetic_vectors",true},{"hardware",false},{"foreground_dimensions",2},{"foreground_working_set_records",512},
      {"storage","isolated tmpfs Mongo and private ordinary-directory derived files"},{"build_type","Release"},{"report",status}};
    cleanup();return report;
  }catch(...){cleanup();throw;}
}
}
int main(){if(!std::getenv("AINVR_SEARCH_TEST_MONGO"))return 77;try{
  mongoc_init();Json report{{"schema_version","search-migration-throughput-software-v1"},{"cases",Json::array()}};
  for(const auto&[rows,channels]:std::vector<std::pair<size_t,size_t>>{{10000,1},{15000,2}}){auto result=Run(rows,channels);report["cases"].push_back(result);std::cout<<result.dump()<<std::endl;}
  const std::string path="test/results/search-migration-throughput.json";std::ofstream output(path,std::ios::trunc);output<<report.dump(2)<<'\n';Check(bool(output),"report_write");
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
