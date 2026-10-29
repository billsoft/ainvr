#include "index_job_client.hpp"
#include "sample_contract.hpp"
#include "../../shared/cpp/config_center_client.hpp"
#include <atomic>
#include <chrono>
#include <ctime>
#include <iostream>
#include <mutex>
#include <thread>
using namespace ainvr::search;
using Json = nlohmann::json;
namespace {
int checks = 0;
void Check(bool value, const char* message) { ++checks; if (!value) throw std::runtime_error(message); }
template<class F> void Error(F operation, const char* code) {
  bool rejected = false;
  try { operation(); } catch (const IndexJobError& error) { rejected = std::string(error.what()) == code; }
  Check(rejected, "wrong fixed index error");
}
const std::string channel = "00000000-0000-4000-8000-000000000001", jobid = "00000000-0000-4000-8000-000000000002",
  shardid = "00000000-0000-4000-8000-000000000003", workerid = "00000000-0000-4000-8000-000000000004",
  requestid = "00000000-0000-4000-8000-000000000005", revision(64, 'a'), storage(64, 'b'), digest(64, 'c'),
  model = "search-v1-" + std::string(64, 'd'), secret(48, 's');
std::string Today() { const auto now = std::time(nullptr); std::tm out{}; gmtime_r(&now, &out); char text[11]; std::strftime(text, sizeof(text), "%Y-%m-%d", &out); return text; }
std::string DaysAgo(int days){const auto time=std::time(nullptr)-int64_t(days)*86400;std::tm out{};gmtime_r(&time,&out);char text[11]{};std::strftime(text,sizeof(text),"%Y-%m-%d",&out);return text;}
IndexJobContext Context() { return {revision, storage, "siglip-so400m-i18n-full-int8", model, {channel}, 30}; }
Json ClaimJob() {
  return {{"id", jobid}, {"actor", "internal-search-index"}, {"kind", "index"}, {"state", "running"}, {"generation", 2}, {"attempts", 2},
    {"lease_owner", workerid}, {"lease_until", Today() + "T12:00:30.000Z"}, {"expires_at", Today() + "T23:59:59.000Z"},
    {"request_key", requestid}, {"fingerprint", digest}, {"created_at", Today() + "T00:00:00.000Z"}, {"result_ref", nullptr}, {"error_code", nullptr},
    {"payload", {{"shard_id", shardid}, {"channel_id", channel}, {"model_version", model}, {"day", Today()},
      {"storage_generation", storage}, {"config_revision", revision}, {"package_id", Context().package_id}}}};
}
Json Build() { return {{"lease", {{"id", shardid}, {"revision", 3}, {"jobId", jobid}, {"jobGeneration", 2},
  {"worker", workerid}, {"storageGeneration", storage}}}, {"manifest_key", shardid + "/3.manifest.json"}}; }
Json Published() { return {{"shard", {{"id", shardid}, {"channel_id", channel}, {"model_version", model}, {"day", Today()},
  {"published_revision", "3"}, {"manifest_key", shardid + "/3.manifest.json"}, {"manifest_sha256", digest},
  {"checkpoint", "9007199254740991"}, {"record_count", 7}, {"byte_count", "1099511627776"}, {"partial", false}}}}; }
Json Catalog(Json items,Json cursor=nullptr){return {{"revision",revision},{"storage_generation",storage},{"items",std::move(items)},{"next_cursor",std::move(cursor)}};}
Json Retired(){return {{"id",shardid},{"channel_id",channel},{"model_version",model},{"day","1970-01-02"},{"revision",3},
  {"storage_generation",storage},{"manifest_key",shardid+"/3.manifest.json"}};}
class Bff {
 public:
  Bff() {
    server.Post("/api/internal/search/index-jobs", [&](const auto& req, auto& res) {
      std::lock_guard<std::mutex> lock(mutex); ++calls; received = Json::parse(req.body);
      authenticated = req.get_header_value("x-service-token") == secret;
      res.status = status; res.set_content(raw.empty() ? reply.dump() : raw, "application/json");
    });
    port = server.bind_to_any_port("127.0.0.1"); Check(port > 0, "fixture bind failed");
    thread = std::thread([&] { server.listen_after_bind(); });
    for (int n = 0; n < 200 && !server.is_running(); ++n) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    Check(server.is_running(), "fixture not running");
  }
  ~Bff() { server.stop(); if (thread.joinable()) thread.join(); }
  void Set(Json value, int next_status = 200) { std::lock_guard<std::mutex> lock(mutex); reply = std::move(value); raw.clear(); status = next_status; }
  void SetRaw(std::string value) { std::lock_guard<std::mutex> lock(mutex); raw = std::move(value); status = 200; }
  Json Received() { std::lock_guard<std::mutex> lock(mutex); return received; }
  Json Bootstrap() const { return {{"control_url", "http://127.0.0.1:" + std::to_string(port)}, {"service_token", secret}}; }
  httplib::Server server;
  std::atomic<int> calls{0}; std::atomic<bool> authenticated{false};
 private:
  int port = 0, status = 200; Json reply = Json::object(), received; std::string raw;
  std::mutex mutex; std::thread thread;
};
}
int main() {
  try {
    Bff bff; ainvr::config::ConfigTransport transport(bff.Bootstrap()); IndexJobClient client(transport, Context());
    {
      auto context=Context();context.migration_lease=MigrationWriteProof{requestid,jobid,"fixture-actor",digest,7};
      const int64_t today=int64_t(std::time(nullptr))/86400*86400000;
      context.migration_scope=Scope{{channel},today-100LL*86400000,today-90LL*86400000,20};
      IndexJobClient target(transport,context);bff.Set({{"job_id",jobid},{"shard_id",shardid},{"state","pending"}});
      Check(target.Enqueue(requestid,channel,model,DaysAgo(100)).job_id==jobid,"migration silently applied current retention to still-live old scope");
      const auto proof=bff.Received().at("migration_lease");
      Check(proof==Json{{"job_id",requestid},{"worker",jobid},{"actor","fixture-actor"},{"generation",7},{"payload_fingerprint",digest}},
        "target index request lost exact PG migration proof");
      Error([&]{target.Enqueue(requestid,channel,model,Today());},"index_request_invalid");
      bff.Set({{"job",nullptr}});Check(!target.Claim(workerid),"empty target claim");
      Check(bff.Received().at("worker")==workerid&&bff.Received().at("migration_lease").at("worker")==jobid,
        "index lease and parent migration lease were conflated");
      auto bad=context;bad.migration_scope.reset();Error([&]{IndexJobClient invalid(transport,bad);},"index_request_invalid");
      bad=context;bad.migration_lease->generation=0;Error([&]{IndexJobClient invalid(transport,bad);},"index_request_invalid");
      bad=context;bad.migration_scope->channels={jobid};Error([&]{IndexJobClient invalid(transport,bad);},"index_request_invalid");
    }
    bff.Set({{"job_id", jobid}, {"shard_id", shardid}, {"state", "pending"}});
    auto queued = client.Enqueue(requestid, channel, model, Today());
    Check(queued.job_id == jobid && queued.shard_id == shardid && queued.state == "pending", "enqueue identity lost");
    Check(bff.authenticated && bff.Received() == Json{{"revision", revision}, {"action", "enqueue"}, {"request_key", requestid},
      {"channel_id", channel}, {"model_version", model}, {"day", Today()}, {"kind", "index"}}, "wrong authority/request projection");
    Check(client.Enqueue(requestid,channel,model,DaysAgo(Context().retention_days)).job_id==jobid,"oldest partially live UTC day rejected");
    Error([&]{client.Enqueue(requestid,channel,model,DaysAgo(Context().retention_days+1));},"index_request_invalid");
    bff.Set({{"job", ClaimJob()}}); const auto job = client.Claim(workerid); Check(job.has_value(), "claim absent");
    Check(job->shard.channel_id == channel && job->shard.model_version == model && job->shard.storage_generation == storage && job->shard.revision == 0,
      "claim source/model identity changed");
    Check(job->generation == 2 && job->worker == workerid && bff.Received().at("worker") == workerid, "lease identity changed");
    Check(job->minimum_checkpoint==0,"legacy claim invented watermark");
    auto snapshot_job=ClaimJob();snapshot_job["minimum_checkpoint"]=100;bff.Set({{"job",snapshot_job}});const auto minimum_job=client.Claim(workerid);
    Check(minimum_job&&minimum_job->minimum_checkpoint==100,"claimed watermark lost");
    auto tampered=*minimum_job;tampered.minimum_checkpoint=99;const int before_tamper=bff.calls;
    Error([&]{client.Renew(tampered);},"index_request_invalid");Check(bff.calls==before_tamper,"tampered claimed watermark reached BFF");
    for(const auto& value:{Json(-1),Json("100"),Json(1.5),Json(9007199254740992ULL),Json(nullptr)}){
      snapshot_job=ClaimJob();snapshot_job["minimum_checkpoint"]=value;bff.Set({{"job",snapshot_job}});Error([&]{client.Claim(workerid);},"index_response_invalid");
    }
    bff.Set({{"job", nullptr}}); Check(!client.Claim(workerid), "no work fabricated");
    bff.Set({{"renewed", true}}); Check(client.Renew(*job), "renewal true lost");
    Check(bff.Received() == Json{{"revision", revision}, {"action", "renew"}, {"job_id", jobid}, {"worker", workerid}, {"generation", 2}}, "renew changed lease");
    bff.Set({{"renewed", false}}); Check(!client.Renew(*job), "false renewal fabricated");
    bff.Set(Build()); auto build = client.Begin(*job); Check(build.shard.revision == 3 && build.manifest_key == shardid + "/3.manifest.json", "begin changed manifest identity");
    const ShardPublication publication{build.manifest_key, digest, 9007199254740991LL, 7, 1099511627776ULL};
    build.shard.dimensions = 1152; build.shard.checkpoint = publication.checkpoint;
    bff.Set({{"published", true}}); Check(client.Publish(build, publication), "publication ACK lost");
    Check(bff.Received().at("publication") == Json{{"manifestSha256", digest}, {"checkpoint", 9007199254740991LL}, {"records", 7}, {"bytes", 1099511627776ULL}}, "safe integer changed on wire");
    bff.Set({{"published", false}}); Check(!client.Publish(build, publication), "false publication ACK fabricated");
    bff.Set({{"finished", true}}); Check(client.Fail(*job, "artifact_invalid"), "failure ACK lost");
    bff.Set({{"finished", false}}); Check(!client.Fail(*job, "index_capacity"), "false finish ACK fabricated");
    bff.Set(Published()); const auto found = client.Published(shardid); Check(found && !found->partial && found->shard.checkpoint == 9007199254740991LL && found->publication.byte_count == 1099511627776ULL,
      "PG bigint strings rounded/truncated");
    bff.Set({{"shard", nullptr}}); Check(!client.Published(shardid), "missing shard fabricated");
    {
      bff.Set(Catalog(Json::array({Published().at("shard")}),shardid));
      const auto page=client.Catalog({},1);
      Check(page&&page->shards.size()==1&&page->shards[0].shard.id==shardid&&page->next_cursor==shardid,"catalog page identity lost");
      Check(bff.Received()==Json{{"revision",revision},{"action","catalog"},{"model_version",model},{"cursor",nullptr},{"limit",1}},"catalog context changed on wire");
      bff.Set(Catalog(Json::array()));const auto empty=client.Catalog(shardid,16);
      Check(empty&&empty->shards.empty()&&!empty->next_cursor,"empty catalog confused with unsupported");
      Check(bff.Received().at("cursor")==shardid,"catalog cursor lost");
      auto second=Published().at("shard");const auto previous_day=std::time(nullptr)-86400;std::tm previous{};gmtime_r(&previous_day,&previous);
      char day_text[11]{};std::strftime(day_text,sizeof(day_text),"%Y-%m-%d",&previous);
      second["id"]=requestid;second["day"]=day_text;second["manifest_key"]=requestid+"/3.manifest.json";
      bff.Set(Catalog(Json::array({Published().at("shard"),second}),requestid));
      const auto two=client.Catalog(jobid,2);Check(two&&two->shards.size()==2&&two->next_cursor==requestid,"valid ordered multirow catalog rejected");
      auto full=Catalog(Json::array({Published().at("shard")}));
      for(int change=0;change<14;++change){
        auto wrong=full;
        if(change==0)wrong["revision"]=digest;
        if(change==1)wrong["storage_generation"]=digest;
        if(change==2)wrong["unexpected"]="private-url";
        if(change==3)wrong["items"]=Json::object();
        if(change==4)wrong["items"][0]["channel_id"]=jobid;
        if(change==5)wrong["items"][0]["model_version"]="search-v1-"+digest;
        if(change==6)wrong["items"][0]["day"]="2099-01-01";
        if(change==7)wrong["items"][0]["manifest_key"]="../private";
        if(change==8)wrong["items"][0]["published_revision"]="9007199254740992";
        if(change==9)wrong["items"][0]["partial"]="false";
        if(change==10)wrong["next_cursor"]=requestid;
        if(change==11)wrong["next_cursor"]="http://private/cursor";
        if(change==12)wrong["items"].push_back(wrong["items"][0]);
        if(change==13){wrong["items"].push_back(wrong["items"][0]);wrong["items"][1]["id"]=requestid;wrong["items"][1]["manifest_key"]=requestid+"/3.manifest.json";}
        bff.Set(wrong);Error([&]{client.Catalog({},16);},"index_response_invalid");
      }
      bff.Set(Catalog(Json::array({Published().at("shard")})));Error([&]{client.Catalog(shardid,1);},"index_response_invalid");
      bff.Set(Catalog(Json::array(),shardid));Error([&]{client.Catalog({},1);},"index_response_invalid");
      bff.Set(Catalog(Json::array({Published().at("shard")}),shardid));Error([&]{client.Catalog({},2);},"index_response_invalid");
      const int no_request=bff.calls;
      Error([&]{client.Catalog({},0);},"index_request_invalid");Error([&]{client.Catalog({},17);},"index_request_invalid");
      Error([&]{client.Catalog("../cursor",1);},"index_request_invalid");Error([&]{client.Catalog("",1);},"index_request_invalid");
      Check(bff.calls==no_request,"invalid catalog reached BFF");
    }
    {
      bff.Set({{"job_id",jobid},{"shard_id",shardid},{"state","pending"},{"accepted_checkpoint",123}});
      const auto refreshed=client.Refresh(channel,Today(),123);Check(refreshed&&refreshed->accepted_checkpoint==123,"refresh watermark ACK lost");
      const auto key=SampleStorageUuid("ainvr-search-index-refresh-v1",Json::array({revision,storage,Context().package_id,model,channel,Today(),123}));
      Check(bff.Received()==Json{{"action","refresh"},{"revision",revision},{"request_key",key},{"channel_id",channel},{"model_version",model},
        {"day",Today()},{"minimum_checkpoint",123}},"refresh canonical id/context changed");
      Check(client.Refresh(channel,Today(),123).has_value()&&bff.Received().at("request_key")==key,"explicit retry changed refresh identity");
      for(const auto& value:{Json(122),Json("123"),Json(9007199254740992ULL),Json(1.5),Json(nullptr)}){
        bff.Set({{"job_id",jobid},{"shard_id",shardid},{"state","pending"},{"accepted_checkpoint",value}});
        Error([&]{client.Refresh(channel,Today(),123);},"index_response_invalid");
      }
      bff.Set({{"retired",Retired()}});const auto ref=client.Retired(shardid);
      Check(ref&&ref->shard.dimensions==0&&ref->shard.utc_day=="1970-01-02","cleanup ref invented dims or rejected expired day");
      Check(bff.Received()==Json{{"revision",revision},{"action","retired"},{"shard_id",shardid}},"wrong retired request");
      bff.Set({{"confirmed",true}});Check(client.ConfirmCleanup(*ref),"cleanup confirmation ACK lost");
      Check(bff.Received()==Json{{"revision",revision},{"action","cleanup_confirm"},{"shard_id",shardid},{"retired_revision",3},{"retired_storage_generation",storage}},"cleanup confirmation changed generation");
      bff.Set({{"confirmed",false}});Check(!client.ConfirmCleanup(*ref),"false cleanup confirmation fabricated");
      bff.Set({{"discarded",true}});Check(client.DiscardBuild(build),"build revocation ACK lost");
      Check(bff.Received()==Json{{"revision",revision},{"action","discard_build"},{"job_id",jobid},{"worker",workerid},{"generation",2},
        {"shard_id",shardid},{"build_revision",3}},"build revocation changed proof");
      bff.Set({{"discarded",false}});Check(!client.DiscardBuild(build),"false revocation fabricated");
      bff.Set(Catalog(Json::array({Retired()}),shardid));const auto retired_page=client.RetiredCatalog({},1);
      Check(retired_page&&retired_page->shards.size()==1&&retired_page->next_cursor==shardid,"retired keyset page lost");
      Check(bff.Received().at("action")=="retired_catalog"&&bff.Received().at("model_version")==model,"retired catalog scope lost");
      bff.Set({{"retired",nullptr}});Check(!client.Retired(shardid),"missing retired ref fabricated");
      for(const auto* field:{"id","channel_id","model_version","day","revision","storage_generation","manifest_key"}){
        auto row=Retired();row[field]="private-invalid";bff.Set({{"retired",row}});Error([&]{client.Retired(shardid);},"index_response_invalid");
      }
      auto row=Retired();row["day"]="2099-01-01";bff.Set({{"retired",row}});Error([&]{client.Retired(shardid);},"index_response_invalid");
      row=Retired();row["storage_generation"]=digest;bff.Set(Catalog(Json::array({row})));Error([&]{client.RetiredCatalog({},16);},"index_response_invalid");
      bff.Set(Catalog(Json::array({Retired()}),requestid));Error([&]{client.RetiredCatalog({},1);},"index_response_invalid");
      bff.Set(Catalog(Json::array({Retired()})));Error([&]{client.RetiredCatalog(shardid,1);},"index_response_invalid");
      const int invalid=bff.calls;
      Error([&]{client.Refresh(channel,Today(),-1);},"index_request_invalid");Error([&]{client.Refresh(channel,Today(),9007199254740992LL);},"index_request_invalid");
      Error([&]{client.Refresh(jobid,Today(),0);},"index_request_invalid");Error([&]{client.Refresh(channel,"2099-01-01",0);},"index_request_invalid");
      Error([&]{client.Retired("../outside");},"index_request_invalid");Error([&]{client.RetiredCatalog({},17);},"index_request_invalid");
      auto changed=*ref;changed.manifest_key="../outside";Error([&]{client.ConfirmCleanup(changed);},"index_request_invalid");
      auto changed_build=build;changed_build.shard.revision=4;changed_build.manifest_key=shardid+"/4.manifest.json";
      Error([&]{client.DiscardBuild(changed_build);},"index_request_invalid");
      Check(bff.calls==invalid,"invalid refresh/cleanup reached authority");
    }

    const int before_invalid = bff.calls;
    for (const auto& day : {"2026-02-30", "2026-13-01", "2026-10-28/../x", "2099-01-01", "1970-01-01"})
      Error([&] { client.Enqueue(requestid, channel, model, day); }, "index_request_invalid");
    Error([&] { client.Enqueue("../escape", channel, model, Today()); }, "index_request_invalid");
    Error([&] { client.Enqueue(requestid, jobid, model, Today()); }, "index_request_invalid");
    Error([&] { client.Enqueue(requestid, channel, "search-v1-" + digest, Today()); }, "index_request_invalid");
    Error([&] { client.Claim(workerid, "verify"); }, "index_request_invalid");
    Error([&] { client.Fail(*job, "private secret"); }, "index_request_invalid");
    auto wrong = *job; wrong.shard.storage_generation = digest; Error([&] { client.Renew(wrong); }, "index_request_invalid");
    wrong = *job; wrong.config_revision = digest; Error([&] { client.Begin(wrong); }, "index_request_invalid");
    auto bad_publication = publication; bad_publication.manifest_key = "../escape"; Error([&] { client.Publish(build, bad_publication); }, "index_request_invalid");
    bad_publication = publication; bad_publication.checkpoint = 9007199254740992LL; Error([&] { client.Publish(build, bad_publication); }, "index_request_invalid");
    auto bad_build = build; bad_build.shard.dimensions = 4097; Error([&] { client.Publish(bad_build, publication); }, "index_request_invalid");
    bad_build = build; --bad_build.shard.checkpoint; Error([&] { client.Publish(bad_build, publication); }, "index_request_invalid");
    bad_build = build; bad_build.shard.id = requestid; bad_build.manifest_key = requestid + "/3.manifest.json";
    bad_publication = publication; bad_publication.manifest_key = bad_build.manifest_key;
    Error([&] { client.Publish(bad_build, bad_publication); }, "index_request_invalid");
    bad_build = build; bad_build.proof.reset(); Error([&] { client.Publish(bad_build, publication); }, "index_request_invalid");
    wrong = *job; wrong.shard.id = requestid; Error([&] { client.Begin(wrong); }, "index_request_invalid");
    Check(bff.calls == before_invalid, "invalid request reached BFF");
    auto invalid_context = Context(); invalid_context.channels.push_back(channel); Error([&] { IndexJobClient invalid(transport, invalid_context); }, "index_request_invalid");
    invalid_context = Context(); invalid_context.storage_generation = "private"; Error([&] { IndexJobClient invalid(transport, invalid_context); }, "index_request_invalid");

    for (const auto* field : {"storage_generation", "config_revision", "model_version", "package_id", "channel_id", "shard_id", "day"}) {
      auto bad = ClaimJob(); bad["payload"][field] = field == std::string("day") ? "2026-02-30" : "private-invalid";
      bff.Set({{"job", bad}}); Error([&] { client.Claim(workerid); }, "index_response_invalid");
    }
    for (const auto& field : {std::pair{"storage_generation", digest}, {"config_revision", digest},
        {"model_version", "search-v1-" + digest}, {"package_id", std::string("siglip2-base-full-int8")}, {"channel_id", jobid}}) {
      auto changed = ClaimJob(); changed["payload"][field.first] = field.second;
      bff.Set({{"job", changed}}); Error([&] { client.Claim(workerid); }, "index_response_invalid");
    }
    for (const auto* field : {"generation", "attempts", "lease_owner", "state", "actor", "lease_until"}) {
      auto bad = ClaimJob(); bad[field] = "private-invalid"; bff.Set({{"job", bad}}); Error([&] { client.Claim(workerid); }, "index_response_invalid");
    }
    auto bad = ClaimJob(); bad["generation"] = 2.5; bff.Set({{"job", bad}}); Error([&] { client.Claim(workerid); }, "index_response_invalid");
    bad = ClaimJob(); bad["payload"]["unexpected_url"] = "http://private"; bff.Set({{"job", bad}}); Error([&] { client.Claim(workerid); }, "index_response_invalid");
    bad = ClaimJob(); bad["lease_until"] = Today() + "T23:59:59.999Z"; bff.Set({{"job", bad}}); Error([&] { client.Claim(workerid); }, "index_response_invalid");
    for (const auto* field : {"id", "jobId", "worker", "storageGeneration", "jobGeneration", "revision"}) {
      auto response = Build(); response["lease"][field] = "invalid"; bff.Set(response); Error([&] { client.Begin(*job); }, "index_response_invalid");
    }
    auto response = Build(); response["manifest_key"] = shardid + "/../secret"; bff.Set(response); Error([&] { client.Begin(*job); }, "index_response_invalid");
    response = Build(); response["lease"]["id"] = requestid; bff.Set(response); Error([&] { client.Begin(*job); }, "index_response_invalid");
    response = Build(); response["lease"]["storageGeneration"] = digest; bff.Set(response); Error([&] { client.Begin(*job); }, "index_response_invalid");
    response = Build(); response["lease"]["jobGeneration"] = 3; bff.Set(response); Error([&] { client.Begin(*job); }, "index_response_invalid");
    for (const auto& value : {Json("9007199254740992"), Json("01"), Json("1e3"), Json("-1"), Json(1.5), Json(true)}) {
      auto row = Published(); row["shard"]["published_revision"] = value; bff.Set(row); Error([&] { client.Published(shardid); }, "index_response_invalid");
    }
    for (const auto* field : {"id", "channel_id", "model_version", "day", "manifest_key", "manifest_sha256", "partial", "record_count", "byte_count"}) {
      auto row = Published(); row["shard"][field] = "private-invalid"; bff.Set(row); Error([&] { client.Published(shardid); }, "index_response_invalid");
    }
    auto old_scope = Published(); old_scope["shard"]["channel_id"] = jobid; bff.Set(old_scope); Error([&] { client.Published(shardid); }, "index_response_invalid");
    old_scope = Published(); old_scope["shard"]["model_version"] = "search-v1-" + digest; bff.Set(old_scope); Error([&] { client.Published(shardid); }, "index_response_invalid");
    bff.Set({{"renewed", "true"}}); Error([&] { client.Renew(*job); }, "index_response_invalid");
    bff.Set({{"published", true}, {"extra", "private"}}); Error([&] { client.Publish(build, publication); }, "index_response_invalid");
    bff.SetRaw("{bad-json private-token"); Error([&] { client.Claim(workerid); }, "index_response_invalid");
    bff.Set({{"job_id", jobid}, {"shard_id", shardid}, {"state", 7}}); Error([&] { client.Enqueue(requestid, channel, model, Today()); }, "index_response_invalid");
    response = Build(); response["manifest_key"] = 7; bff.Set(response); Error([&] { client.Begin(*job); }, "index_response_invalid");
    for (const auto& entry : {std::pair{400, "index_request_invalid"}, {401, "index_forbidden"}, {403, "index_forbidden"},
        {409, "index_job_stale"}, {429, "index_capacity"}, {500, "index_unavailable"}, {302, "index_unavailable"}}) {
      bff.Set({{"error", "private-token private-address"}}, entry.first); const auto calls = bff.calls.load();
      Error([&] { client.Publish(build, publication); }, entry.second); Check(bff.calls == calls + 1, "write retried automatically");
    }
    bff.SetRaw(std::string(1024 * 1024 + 1, 's')); Error([&] { client.Claim(workerid); }, "index_unavailable");
    std::cout << checks << " index job client checks passed\n";
  } catch (const std::exception& error) { std::cerr << "index job client test failed: " << error.what() << '\n'; return 1; }
}
