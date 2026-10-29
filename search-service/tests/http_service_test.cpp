#include "http_service.hpp"
#include <mongoc/mongoc.h>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <future>
#include <iostream>
#include <thread>
using namespace ainvr::search;
using Json = nlohmann::json;
using namespace std::chrono_literals;
int64_t Now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
void Check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
std::string Id(int n) { return "00000000-0000-4000-8000-" + std::to_string(100000000000LL + n); }
const std::string token(48, 't'), channel = Id(1);
const httplib::Headers auth{{"x-service-token", token}};
const httplib::Headers producer{{"x-service-token", std::string(48, 'p')}, {"x-search-config-revision", std::string(64, '0')}};
HttpAccess Access() {
  HttpAccess access; access.console_key = token; access.producer_key = std::string(48, 'p');
  access.management_key = std::string(48, 'm'); access.revision = std::string(64, '0');
  access.enabled = true; access.unavailable_reason.clear(); access.ingestion_model = "fixture-pair-v1";
  access.sources.emplace(channel, ProducerSource{Id(3), "fixture-processor", Id(4), true, true, "/live/raw", "/live/ai"});
  return access;
}

// Synthetic transport/index oracle only: never built into a production service
// and deliberately named as a fixture, not a CPU model fallback.
class FixtureEncoder final : public TextEncoder {
 public:
  std::string ModelVersion() const override { return version; }
  size_t Dimensions() const override { return 2; }
  bool Healthy() const override { return healthy.load(); }
  std::vector<float> Encode(const std::string& text) override {
    ++calls;
    std::unique_lock<std::mutex> lock(mutex);
    if (text == "hold") { entered = true; changed.notify_all(); changed.wait(lock, [&] { return !hold; }); }
    if (text == "too-long") throw QueryTextError(QueryTextError::Reason::TooLong);
    if (text == "unrepresentable") throw QueryTextError(QueryTextError::Reason::Unrepresentable);
    if (text == "runtime-failure") throw std::runtime_error("driver secret never disclose");
    if (text == "invalid-vector") return {0, 0};
    if (text == "scaled-vector") return {3, 0};
    return {1, 0};
  }
  void Wait() { std::unique_lock<std::mutex> lock(mutex); Check(changed.wait_for(lock, 2s, [&] { return entered; }), "encoder never entered"); }
  void Release() { std::lock_guard<std::mutex> lock(mutex); hold = false; changed.notify_all(); }
  std::mutex mutex; std::condition_variable changed; bool hold = true, entered = false;
  std::atomic<bool> healthy{true}; std::atomic<int> calls{0};
  std::string version="fixture-pair-v1";
};
class RunningServer {
 public:
  explicit RunningServer(HttpService& service) {
    service.Register(server); port = server.bind_to_any_port("127.0.0.1"); Check(port > 0, "test bind");
    thread = std::thread([&] { server.listen_after_bind(); });
    for (int i = 0; i < 200 && !server.is_running(); ++i) std::this_thread::sleep_for(5ms);
    Check(server.is_running(), "test server unavailable");
  }
  ~RunningServer() { server.stop(); if (thread.joinable()) thread.join(); }
  httplib::Server server; int port = 0; std::thread thread;
};
Json Expect(const httplib::Result& response, int status) {
  if (!response || response->status != status) throw std::runtime_error("expected HTTP " + std::to_string(status) +
    "; got " + (response ? std::to_string(response->status) + " " + response->body.substr(0, 256) : "transport failure"));
  Check(response->get_header_value("Cache-Control") == "no-store", "cache disclosure");
  Check(response->get_header_value("X-Content-Type-Options") == "nosniff", "missing image protection");
  return Json::parse(response->body);
}
void CheckMigrationCapabilities(httplib::Client& client, bool source_gate=false) {
  const char* path = "/v1/model-migrations/capabilities";
  Expect(client.Get(path), 401);
  Expect(client.Get(path, httplib::Headers{{"x-service-token", std::string(48, 'u')}}), 401);
  Expect(client.Get(path, httplib::Headers{{"x-service-token", std::string(48, 'm')}, {"x-service-token", std::string(48, 'm')}}), 401);
  Expect(client.Get(path, auth), 403);
  Expect(client.Get(path, producer), 403);
  const Json expected = {{"implemented", true}, {"source_ingestion_gate", source_gate}, {"target_write", true}, {"artifacts", true}};
  Check(Expect(client.Get(path, httplib::Headers{{"x-service-token", std::string(48, 'm')}}), 200) == expected,
    "migration implementation metadata changed or exposed runtime configuration");
}
Json ScopeJson(int64_t at) { return {{"channel_ids", {channel}}, {"from_ms", at - 1}, {"to_ms", at + 1}, {"limit", 20}}; }
Json SampleJson(int64_t at) {
  return {{"id", Id(2)}, {"channel_id", channel}, {"processor_id", "fixture-processor"},
    {"stream_session_id", "fixture-session"}, {"track_id", "fixture-track"}, {"model_version", "fixture-pair-v1"},
    {"captured_ms", at}, {"kind", "object"}, {"expires_ms", at + 60000}, {"vector", {1, 0}},
    {"evidence", {{"source_input_id", Id(3)}, {"output_channel_id", channel}, {"recording_channel_id", Id(4)},
      {"input_path", "/live/raw"}, {"output_path", "/live/ai"},
      {"frame_id", Id(5)}, {"role", "match"}, {"schema_version", "1.0"}, {"stream_session_id", "fixture-session"},
      {"source_pts_ns", "123456000"}, {"source_frame_index", "123"}, {"frame_width", 1920}, {"frame_height", 1080}}}};
}
httplib::UploadFormDataItems Parts(const Json& metadata) {
  return {{"metadata", metadata.dump(), "metadata.json", "application/json"},
    {"image", std::string("\xff\xd8\xff\xd9", 4), "frame.jpg", "image/jpeg"}};
}
Json ReceiptJson(Json sample, const std::string& token, const std::string& fingerprint) {
  sample.erase("vector");
  return {{"sample", sample}, {"slot", 0}, {"replacement_token", token}, {"request_fingerprint", fingerprint}};
}
// Only the runner's owned, temporary Mongo may be locked. No mock handler or
// production hook stands in for the source write that must retain its permit.
class FixtureMongoWriteLock {
 public:
  explicit FixtureMongoWriteLock(const std::string& uri) {
    Check(uri=="mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=2000","write lock outside isolated fixture");
    client_=mongoc_client_new(uri.c_str());Check(client_,"fixture lock client");
    try { Command("fsync",{{"lock",true}});locked_=true; }
    catch(...) { mongoc_client_destroy(client_);throw; }
  }
  ~FixtureMongoWriteLock(){try{Unlock();}catch(...){}mongoc_client_destroy(client_);}
  void Unlock(){if(locked_){Command("fsyncUnlock");locked_=false;}}
  bool WaitingWrite(const std::string& database){
    const auto result=Command("currentOp",{{"$all",true},{"waitingForLock",true},
      {"ns",{{"$regex","^"+database+"\\."}}}});
    return !result.at("inprog").empty();
  }
 private:
  Json Command(const char* name,const Json& options=Json::object()){
    nlohmann::ordered_json value;value[name]=1;
    for(auto it=options.begin();it!=options.end();++it)value[it.key()]=it.value();
    bson_error_t error{};const auto text=value.dump();
    auto command=bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),-1,&error);
    Check(command,"fixture lock command");bson_t reply;
    const bool ok=mongoc_client_command_simple(client_,"admin",command,nullptr,&reply,&error);
    bson_destroy(command);
    if(!ok){bson_destroy(&reply);throw std::runtime_error("isolated fixture lock command failed");}
    auto json=bson_as_relaxed_extended_json(&reply,nullptr);
    const auto result=Json::parse(json);bson_free(json);bson_destroy(&reply);return result;
  }
  mongoc_client_t* client_=nullptr;bool locked_=false;
};
void RunSourceAdmissionCases(const std::string& uri,const std::string& database){
  auto mongo=mongoc_client_new(uri.c_str());auto db=mongoc_client_get_database(mongo,database.c_str());
  const auto cleanup=[&]{bson_error_t error{};const bool ok=mongoc_database_drop(db,&error);
    mongoc_database_destroy(db);mongoc_client_destroy(mongo);Check(ok,"source gate fixture cleanup");};
  try{
    HistoryMongo history(uri,database);history.Initialize();auto access=Access();
    access.source_admission=std::make_shared<SourceAdmission>();const auto admission=access.source_admission;
    const RuntimeModelPin source{"siglip-so400m-i18n-full-int8",std::string(64,'b'),"search-v1-"+std::string(64,'b')};
    const RuntimeModelPin target{"siglip2-base-full-int8",std::string(64,'c'),"search-v1-"+std::string(64,'c')};
    access.ingestion_model=source.model_version;const auto at=Now()-2000;
    const auto sample=[&](int id,int64_t captured,bool scene){auto body=SampleJson(captured);body["id"]=Id(id);
      body["model_version"]=source.model_version;if(scene){body["kind"]="scene";body["track_id"]="";}return body;};
    const auto pin=[](const RuntimeModelPin& p){return Json{{"package_id",p.package_id},{"package_sha256",p.package_sha256},{"model_version",p.model_version}};};
    std::atomic<int> authority_calls{0};access.migration_authorization=[&](const Json&)->Json{
      ++authority_calls;return {{"grant",{{"job_id",Id(930)},{"worker",Id(931)},{"generation",3},{"payload_fingerprint",std::string(64,'a')},
        {"source",pin(source)},{"target",pin(target)},{"scope",{{"channel_ids",{channel}},{"from_ms",at-1},{"to_ms",at+10}}},
        {"source_high_watermark","9223372036854775807"},{"target_checkpoint","0"},{"lease_until_ms",Now()+10000},{"job_expires_ms",Now()+60000}}}};
    };
    FixtureEncoder encoder;encoder.version=source.model_version;MatchEngine engine(history,encoder,16);
    HttpService service(&history,access,&engine);
    service.SetMigrationArtifacts([](const auto&,const auto&){return Json{{"fixture_artifacts",true}};});
    RunningServer running(service);httplib::Client client("127.0.0.1",running.port);client.set_read_timeout(5);
    CheckMigrationCapabilities(client,true);
    const auto scene=sample(880,at,true);const auto scene_ack=Expect(client.Post("/v1/samples",producer,Parts(scene)),200);
    const Json slot{{"sample",sample(881,at+1,false)},{"slot",0},{"expected_fingerprint",""},{"replacement_token","gate-first"}};
    const auto slot_ack=Expect(client.Post("/v1/samples/slot",producer,Parts(slot)),200);
    const Json coverage{{"id",Id(882)},{"model_version",source.model_version},{"channel_id",channel},
      {"from_ms",at-1},{"to_ms",at+10},{"kind","object"},{"state","sampled"},{"expires_ms",Now()+60000}};
    Expect(client.Put("/v1/coverage/range",producer,coverage.dump(),"application/json"),200);
    RuntimeIngestionGate gate{Id(920),Id(921),Id(922),SampleSha256(Json::array({channel}).dump()),3,Now()+120000,source};
    const auto paused=[&](const httplib::Result& response){
      Check(Expect(response,503)==Json{{"error","source_ingestion_paused"}},"source gate fixed error changed");
      Check(response->get_header_value("Retry-After")=="1","source gate retry bound missing");
    };
    {
      FixtureMongoWriteLock lock(uri);std::future<httplib::Result> old_write;
      try{
        old_write=std::async(std::launch::async,[&]{httplib::Client writer("127.0.0.1",running.port);writer.set_read_timeout(5);
          return writer.Post("/v1/samples",producer,Parts(sample(883,at+2,true)));});
        bool waiting=false;for(int n=0;n<200&&!waiting;++n){waiting=lock.WaitingWrite(database);if(!waiting)std::this_thread::sleep_for(5ms);}
        Check(waiting,"old HTTP writer never entered isolated Mongo");admission->Apply(gate,Now());
        Check(!admission->DrainedGate(),"old HTTP writer released permit before write completed");
        paused(client.Post("/v1/samples",producer,Parts(sample(884,at+3,true))));
        lock.Unlock();Expect(old_write.get(),200);
      }catch(...){try{lock.Unlock();}catch(...){}if(old_write.valid())old_write.wait();throw;}
    }
    Check(admission->DrainedGate().has_value(),"completed HTTP writer did not release its permit");
    paused(client.Post("/v1/samples",producer,Parts(scene)));
    paused(client.Post("/v1/samples/slot",producer,Parts(slot)));
    paused(client.Put("/v1/coverage/range",producer,coverage.dump(),"application/json"));
    const Json deletion{{"channel_id",channel},{"from_ms",at-1},{"to_ms",at+10}};
    paused(client.Delete("/v1/history/range",auth,deletion.dump(),"application/json"));
    Expect(client.Post("/v1/samples",auth,Parts(scene)),403);
    auto stale=producer;stale.erase("x-search-config-revision");Expect(client.Post("/v1/samples",stale,Parts(scene)),409);
    CheckMigrationCapabilities(client,true);
    auto scene_metadata=scene;scene_metadata.erase("vector");
    Check(Expect(client.Post("/v1/samples/receipt",producer,Json{{"sample",scene_metadata},{"request_fingerprint",scene_ack.at("fingerprint")}}.dump(),"application/json"),200).at("status")=="committed","source pause blocked scene receipt");
    Check(Expect(client.Post("/v1/samples/slot/receipt",producer,ReceiptJson(slot.at("sample"),"gate-first",slot_ack.at("fingerprint")).dump(),"application/json"),200).at("status")=="committed","source pause blocked slot receipt");
    const auto scope=Json{{"channel_ids",{channel}},{"from_ms",at-1},{"to_ms",at+10},{"limit",20}};
    engine.Rebuild({{channel},at-1,at+10,20});
    Check(!Expect(client.Post("/v1/match",auth,Json{{"query","person"},{"scope",scope}}.dump(),"application/json"),200).at("items").empty(),"source pause blocked old queries");
    Expect(client.Post("/v1/coverage",auth,Json{{"model_version",source.model_version},{"scope",scope}}.dump(),"application/json"),200);
    Expect(client.Post("/v1/samples/extent",auth,Json{{"source_model",source.model_version},{"channel_ids",{channel}}}.dump(),"application/json"),200);
    const Json session{{"id",Id(885)},{"actor","gate-operator"},{"query","person"},{"scope",scope},{"model_version",source.model_version},{"verify",false},{"expires_ms",Now()+60000}};
    const auto opened=Expect(client.Post("/v1/searches/begin",auth,session.dump(),"application/json"),200);
    Expect(client.Post("/v1/searches/publish",auth,Json{{"id",Id(885)},{"actor","gate-operator"},{"version",opened.at("version")},{"coverage","sampled"},
      {"items",Json::array({{{"sample_id",Id(880)},{"similarity",1.0},{"fingerprint",scene_ack.at("fingerprint")}}})}}.dump(),"application/json"),200);
    Expect(client.Post("/v1/searches/feedback",auth,Json{{"id",Id(885)},{"actor","gate-operator"},{"sample_id",Id(880)},{"relevant",true}}.dump(),"application/json"),200);
    Json migration{{"job_id",Id(930)},{"worker",Id(931)},{"generation",3},{"actor","gate-operator"},{"payload_fingerprint",std::string(64,'a')},
      {"source",{{"sample_id",Id(880)},{"fingerprint",scene_ack.at("fingerprint")},{"jpeg_sha256",SampleSha256(std::string("\xff\xd8\xff\xd9",4))}}},{"target",pin(target)}};
    std::vector<float> vector(768,0);vector[0]=1;migration["target"]["vector"]=vector;
    const httplib::Headers management{{"x-service-token",std::string(48,'m')}};
    Expect(client.Post("/v1/model-migrations/write-target",management,migration.dump(),"application/json"),200);
    migration["target"].erase("vector");
    Check(Expect(client.Post("/v1/model-migrations/target-receipt",management,migration.dump(),"application/json"),200).at("status")=="committed","source pause blocked target receipt");
    Check(Expect(client.Post("/v1/model-migrations/artifacts",management,Json{{"action","status"},{"job_id",Id(930)},{"worker",Id(931)},
      {"generation",3},{"actor","gate-operator"},{"payload_fingerprint",std::string(64,'a')}}.dump(),"application/json"),200).at("fixture_artifacts"),"source pause blocked artifact metadata");
    Check(authority_calls>=5,"migration bypassed existing authorization");
    gate.epoch=Id(923);gate.expires_ms=Now()-1;admission->Apply(gate,Now());
    Check(!admission->DrainedGate(),"expired HTTP gate manufactured ACK");paused(client.Post("/v1/samples",producer,Parts(scene)));
    // Explicit low-level open only. A production durable Begin is deliberately
    // not claimed by this HTTP transport test; its controller owns that proof.
    admission->Apply(std::nullopt,Now());Expect(client.Post("/v1/samples",producer,Parts(scene)),200);
    Expect(client.Delete("/v1/history/range",auth,deletion.dump(),"application/json"),200);
    const auto resumed=history.BeginSourceWriterEpoch(Id(924),SourceWriterBootstrap::FreshNamespaceAuthority,at+100);
    Check(resumed.durable,"fixture resume boundary not durable");
    const auto before_resume=[&](const httplib::Result& response){
      Check(Expect(response,409)==Json{{"error","source_frame_before_resume"}},"pre-resume frame rejection not explicit");
      Check(response->get_header_value("Content-Type")=="application/json; charset=utf-8","pre-resume error media type");
    };
    before_resume(client.Post("/v1/samples",producer,Parts(sample(886,at+3,true))));
    auto old_slot=slot;old_slot["sample"]=sample(887,at+4,false);
    before_resume(client.Post("/v1/samples/slot",producer,Parts(old_slot)));
    Check(!history.Get(Id(886))&&!history.Get(Id(887)),"rejected old frame reached storage");
    Expect(client.Post("/v1/samples",producer,Parts(sample(888,at+100,true))),200);
    cleanup();
  }catch(...){try{cleanup();}catch(...){}throw;}
}
#include "../../test/search/native_metadata_cases.hpp"
#include "../../test/search/native_migration_write_cases.hpp"
#include "../../test/search/native_migration_coverage_cases.hpp"
int main() {
  if (!std::getenv("AINVR_SEARCH_TEST_MONGO")) { std::cout << "SKIP: isolated Mongo fixture not requested\n"; return 77; }
  const std::string uri = "mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=2000";
  const auto database = "ainvr_search_http_test_" + std::to_string(Now());
  mongoc_init();
  const auto cleanup = [&] {
    auto client = mongoc_client_new(uri.c_str()); auto db = mongoc_client_get_database(client, database.c_str());
    bson_error_t error{}; const bool ok = mongoc_database_drop(db, &error);
    mongoc_database_destroy(db); mongoc_client_destroy(client); Check(ok, "fixture cleanup failed");
  };
  try {
    HistoryBudget budget; budget.max_samples = 2;
    HistoryMongo history(uri, database, budget); history.Initialize();
    HttpService pending(&history, Access()); RunningServer pending_server(pending);
    httplib::Client client("127.0.0.1", pending_server.port); client.set_read_timeout(5);
    Expect(client.Get("/v1/status"), 401);
    Expect(client.Get("/v1/status", httplib::Headers{{"x-service-token", std::string(48, 'u')}}), 401);
    Expect(client.Get("/v1/status", httplib::Headers{{"x-service-token", token}, {"x-service-token", token}}), 401);
    Check(Expect(client.Get("/v1/status", auth), 200).at("reason") == "model_pending", "false readiness");
    Expect(client.Get("/v1/status", producer), 403);
    Expect(client.Post("/v1/samples", auth, Parts(SampleJson(Now() - 1000))), 403);
    Expect(client.Get("/v1/models", auth), 403);
    Check(Expect(client.Get("/v1/models", httplib::Headers{{"x-service-token", std::string(48, 'm')}}), 200).at("items").empty(), "catalog auth");
    CheckMigrationCapabilities(client);
    Expect(client.Post("/v1/searches/cancel", {{"x-service-token", std::string(48, 'm')}}, "{}", "application/json"), 403);
    auto stale = producer; stale.erase("x-search-config-revision");
    Expect(client.Post("/v1/samples", stale, Parts(SampleJson(Now() - 1000))), 409);
    auto disabled_access = Access(); disabled_access.enabled = false;
    HttpService disabled(nullptr, disabled_access); RunningServer disabled_server(disabled);
    httplib::Client off("127.0.0.1", disabled_server.port);
    CheckMigrationCapabilities(off);
    Check(Expect(off.Get("/v1/status", auth), 200).at("reason") == "disabled", "disabled dependency-free status");
    Check(Expect(off.Get("/health"), 200).at("alive"), "disabled liveness");
    Expect(off.Post("/v1/samples", producer, Parts(SampleJson(Now() - 1000))), 503);
    Expect(off.Post("/v1/coverage", auth, "{}", "application/json"), 503);
    auto gated_access = Access(); gated_access.admitted->store(false);
    HttpService gated(&history, gated_access); RunningServer gated_server(gated);
    httplib::Client waiting("127.0.0.1", gated_server.port);
    CheckMigrationCapabilities(waiting);
    Check(Expect(waiting.Get("/v1/status", auth), 200).at("reason") == "config_pending", "unacknowledged generation admitted");
    Expect(waiting.Post("/v1/samples", producer, Parts(SampleJson(Now() - 1000))), 503);
    Expect(waiting.Post("/v1/coverage", auth, "{}", "application/json"), 503);
    gated_access.admitted->store(true);
    Check(Expect(waiting.Get("/v1/status", auth), 200).at("reason") == "model_pending", "ACK did not activate generation");
    const auto at = Now() - 1000; const auto scope = ScopeJson(at);
    const Json query = {{"query", "person in red jacket"}, {"scope", scope}};
    Check(Expect(client.Post("/v1/match", auth, query.dump(), "application/json"), 503).at("error") == "model_pending", "fake model query");
    Expect(client.Post("/v1/match", auth, "{broken", "application/json"), 400);
    auto invalid = query; invalid["scope"]["limit"] = 1.5;
    Expect(client.Post("/v1/match", auth, invalid.dump(), "application/json"), 400);
    invalid = query; invalid["scope"]["channel_ids"].push_back(channel);
    Expect(client.Post("/v1/match", auth, invalid.dump(), "application/json"), 400);
    invalid = query; invalid["scope"]["from_ms"] = 18446744073709551615ULL;
    Expect(client.Post("/v1/match", auth, invalid.dump(), "application/json"), 400);
    auto row = SampleJson(at);
    for (const char* field : {"input_path", "output_path"}) {
      auto wrong_path = row; wrong_path["evidence"][field] = "/live/other";
      Expect(client.Post("/v1/samples", producer, Parts(wrong_path)), 403);
      wrong_path["evidence"].erase(field);
      Expect(client.Post("/v1/samples", producer, Parts(wrong_path)), 403);
      wrong_path["evidence"][field] = nullptr;
      Expect(client.Post("/v1/samples", producer, Parts(wrong_path)), 403);
    }
    auto top_level_path = row; top_level_path["input_path"] = "/live/raw";
    Expect(client.Post("/v1/samples", producer, Parts(top_level_path)), 400);
    Expect(client.Post("/v1/samples", producer, Parts(row)), 200);
    Expect(client.Post("/v1/samples", producer, Parts(row)), 200); // Idempotent retry.
    invalid = row; invalid["vector"] = {0, 1};
    Expect(client.Post("/v1/samples", producer, Parts(invalid)), 409);
    invalid = row; invalid["id"] = Id(20); invalid["evidence"]["stream_session_id"] = "wrong-session";
    Expect(client.Post("/v1/samples", producer, Parts(invalid)), 400);
    auto duplicate = Parts(row); duplicate.push_back(duplicate[0]);
    Expect(client.Post("/v1/samples", producer, duplicate), 400);
    auto deep = row; for (int i = 0; i < 18; ++i) deep = Json{{"nested", deep}};
    Expect(client.Post("/v1/samples", producer, Parts(deep)), 400);
    std::string path = "/v1/samples/" + Id(2) + "?channel_id=" + channel + "&model_version=fixture-pair-v1";
    auto meta = Expect(client.Get(path.c_str(), auth), 200);
    Check(meta.at("evidence").at("recording_channel_id") == Id(4) && !meta.contains("vector"), "provenance or vector leakage");
    auto image = client.Get(("/v1/samples/" + Id(2) + "/image?channel_id=" + channel + "&model_version=fixture-pair-v1").c_str(), auth);
    Check(image && image->status == 200 && image->body.size() == 4 && image->get_header_value("Content-Type") == "image/jpeg", "image not returned");
    Expect(client.Get((path + "&channel_id=" + Id(9)).c_str(), auth), 400);
    Expect(client.Get(("/v1/samples/" + Id(2) + "?channel_id=" + Id(9) + "&model_version=fixture-pair-v1").c_str(), auth), 404);
    Json coverage = {{"id", Id(6)}, {"model_version", "fixture-pair-v1"}, {"channel_id", channel},
      {"from_ms", at - 1}, {"to_ms", at + 1}, {"kind", "object"}, {"state", "sampled"}, {"expires_ms", at + 60000}};
    Expect(client.Put("/v1/coverage/range", producer, coverage.dump(), "application/json"), 200);
    Json coverage_query = {{"model_version", "fixture-pair-v1"}, {"scope", scope}};
    auto ranges = Expect(client.Post("/v1/coverage", auth, coverage_query.dump(), "application/json"), 200);
    Check(ranges.at("ranges").size() == 1, "coverage missing");
    FixtureEncoder encoder; MatchEngine engine(history, encoder, 8);
    HttpService available(&history, Access(), &engine); RunningServer available_server(available);
    httplib::Client compute("127.0.0.1", available_server.port); compute.set_read_timeout(5);
    Check(!Expect(compute.Get("/v1/status", auth), 200).at("ready").get<bool>(), "index falsely ready");
    engine.Rebuild({{channel}, at - 1, at + 1, 20});
    Check(Expect(compute.Get("/v1/status", auth), 200).at("ready"), "fixture not ready");
    encoder.healthy.store(false);
    auto unhealthy = Expect(compute.Get("/v1/status", auth), 200);
    Check(!unhealthy.at("ready").get<bool>() && unhealthy.at("reason") == "service_unavailable", "faulted encoder falsely ready");
    Expect(compute.Post("/v1/match", auth, query.dump(), "application/json"), 503);
    Check(encoder.calls.load() == 0, "faulted encoder executed");
    encoder.healthy.store(true);
    auto matches = Expect(compute.Post("/v1/match", auth, query.dump(), "application/json"), 200);
    Check(matches.at("items").size() == 1 && matches.at("items")[0].at("similarity") == 1 && !matches.at("partial").get<bool>(), "match/index projection");
    const auto encoded_once=encoder.calls.load();
    Expect(compute.Post("/v1/match", auth, query.dump(), "application/json"),200);
    Check(encoder.calls.load()==encoded_once,"repeat query did not reuse text embedding");
    auto other_scope=query;other_scope["scope"]["from_ms"]=at+10;other_scope["scope"]["to_ms"]=at+20;
    Check(Expect(compute.Post("/v1/match",auth,other_scope.dump(),"application/json"),200).at("items").empty(),
      "embedding cache reused results from another time scope");
    Check(encoder.calls.load()==encoded_once,"scope-only change re-encoded same text");
    encoder.healthy.store(false);
    Expect(compute.Post("/v1/match",auth,query.dump(),"application/json"),503);
    Check(encoder.calls.load()==encoded_once,"unhealthy cache lookup executed encoder");
    encoder.healthy.store(true);
    auto scaled=query;scaled["query"]="scaled-vector";
    Expect(compute.Post("/v1/match",auth,scaled.dump(),"application/json"),200);
    const auto encoded_scaled=encoder.calls.load();
    Expect(compute.Post("/v1/match",auth,scaled.dump(),"application/json"),200);
    Check(encoder.calls.load()==encoded_scaled,"normalized model vector not retained");
    FixtureEncoder changed_model;changed_model.version="fixture-pair-v2";
    MatchEngine changed_engine(history,changed_model,8);changed_engine.Rebuild({{channel},at-1,at+1,20});
    Check(changed_engine.Match("person in red jacket",{{channel},at-1,at+1,20}).at("items").empty()&&
      changed_model.calls.load()==1,"new model instance reused previous embedding space");
    Json session = {{"id", Id(40)}, {"actor", "fixture-operator"}, {"query", "person in red jacket"},
      {"scope", scope}, {"model_version", "fixture-pair-v1"}, {"verify", true}, {"expires_ms", Now() + 3600000}};
    auto opened = Expect(compute.Post("/v1/searches/begin", auth, session.dump(), "application/json"), 200);
    Check(opened.at("version").get<std::string>().size() == 64, "invalid query generation");
    auto again = Expect(compute.Post("/v1/searches/begin", auth, session.dump(), "application/json"), 200);
    Check(again == opened, "retry replaced query generation");
    auto changed_query = session; changed_query["query"] = "a different person";
    Expect(compute.Post("/v1/searches/begin", auth, changed_query.dump(), "application/json"), 409);
    Json read = {{"id", Id(40)}, {"actor", "fixture-operator"}, {"offset", 0}, {"limit", 20}};
    auto unpublished = Expect(compute.Post("/v1/searches/read", auth, read.dump(), "application/json"), 200);
    Check(!unpublished.at("published").get<bool>(), "query falsely complete");
    Json publish = {{"id", Id(40)}, {"actor", "fixture-operator"}, {"version", opened.at("version")},
      {"coverage", "sampled"}, {"items", Json::array({{{"sample_id", Id(2)}, {"similarity", 1.0}}})}};
    Check(Expect(compute.Post("/v1/searches/publish", auth, publish.dump(), "application/json"), 200).at("published"), "query not committed");
    auto snapshot = Expect(compute.Post("/v1/searches/read", auth, read.dump(), "application/json"), 200);
    Check(snapshot.at("published") && snapshot.at("items").size() == 1 && snapshot.at("items")[0].at("feedback").is_null(), "query response mismatch");
    Json bound_image = {{"id", Id(40)}, {"actor", "fixture-operator"}, {"sample_id", Id(2)}, {"frame_id", Id(5)}};
    auto bound_bytes = compute.Post("/v1/searches/image", auth, bound_image.dump(), "application/json");
    Check(bound_bytes && bound_bytes->status == 200 && bound_bytes->body.size() == 4 && bound_bytes->get_header_value("Content-Type") == "image/jpeg", "snapshot image unavailable");
    auto bad_image = bound_image; bad_image["frame_id"] = Id(6);
    Expect(compute.Post("/v1/searches/image", auth, bad_image.dump(), "application/json"), 404);
    auto wrong_actor = read; wrong_actor["actor"] = "another-operator";
    Expect(compute.Post("/v1/searches/read", auth, wrong_actor.dump(), "application/json"), 404);
    Json feedback = {{"id", Id(40)}, {"actor", "fixture-operator"}, {"sample_id", Id(2)}, {"relevant", false}};
    Expect(compute.Post("/v1/searches/feedback", auth, feedback.dump(), "application/json"), 200);
    snapshot = Expect(compute.Post("/v1/searches/read", auth, read.dump(), "application/json"), 200);
    Check(snapshot.at("items")[0].at("feedback") == false, "feedback not overlaid");
    Json cancel = {{"id", Id(40)}, {"actor", "fixture-operator"}};
    Expect(compute.Post("/v1/searches/cancel", auth, cancel.dump(), "application/json"), 200);
    Expect(compute.Post("/v1/searches/cancel", auth, cancel.dump(), "application/json"), 200);
    Expect(compute.Post("/v1/searches/read", auth, read.dump(), "application/json"), 404);
    Expect(compute.Post("/v1/searches/image", auth, bound_image.dump(), "application/json"), 404);
    Expect(compute.Post("/v1/searches/publish", auth, publish.dump(), "application/json"), 410);
    cancel["id"] = Id(41); Expect(compute.Post("/v1/searches/cancel", auth, cancel.dump(), "application/json"), 200);
    session["id"] = Id(41); Expect(compute.Post("/v1/searches/begin", auth, session.dump(), "application/json"), 410);
    auto multiline = query; multiline["query"] = "person\nin red jacket";
    Expect(compute.Post("/v1/match", auth, multiline.dump(), "application/json"), 200);
    auto bad_encoding = query; bad_encoding["query"] = "invalid-vector";
    // Bad model output is a service failure, not a malformed user request.
    Expect(compute.Post("/v1/match", auth, bad_encoding.dump(), "application/json"), 503);
    const auto failed_encoding_calls=encoder.calls.load();
    Expect(compute.Post("/v1/match", auth, bad_encoding.dump(), "application/json"), 503);
    Check(encoder.calls.load()==failed_encoding_calls+1,"failed encoding was cached");
    for (const auto& entry : std::vector<std::pair<std::string, std::string>>{
        {"too-long", "query_too_long"}, {"unrepresentable", "query_unrepresentable"}}) {
      auto input = query; input["query"] = entry.first;
      Check(Expect(compute.Post("/v1/match", auth, input.dump(), "application/json"), 400).at("error") == entry.second,
        "query text error was swallowed");
    }
    auto runtime_failure = query; runtime_failure["query"] = "runtime-failure";
    Check(Expect(compute.Post("/v1/match", auth, runtime_failure.dump(), "application/json"), 503).at("error") == "service_unavailable",
      "encoder internal error leaked");
    auto held = std::async(std::launch::async, [&] {
      httplib::Client other("127.0.0.1", available_server.port); other.set_read_timeout(5);
      Json hold = query; hold["query"] = "hold";
      return other.Post("/v1/match", auth, hold.dump(), "application/json");
    });
    bool busy = false;
    try { encoder.Wait(); auto response = compute.Post("/v1/match", auth, query.dump(), "application/json"); busy = response && response->status == 429; }
    catch (...) { encoder.Release(); held.wait(); throw; }
    encoder.Release(); Expect(held.get(), 200); Check(busy, "inference queue unbounded");
    // Fill the authoritative quota through the transport.
    row["id"] = Id(7); Expect(client.Post("/v1/samples", producer, Parts(row)), 200);
    row["id"] = Id(8); Expect(client.Post("/v1/samples", producer, Parts(row)), 507);
    Json deletion = {{"channel_id", channel}, {"from_ms", at - 1}, {"to_ms", at + 1}};
    Expect(client.Delete("/v1/history/range", auth, deletion.dump(), "application/json"), 200);
    Expect(client.Delete("/v1/history/range", auth, deletion.dump(), "application/json"), 200);
    Expect(client.Get(path.c_str(), auth), 404);
    auto empty = Expect(compute.Post("/v1/match", auth, query.dump(), "application/json"), 200);
    Check(empty.at("items").empty(), "deleted data resurrected through index");
    row["id"] = Id(2); Expect(client.Post("/v1/samples", producer, Parts(row)), 410);
    // Dedicated bounded slot endpoint: stable ID, new frame and generation,
    // idempotent lost-ACK retry, stale CAS rejection and no old-score/new-image.
    auto slot_sample = SampleJson(at + 1000); slot_sample["id"] = Id(60); slot_sample["track_id"] = "slot-track";
    Json slot = {{"sample", slot_sample}, {"slot", 0}, {"expected_fingerprint", ""}, {"replacement_token", "first-token"}};
    for (const char* field : {"input_path", "output_path"}) {
      auto wrong_path = slot; wrong_path["sample"]["evidence"][field] = "/live/other";
      Expect(client.Post("/v1/samples/slot", producer, Parts(wrong_path)), 403);
      wrong_path["sample"]["evidence"].erase(field);
      Expect(client.Post("/v1/samples/slot", producer, Parts(wrong_path)), 403);
    }
    auto saved = Expect(client.Post("/v1/samples/slot", producer, Parts(slot)), 200);
    const auto original_fingerprint = saved.at("fingerprint").get<std::string>();
    Check(original_fingerprint.size() == 64, "slot ACK generation missing");
    const auto receipt_query = ReceiptJson(slot_sample, "first-token", original_fingerprint);
    const auto lookup = [&](const Json& body, const httplib::Headers& headers, int expected = 200) {
      return Expect(client.Post("/v1/samples/slot/receipt", headers, body.dump(), "application/json"), expected);
    };
    auto receipt = lookup(receipt_query, producer);
    Check(receipt == Json{{"status", "committed"}, {"fingerprint", original_fingerprint}}, "exact receipt did not acknowledge write");
    lookup(receipt_query, auth, 403);
    lookup(receipt_query, {{"x-service-token", std::string(48,'m')}}, 403);
    lookup(receipt_query, stale, 409);
    auto bad_receipt = receipt_query; bad_receipt["sample"]["evidence"]["source_input_id"] = Id(99);
    lookup(bad_receipt, producer, 403);
    bad_receipt = receipt_query; bad_receipt["sample"]["stream_session_id"] = "other";
    bad_receipt["sample"]["evidence"]["stream_session_id"] = "other";
    receipt = lookup(bad_receipt,producer);
    Check(receipt == Json{{"status","scope_mismatch"},{"fingerprint",nullptr}},"foreign session receipt leaked data");
    bad_receipt = receipt_query; bad_receipt["request_fingerprint"] = std::string(64,'0');
    Check(lookup(bad_receipt,producer).at("status") == "write_mismatch","different body hash falsely acknowledged");
    bad_receipt = receipt_query; bad_receipt["sample"]["evidence"]["frame_id"] = Id(99);
    Check(lookup(bad_receipt,producer).at("status") == "write_mismatch","different exact frame falsely acknowledged");
    bad_receipt = receipt_query; bad_receipt["sample"]["vector"] = {1,0}; lookup(bad_receipt,producer,400);
    bad_receipt = receipt_query; bad_receipt["sample"]["evidence"]["padding"] = std::string(16384,'x'); lookup(bad_receipt,producer,400);
    bad_receipt = receipt_query; bad_receipt["sample"]["id"] = Id(9999);
    receipt = lookup(bad_receipt,producer); Check(receipt == Json{{"status","not_found"},{"fingerprint",nullptr}},"missing receipt returned foreign state");
    bad_receipt["sample"]["captured_ms"] = Now() - 2000; bad_receipt["sample"]["expires_ms"] = Now() - 1000;
    Check(lookup(bad_receipt,producer).at("status") == "expired","expired absent receipt not distinguished");
    Check(Expect(client.Post("/v1/samples/slot", producer, Parts(slot)), 200) == saved, "slot retry was not idempotent");
    Json slot_scope = ScopeJson(at + 1000); engine.Rebuild({{channel}, at + 999, at + 1002, 20});
    auto slot_query = query; slot_query["scope"] = slot_scope;
    auto slot_match = Expect(compute.Post("/v1/match", auth, slot_query.dump(), "application/json"), 200);
    Check(slot_match.at("items")[0].at("fingerprint") == original_fingerprint, "match omitted scored generation");
    session["id"] = Id(61); session["scope"] = slot_scope; session["expires_ms"] = Now() + 60000;
    auto slot_open = Expect(compute.Post("/v1/searches/begin", auth, session.dump(), "application/json"), 200);
    publish["id"] = Id(61); publish["version"] = slot_open.at("version");
    publish["items"] = Json::array({{{"sample_id", Id(60)}, {"similarity", 1.0}, {"fingerprint", original_fingerprint}}});
    slot["sample"]["captured_ms"] = at + 1000; slot["sample"]["evidence"]["frame_id"] = Id(62);
    slot["sample"]["evidence"]["source_pts_ns"] = "123457000"; slot["sample"]["evidence"]["source_frame_index"] = "124";
    slot["expected_fingerprint"] = original_fingerprint; slot["replacement_token"] = "second-token";
    auto replaced = Expect(client.Post("/v1/samples/slot", producer, Parts(slot)), 200);
    Check(replaced.at("fingerprint") != original_fingerprint, "slot generation did not change");
    receipt = lookup(receipt_query,producer);
    Check(receipt == Json{{"status","replaced"},{"fingerprint",nullptr}},"old receipt exposed replacement fingerprint");
    const auto new_receipt = ReceiptJson(slot["sample"],"second-token",replaced.at("fingerprint"));
    Check(lookup(new_receipt,producer).at("status") == "committed","current replacement not acknowledged");
    // This mutation used the other transport instance, so its score projection
    // is intentionally stale. Both query and publication must refuse new data.
    Expect(compute.Post("/v1/searches/publish", auth, publish.dump(), "application/json"), 200);
    read["id"] = Id(61);
    auto stale_snapshot = Expect(compute.Post("/v1/searches/read", auth, read.dump(), "application/json"), 200);
    Check(stale_snapshot.at("items").empty() && stale_snapshot.at("coverage") == "partial", "old score bound to replacement image");
    slot["replacement_token"] = "late-token";
    Expect(client.Post("/v1/samples/slot", producer, Parts(slot)), 409);
    deletion["from_ms"] = at + 1000; deletion["to_ms"] = at + 1001;
    Expect(client.Delete("/v1/history/range",auth,deletion.dump(),"application/json"),200);
    Check(lookup(new_receipt,producer) == Json{{"status","deleted"},{"fingerprint",nullptr}},"deleted write was resurrected by receipt");
    // Immutable scene writes have the same unknown-ACK readback semantics,
    // without inventing a slot or a separate receipt ledger.
    auto scene = SampleJson(at + 2000); scene["id"] = Id(70); scene["kind"] = "scene"; scene["track_id"] = "";
    const auto scene_ack = Expect(client.Post("/v1/samples", producer, Parts(scene)), 200);
    const auto scene_saved = history.Get(Id(70), false);
    Check(bool(scene_saved), "scene write missing");
    Check(scene_ack.at("stored") && scene_ack.at("fingerprint") == scene_saved->fingerprint, "scene ACK lost exact write fingerprint");
    scene.erase("vector");
    const Json scene_request{{"sample", scene}, {"request_fingerprint", scene_saved->fingerprint}};
    const auto scene_lookup = [&](const Json& body, const httplib::Headers& headers, int expected = 200) {
      return Expect(client.Post("/v1/samples/receipt", headers, body.dump(), "application/json"), expected);
    };
    Check(scene_lookup(scene_request, producer) == Json{{"status", "committed"}, {"fingerprint", scene_saved->fingerprint}}, "scene ACK not reconciled");
    scene_lookup(scene_request, {}, 401);
    scene_lookup(scene_request, auth, 403);
    scene_lookup(scene_request, {{"x-service-token", std::string(48, 'm')}}, 403);
    scene_lookup(scene_request, stale, 409);
    auto bad_scene = scene_request; bad_scene["sample"]["evidence"]["source_input_id"] = Id(99);
    scene_lookup(bad_scene, producer, 403);
    bad_scene = scene_request; bad_scene["sample"]["processor_id"] = "";
    scene_lookup(bad_scene, producer, 403);
    auto unowned_scene = SampleJson(at + 2001); unowned_scene["id"] = Id(73);
    unowned_scene["kind"] = "scene"; unowned_scene["track_id"] = ""; unowned_scene["processor_id"] = "";
    Expect(client.Post("/v1/samples", producer, Parts(unowned_scene)), 403);
    bad_scene = scene_request; bad_scene["sample"]["kind"] = "object"; bad_scene["sample"]["track_id"] = "object";
    scene_lookup(bad_scene, producer, 400);
    bad_scene = scene_request; bad_scene["sample"]["vector"] = {1,0}; scene_lookup(bad_scene, producer, 400);
    bad_scene = scene_request; bad_scene["sample"]["evidence"]["padding"] = std::string(16384, 'x');
    scene_lookup(bad_scene, producer, 400);
    bad_scene = scene_request; bad_scene["request_fingerprint"] = std::string(64, '0');
    Check(scene_lookup(bad_scene, producer).at("status") == "write_mismatch", "wrong scene hash acknowledged");
    bad_scene = scene_request; bad_scene["sample"]["evidence"]["frame_id"] = Id(71);
    Check(scene_lookup(bad_scene, producer).at("status") == "write_mismatch", "wrong scene frame acknowledged");
    bad_scene = scene_request; bad_scene["sample"]["id"] = Id(72);
    Check(scene_lookup(bad_scene, producer) == Json{{"status", "not_found"}, {"fingerprint", nullptr}}, "scene receipt leaked foreign data");
    deletion["from_ms"] = at + 2000; deletion["to_ms"] = at + 2001;
    Expect(client.Delete("/v1/history/range", auth, deletion.dump(), "application/json"), 200);
    Check(scene_lookup(scene_request, producer) == Json{{"status", "deleted"}, {"fingerprint", nullptr}}, "deleted scene resurrected");
    RunMetadataCases(uri,database+"_metadata");
    RunMigrationWriteCases(uri,database+"_migration");
    RunMigrationCoverageCases(uri,database+"_coverage");
    RunSourceAdmissionCases(uri,database+"_source_gate");
    cleanup();
    std::cout << "HTTP: auth, bounds, real Mongo, images, coverage, matching, contention, quota and deletion passed (synthetic encoder only)\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; try { cleanup(); } catch (...) {} return 1;
  }
}
