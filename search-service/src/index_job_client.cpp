#include "index_job_client.hpp"
#include "sample_contract.hpp"
#include "../../shared/cpp/config_center_client.hpp"
#include <algorithm>
#include <ctime>
#include <initializer_list>
#include <regex>
#include <set>

namespace ainvr::search {
namespace index_job_detail {
// Validation snapshots only. PG still decides liveness/publication on every
// request; these do not introduce another lease, clock, queue or job identity.
struct JobProof { IndexJob identity; };
struct BuildProof { IndexBuildLease identity; };
}
namespace {
using Json = nlohmann::json;
constexpr uint64_t kSafe = 9007199254740991ULL, kMaxBytes = 1099511627776ULL;
constexpr const char* kPath = "/api/internal/search/index-jobs";
[[noreturn]] void Invalid(bool response) { throw IndexJobError(response ? "index_response_invalid" : "index_request_invalid"); }
bool Uuid(const std::string& value) {
  static const std::regex rule("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
  return std::regex_match(value, rule);
}
bool Hash(const std::string& value) { return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); }); }
bool Model(const std::string& value) { return value.rfind("search-v1-", 0) == 0 && Hash(value.substr(10)); }
bool Kind(const std::string& value) { return value == "index" || value == "rebuild"; }
bool JobState(const std::string& value){return value=="pending"||value=="running"||value=="succeeded"||value=="failed"||value=="cancelled";}
bool Package(const std::string& value) {
  static const std::regex rule("[a-z0-9][a-z0-9_.-]{0,127}"); return std::regex_match(value, rule);
}
void Shape(const Json& value, std::initializer_list<const char*> required,
    std::initializer_list<const char*> optional = {}) {
  if (!value.is_object()) Invalid(true);
  std::set<std::string> allowed;
  for (const auto* key : required) { if (!value.contains(key)) Invalid(true); allowed.insert(key); }
  for (const auto* key : optional) allowed.insert(key);
  for (const auto& field : value.items()) if (!allowed.count(field.key())) Invalid(true);
}
std::string Text(const Json& value, size_t limit = 256) {
  if (!value.is_string()) Invalid(true);
  auto text = value.get<std::string>();
  if (text.empty() || text.size() > limit || std::any_of(text.begin(), text.end(), [](unsigned char c) { return c < 32 || c == 127; })) Invalid(true);
  return text;
}
uint64_t Number(const Json& value, uint64_t minimum, uint64_t maximum, bool bigint = false) {
  uint64_t parsed = 0;
  if (value.is_number_unsigned()) parsed = value.get<uint64_t>();
  else if (value.is_number_integer()) {
    const auto signed_value = value.get<int64_t>(); if (signed_value < 0) Invalid(true); parsed = uint64_t(signed_value);
  } else if (bigint && value.is_string()) {
    const auto text = value.get<std::string>();
    if (text.empty() || text.size() > 16 || (text.size() > 1 && text.front() == '0')) Invalid(true);
    for (char c : text) { if (c < '0' || c > '9' || parsed > (maximum - uint64_t(c - '0')) / 10) Invalid(true); parsed = parsed * 10 + uint64_t(c - '0'); }
  } else Invalid(true);
  if (parsed < minimum || parsed > maximum) Invalid(true);
  return parsed;
}
int Decimal(const std::string& value, size_t begin, size_t count) {
  int result = 0;
  for (size_t i = begin; i < begin + count; ++i) { if (value[i] < '0' || value[i] > '9') return -1; result = result * 10 + value[i] - '0'; }
  return result;
}
std::optional<int64_t> Day(const std::string& value) {
  if (value.size() != 10 || value[4] != '-' || value[7] != '-') return std::nullopt;
  const int year = Decimal(value, 0, 4), month = Decimal(value, 5, 2), day = Decimal(value, 8, 2);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return std::nullopt;
  std::tm calendar{}; calendar.tm_year = year - 1900; calendar.tm_mon = month - 1; calendar.tm_mday = day;
  const auto seconds = timegm(&calendar);
  if (seconds < 0 || calendar.tm_year != year - 1900 || calendar.tm_mon != month - 1 || calendar.tm_mday != day) return std::nullopt;
  return int64_t(seconds) * 1000;
}
std::optional<int64_t> Timestamp(const std::string& value) {
  if ((value.size() != 20 && value.size() != 24) || value[10] != 'T' || value[13] != ':' || value[16] != ':' || value.back() != 'Z') return std::nullopt;
  const auto day = Day(value.substr(0, 10)); if (!day) return std::nullopt;
  const int hour = Decimal(value, 11, 2), minute = Decimal(value, 14, 2), second = Decimal(value, 17, 2);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return std::nullopt;
  int millis = 0;
  if (value.size() == 24) { if (value[19] != '.') return std::nullopt; millis = Decimal(value, 20, 3); if (millis < 0) return std::nullopt; }
  return *day + (hour * 3600 + minute * 60 + second) * 1000LL + millis;
}
bool AllowedDay(const std::string& value, const IndexJobContext& context) {
  const auto start = Day(value); if (!start) return false;
  if(context.migration_scope)return *start<context.migration_scope->to_ms&&*start+86400000>context.migration_scope->from_ms;
  const int64_t today = int64_t(std::time(nullptr)) / 86400 * 86400000;
  // Mongo retention is rolling, so the oldest partially retained UTC day is
  // today-Ndays, not today-(N-1). Expired rows remain filtered by Mongo scans.
  return *start <= today && *start >= today - int64_t(context.retention_days) * 86400000;
}
bool Source(const std::string& value, const IndexJobContext& context) {
  return Uuid(value) && std::find(context.channels.begin(), context.channels.end(), value) != context.channels.end();
}
bool ShardScope(const IndexShardIdentity& value, const IndexJobContext& context) {
  return Uuid(value.id) && Source(value.channel_id, context) && value.model_version == context.model_version &&
    value.storage_generation == context.storage_generation && AllowedDay(value.utc_day, context);
}
std::string ManifestKey(const IndexShardIdentity& value) { return value.id + "/" + std::to_string(value.revision) + ".manifest.json"; }
bool SameShard(const IndexShardIdentity& a, const IndexShardIdentity& b) {
  return a.id == b.id && a.revision == b.revision && a.channel_id == b.channel_id && a.model_version == b.model_version &&
    a.utc_day == b.utc_day && a.storage_generation == b.storage_generation;
}
bool JobValid(const IndexJob& job, const IndexJobContext& context) {
  const auto until = Timestamp(job.lease_until), expires = Timestamp(job.expires_at);
  return Uuid(job.id) && Uuid(job.worker) && job.generation > 0 && job.generation <= kSafe && Kind(job.kind) &&
    job.config_revision == context.revision && job.package_id == context.package_id && ShardScope(job.shard, context) &&
    job.minimum_checkpoint>=0&&uint64_t(job.minimum_checkpoint)<=kSafe&&until && expires && *until <= *expires;
}
Json LeaseBody(const IndexJob& job, const IndexJobContext& context, const char* action) {
  if (!JobValid(job, context)) Invalid(false);
  if (!job.proof) Invalid(false);
  const auto& original = job.proof->identity;
  if (job.id != original.id || job.worker != original.worker || job.generation != original.generation || job.kind != original.kind ||
      !SameShard(job.shard, original.shard) || job.config_revision != original.config_revision || job.package_id != original.package_id ||
      job.lease_until != original.lease_until || job.expires_at != original.expires_at || job.minimum_checkpoint != original.minimum_checkpoint) Invalid(false);
  return {{"revision", context.revision}, {"action", action}, {"job_id", job.id}, {"worker", job.worker}, {"generation", job.generation}};
}
Json Call(ainvr::config::ConfigTransport& transport, const Json& body) {
  try { return transport.RequestAt(kPath, &body); }
  catch (const ainvr::config::ConfigHttpError& error) {
    switch (error.HttpStatus()) {
      case 409: throw IndexJobError("index_job_stale");
      case 429: throw IndexJobError("index_capacity");
      case 401: case 403: throw IndexJobError("index_forbidden");
      case 400: throw IndexJobError("index_request_invalid");
      default: throw IndexJobError("index_unavailable");
    }
  } catch (const Json::exception&) { throw IndexJobError("index_response_invalid"); }
    catch (...) { throw IndexJobError("index_unavailable"); }
}
template<class F> auto Decode(F operation) -> decltype(operation()) {
  try { return operation(); } catch (const IndexJobError&) { throw; }
  catch (...) { throw IndexJobError("index_response_invalid"); }
}
bool BooleanReply(const Json& value, const char* field) {
  Shape(value, {field}); if (!value.at(field).is_boolean()) Invalid(true); return value.at(field).get<bool>();
}
PublishedIndexShard DecodePublishedShard(const Json& shard,const IndexJobContext& context,const std::string& expected_id = "") {
    Shape(shard, {"id", "channel_id", "model_version", "day", "published_revision", "manifest_key", "manifest_sha256", "checkpoint", "record_count", "byte_count", "partial"});
    PublishedIndexShard out;
    out.shard.id = Text(shard.at("id")); out.shard.channel_id = Text(shard.at("channel_id"));
    out.shard.model_version = Text(shard.at("model_version")); out.shard.utc_day = Text(shard.at("day"));
    out.shard.storage_generation = context.storage_generation;
    out.shard.revision = Number(shard.at("published_revision"), 1, kSafe, true);
    out.shard.checkpoint = int64_t(Number(shard.at("checkpoint"), 0, kSafe, true));
    // Assign only to an already constructed owner. GCC 11's exceptional cleanup
    // of aggregate temporaries can leak earlier strings when a later field fails.
    out.publication.manifest_key = Text(shard.at("manifest_key"));
    out.publication.manifest_sha256 = Text(shard.at("manifest_sha256"));
    out.publication.checkpoint = out.shard.checkpoint;
    out.publication.record_count = Number(shard.at("record_count"), 0, 1000000);
    out.publication.byte_count = Number(shard.at("byte_count"), 0, kMaxBytes, true);
    if ((!expected_id.empty() && out.shard.id != expected_id) || !ShardScope(out.shard, context) || out.publication.manifest_key != ManifestKey(out.shard) ||
        !Hash(out.publication.manifest_sha256) || !shard.at("partial").is_boolean()) Invalid(true);
    out.partial = shard.at("partial").get<bool>(); return out;
}
bool RetiredScope(const IndexRetiredRef& ref,const IndexJobContext& context){
  const auto& shard=ref.shard;const auto day=Day(shard.utc_day);
  return Uuid(shard.id)&&Source(shard.channel_id,context)&&shard.model_version==context.model_version&&
    shard.storage_generation==context.storage_generation&&shard.revision>0&&shard.revision<=kSafe&&day&&
    (!context.migration_scope||AllowedDay(shard.utc_day,context))&&
    *day<=int64_t(std::time(nullptr))/86400*86400000&&ref.manifest_key==ManifestKey(shard);
}
IndexRetiredRef DecodeRetired(const Json& row,const IndexJobContext& context,const std::string& expected_id=""){
  Shape(row,{"id","channel_id","model_version","day","revision","storage_generation","manifest_key"});
  IndexRetiredRef out;auto& shard=out.shard;
  shard.id=Text(row.at("id"),36);shard.channel_id=Text(row.at("channel_id"),36);shard.model_version=Text(row.at("model_version"),128);
  shard.utc_day=Text(row.at("day"),10);shard.revision=Number(row.at("revision"),1,kSafe);
  shard.storage_generation=Text(row.at("storage_generation"),64);out.manifest_key=Text(row.at("manifest_key"),256);
  if((!expected_id.empty()&&shard.id!=expected_id)||!RetiredScope(out,context))Invalid(true);
  return out;
}
}  // namespace

IndexJobClient::IndexJobClient(ainvr::config::ConfigTransport& transport, IndexJobContext context)
  : transport_(transport), context_(std::move(context)) {
  if (!Hash(context_.revision) || !Hash(context_.storage_generation) || !Package(context_.package_id) || !Model(context_.model_version) ||
      context_.channels.empty() || context_.channels.size() > 1024 || context_.retention_days < 1 || context_.retention_days > 365) Invalid(false);
  std::set<std::string> unique;
  for (const auto& channel : context_.channels) if (!Uuid(channel) || !unique.insert(channel).second) Invalid(false);
  if(bool(context_.migration_lease)!=bool(context_.migration_scope))Invalid(false);
  if(context_.migration_lease){
    try{(void)MigrationAuthorizationRequest(*context_.migration_lease);}catch(...){Invalid(false);}
    const auto& scope=*context_.migration_scope;
    if(scope.channels!=unique||scope.channels.size()>100||scope.from_ms<0||scope.to_ms<=scope.from_ms||
        scope.to_ms-scope.from_ms>31LL*86400000)Invalid(false);
  }
}
Json IndexJobClient::Request(Json body){
  if(context_.migration_lease){auto proof=MigrationAuthorizationRequest(*context_.migration_lease);proof.erase("action");
    body["migration_lease"]=std::move(proof);}
  return Call(transport_,body);
}
IndexJobEnqueued IndexJobClient::Enqueue(const std::string& request, const std::string& channel, const std::string& model,
    const std::string& day, const std::string& kind) {
  if (!Uuid(request) || !Source(channel, context_) || model != context_.model_version || !AllowedDay(day, context_) || !Kind(kind)) Invalid(false);
  const auto response = Request( {{"revision", context_.revision}, {"action", "enqueue"}, {"request_key", request},
    {"channel_id", channel}, {"model_version", model}, {"day", day}, {"kind", kind}});
  return Decode([&] {
    Shape(response, {"job_id", "shard_id", "state"});
    IndexJobEnqueued out;
    out.job_id = Text(response.at("job_id")); out.shard_id = Text(response.at("shard_id")); out.state = Text(response.at("state"));
    if (!Uuid(out.job_id) || !Uuid(out.shard_id) || !JobState(out.state)) Invalid(true);
    return out;
  });
}
std::optional<IndexJob> IndexJobClient::Claim(const std::string& worker, const std::string& kind) {
  if (!Uuid(worker) || !Kind(kind)) Invalid(false);
  const auto response = Request( {{"revision", context_.revision}, {"action", "claim"}, {"worker", worker}, {"kind", kind}});
  return Decode([&]() -> std::optional<IndexJob> {
    Shape(response, {"job"}); if (response.at("job").is_null()) return std::nullopt;
    const auto& job = response.at("job");
    Shape(job, {"id", "actor", "kind", "payload", "state", "generation", "attempts", "lease_owner", "lease_until", "expires_at"},
      {"request_key", "fingerprint", "result_ref", "error_code", "created_at", "minimum_checkpoint"});
    const auto& payload = job.at("payload");
    Shape(payload, {"shard_id", "channel_id", "model_version", "day", "storage_generation", "config_revision", "package_id"});
    if (job.at("actor") != "internal-search-index" || job.at("state") != "running" || job.at("kind") != kind || job.at("lease_owner") != worker) Invalid(true);
    (void)Number(job.at("attempts"), 1, 3);
    if (job.contains("request_key") && !Uuid(Text(job.at("request_key")))) Invalid(true);
    if (job.contains("fingerprint") && !Hash(Text(job.at("fingerprint")))) Invalid(true);
    if (job.contains("created_at") && !Timestamp(Text(job.at("created_at")))) Invalid(true);
    if (job.contains("result_ref") && !job.at("result_ref").is_null()) Invalid(true);
    if (job.contains("error_code") && !job.at("error_code").is_null()) Invalid(true);
    IndexJob out;
    out.id = Text(job.at("id")); out.worker = worker; out.generation = Number(job.at("generation"), 1, kSafe); out.kind = kind;
    out.config_revision = Text(payload.at("config_revision")); out.package_id = Text(payload.at("package_id"), 128);
    out.lease_until = Text(job.at("lease_until")); out.expires_at = Text(job.at("expires_at"));
    if(job.contains("minimum_checkpoint"))out.minimum_checkpoint=int64_t(Number(job.at("minimum_checkpoint"),0,kSafe));
    out.shard.id = Text(payload.at("shard_id")); out.shard.channel_id = Text(payload.at("channel_id"));
    out.shard.model_version = Text(payload.at("model_version")); out.shard.utc_day = Text(payload.at("day"));
    out.shard.storage_generation = Text(payload.at("storage_generation"));
    if (!JobValid(out, context_)) Invalid(true);
    out.proof = std::make_shared<const index_job_detail::JobProof>(index_job_detail::JobProof{out});
    return out;
  });
}
bool IndexJobClient::Renew(const IndexJob& job) { return BooleanReply(Request( LeaseBody(job, context_, "renew")), "renewed"); }
IndexBuildLease IndexJobClient::Begin(const IndexJob& job) {
  auto request = LeaseBody(job, context_, "begin"); request["shard_id"] = job.shard.id;
  const auto response = Request( request);
  return Decode([&] {
    Shape(response, {"lease", "manifest_key"}); const auto& lease = response.at("lease");
    Shape(lease, {"id", "revision", "jobId", "jobGeneration", "worker", "storageGeneration"});
    if (lease.at("id") != job.shard.id || lease.at("jobId") != job.id || lease.at("worker") != job.worker ||
        lease.at("storageGeneration") != context_.storage_generation || Number(lease.at("jobGeneration"), 1, kSafe) != job.generation) Invalid(true);
    IndexBuildLease out;
    out.shard = job.shard; out.job_id = job.id; out.worker = job.worker; out.job_generation = job.generation;
    out.manifest_key = Text(response.at("manifest_key"));
    out.shard.revision = Number(lease.at("revision"), 1, kSafe);
    if (out.manifest_key != ManifestKey(out.shard)) Invalid(true);
    out.proof = std::make_shared<const index_job_detail::BuildProof>(index_job_detail::BuildProof{out});
    return out;
  });
}
bool IndexJobClient::Publish(const IndexBuildLease& build, const ShardPublication& publication) {
  if (!build.proof) Invalid(false);
  const auto& original = build.proof->identity;
  if (!SameShard(build.shard, original.shard) || build.job_id != original.job_id || build.worker != original.worker ||
      build.job_generation != original.job_generation || build.manifest_key != original.manifest_key) Invalid(false);
  if (!Uuid(build.job_id) || !Uuid(build.worker) || !build.job_generation || build.job_generation > kSafe ||
      !ShardScope(build.shard, context_) || !build.shard.revision || build.shard.revision > kSafe || build.manifest_key != ManifestKey(build.shard) ||
      !build.shard.dimensions || build.shard.dimensions > 4096 || build.shard.checkpoint != publication.checkpoint ||
      publication.manifest_key != build.manifest_key || !Hash(publication.manifest_sha256) || publication.checkpoint < 0 ||
      uint64_t(publication.checkpoint) > kSafe || publication.record_count > 1000000 || publication.byte_count > kMaxBytes) Invalid(false);
  return BooleanReply(Request( {{"revision", context_.revision}, {"action", "publish"}, {"job_id", build.job_id},
    {"worker", build.worker}, {"generation", build.job_generation}, {"shard_id", build.shard.id}, {"build_revision", build.shard.revision},
    {"publication", {{"manifestSha256", publication.manifest_sha256}, {"checkpoint", publication.checkpoint},
      {"records", publication.record_count}, {"bytes", publication.byte_count}}}}), "published");
}
bool IndexJobClient::Fail(const IndexJob& job, const std::string& error) {
  if (error != "history_unavailable" && error != "storage_unavailable" && error != "index_capacity" && error != "artifact_invalid") Invalid(false);
  auto request = LeaseBody(job, context_, "fail"); request["error_code"] = error;
  return BooleanReply(Request( request), "finished");
}
std::optional<PublishedIndexShard> IndexJobClient::Published(const std::string& shard_id) {
  if (!Uuid(shard_id)) Invalid(false);
  const auto response = Request( {{"revision", context_.revision}, {"action", "published"}, {"shard_id", shard_id}});
  return Decode([&]() -> std::optional<PublishedIndexShard> {
    Shape(response, {"shard"}); const auto& shard = response.at("shard"); if (shard.is_null()) return std::nullopt;
    return DecodePublishedShard(shard,context_,shard_id);
  });
}
std::optional<IndexCatalogPage> IndexJobClient::Catalog(const std::optional<std::string>& cursor,size_t limit) {
  if((cursor&&!Uuid(*cursor))||limit<1||limit>16)Invalid(false);
  const auto response=Request({{"revision",context_.revision},{"action","catalog"},{"model_version",context_.model_version},
    {"cursor",cursor?Json(*cursor):Json(nullptr)},{"limit",limit}});
  return Decode([&]()->std::optional<IndexCatalogPage>{
    Shape(response,{"revision","storage_generation","items","next_cursor"});
    if(response.at("revision")!=context_.revision||response.at("storage_generation")!=context_.storage_generation)Invalid(true);
    const auto& rows=response.at("items");if(!rows.is_array()||rows.size()>limit)Invalid(true);
    IndexCatalogPage page;std::string previous=cursor.value_or("");std::set<std::pair<std::string,std::string>> unique_scope;
    for(const auto& row:rows){
      auto shard=DecodePublishedShard(row,context_);
      if(shard.shard.id<=previous||!unique_scope.emplace(shard.shard.channel_id,shard.shard.utc_day).second)Invalid(true);
      previous=shard.shard.id;page.shards.push_back(std::move(shard));
    }
    const auto& next=response.at("next_cursor");
    if(!next.is_null()){
      const auto value=Text(next,36);
      if(!Uuid(value)||rows.size()!=limit||page.shards.empty()||value!=previous)Invalid(true);
      page.next_cursor=value;
    }
    return page;
  });
}
std::optional<IndexRefreshAccepted> IndexJobClient::Refresh(const std::string& channel,const std::string& day,int64_t minimum){
  if(!Source(channel,context_)||!AllowedDay(day,context_)||minimum<0||uint64_t(minimum)>kSafe)Invalid(false);
  const auto key=SampleStorageUuid("ainvr-search-index-refresh-v1",Json::array({context_.revision,context_.storage_generation,context_.package_id,
    context_.model_version,channel,day,minimum}));
  const auto response=Request({{"action","refresh"},{"revision",context_.revision},{"request_key",key},{"channel_id",channel},
    {"model_version",context_.model_version},{"day",day},{"minimum_checkpoint",minimum}});
  return Decode([&]()->std::optional<IndexRefreshAccepted>{
    Shape(response,{"job_id","shard_id","state","accepted_checkpoint"});IndexRefreshAccepted out;
    out.job_id=Text(response.at("job_id"),36);out.shard_id=Text(response.at("shard_id"),36);out.state=Text(response.at("state"),16);
    out.accepted_checkpoint=int64_t(Number(response.at("accepted_checkpoint"),uint64_t(minimum),kSafe));
    if(!Uuid(out.job_id)||!Uuid(out.shard_id)||!JobState(out.state))Invalid(true);
    return out;
  });
}
std::optional<IndexRetiredRef> IndexJobClient::Retired(const std::string& id){
  if(!Uuid(id))Invalid(false);
  const auto response=Request({{"revision",context_.revision},{"action","retired"},{"shard_id",id}});
  return Decode([&]()->std::optional<IndexRetiredRef>{Shape(response,{"retired"});if(response.at("retired").is_null())return {};
    return DecodeRetired(response.at("retired"),context_,id);});
}
std::optional<IndexRetiredCatalogPage> IndexJobClient::RetiredCatalog(const std::optional<std::string>& cursor,size_t limit){
  if((cursor&&!Uuid(*cursor))||limit<1||limit>16)Invalid(false);
  const auto response=Request({{"revision",context_.revision},{"action","retired_catalog"},{"model_version",context_.model_version},
    {"cursor",cursor?Json(*cursor):Json(nullptr)},{"limit",limit}});
  return Decode([&]()->std::optional<IndexRetiredCatalogPage>{
    Shape(response,{"revision","storage_generation","items","next_cursor"});
    if(response.at("revision")!=context_.revision||response.at("storage_generation")!=context_.storage_generation)Invalid(true);
    const auto& rows=response.at("items");if(!rows.is_array()||rows.size()>limit)Invalid(true);
    IndexRetiredCatalogPage page;std::string previous=cursor.value_or("");std::set<std::pair<std::string,std::string>> scope;
    for(const auto& row:rows){auto ref=DecodeRetired(row,context_);if(ref.shard.id<=previous||!scope.emplace(ref.shard.channel_id,ref.shard.utc_day).second)Invalid(true);
      previous=ref.shard.id;page.shards.push_back(std::move(ref));}
    if(!response.at("next_cursor").is_null()){const auto next=Text(response.at("next_cursor"),36);
      if(!Uuid(next)||rows.size()!=limit||page.shards.empty()||next!=previous)Invalid(true);
      page.next_cursor=next;}
    return page;
  });
}
bool IndexJobClient::ConfirmCleanup(const IndexRetiredRef& ref){
  if(!RetiredScope(ref,context_))Invalid(false);
  return BooleanReply(Request({{"revision",context_.revision},{"action","cleanup_confirm"},{"shard_id",ref.shard.id},
    {"retired_revision",ref.shard.revision},{"retired_storage_generation",ref.shard.storage_generation}}),"confirmed");
}
bool IndexJobClient::DiscardBuild(const IndexBuildLease& build){
  if(!build.proof)Invalid(false);
  const auto& original=build.proof->identity;
  if(!SameShard(build.shard,original.shard)||build.job_id!=original.job_id||build.worker!=original.worker||build.job_generation!=original.job_generation||
    build.manifest_key!=original.manifest_key||!RetiredScope({build.shard,build.manifest_key},context_))Invalid(false);
  return BooleanReply(Request({{"revision",context_.revision},{"action","discard_build"},{"job_id",build.job_id},{"worker",build.worker},
    {"generation",build.job_generation},{"shard_id",build.shard.id},{"build_revision",build.shard.revision}}),"discarded");
}
}  // namespace ainvr::search
