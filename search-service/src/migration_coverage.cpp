#include "migration_coverage.hpp"
#include "migration_sample.hpp"
#include "model_migration_authorization.hpp"
#include <ctime>
#include <cstdio>
#include <iomanip>
#include <sstream>
namespace ainvr::search {
namespace {
using Json=nlohmann::json;
std::string Stamp(int64_t millis,bool day=false){
  if(millis<0)throw std::invalid_argument("invalid_migration_coverage");
  const std::time_t seconds=millis/1000;std::tm utc{};char text[32]{};
  if(!gmtime_r(&seconds,&utc)||utc.tm_year<70||utc.tm_year>8099||
      strftime(text,sizeof(text),day?"%Y-%m-%d":"%Y-%m-%dT%H:%M:%S",&utc)!=(day?10:19))
    throw std::invalid_argument("invalid_migration_coverage");
  if(day)return text;
  char suffix[6]{};std::snprintf(suffix,sizeof(suffix),".%03dZ",int(millis%1000));return std::string(text)+suffix;
}
Json Pin(const RuntimeModelPin& pin){return{{"package_id",pin.package_id},{"package_sha256",pin.package_sha256},{"model_version",pin.model_version}};}
Json Range(const Scope& scope){return{{"channel_ids",std::vector<std::string>(scope.channels.begin(),scope.channels.end())},
  {"from",Stamp(scope.from_ms)},{"to",Stamp(scope.to_ms)}};}
void Invalid(){throw std::invalid_argument("invalid_migration_coverage");}
int64_t DayMillis(const std::string& day){
  std::tm date{};std::istringstream input(day);input>>std::get_time(&date,"%Y-%m-%d");
  if(input.fail())Invalid();
  const auto seconds=timegm(&date);
  if(seconds<0||Stamp(int64_t(seconds)*1000,true)!=day)Invalid();
  return int64_t(seconds)*1000;
}
uint64_t Count(const Json& value){return uint64_t(migration_authorization::Number(value));}
Json Anchor(const HistoryMetadataRow& row){return Json::array({row.sample.record.id,row.sample.fingerprint,row.ordinal,
  row.jpeg_sha256,row.sample.record.model,row.dimensions,row.vector_format});}
}
MigrationCoveragePass::MigrationCoveragePass(MigrationCoverageDefinition definition):definition_(std::move(definition)){
  const auto& d=definition_;
  migration_authorization::Hash(d.payload_fingerprint);
  if(!ValidRuntimeModelPin(d.source)||!ValidRuntimeModelPin(d.target)||d.source.model_version==d.target.model_version||
      d.scope.channels.empty()||d.scope.channels.size()>100||d.scope.from_ms<0||d.scope.to_ms<=d.scope.from_ms||
      d.scope.to_ms-d.scope.from_ms>31LL*86400000||d.source_high_watermark<0||d.minimum_target_checkpoint<0||
      d.expires_ms<1||d.max_records<1||d.max_records>1000000)Invalid();
  for(const auto& channel:d.scope.channels)migration_authorization::Uuid(channel);
  const auto& spec=FindPackageSpec(d.target.package_id);if(spec.pruned)Invalid();
  target_checkpoint_=d.minimum_target_checkpoint;
  digest_=Identity();
}
std::string MigrationCoveragePass::Identity()const{
  return SampleSha256(Json::array({"ainvr-search-coverage-definition-v1",definition_.payload_fingerprint,
    Pin(definition_.source),Pin(definition_.target),Range(definition_.scope),std::to_string(definition_.source_high_watermark)}).dump());
}
void MigrationCoveragePass::Observe(const MigrationCoverageBatch& batch,int64_t now){
  if(complete_||now<0||now>=definition_.expires_ms||batch.rows.size()>32||batch.checkpoint<checkpoint_||
      batch.checkpoint>definition_.source_high_watermark||(!batch.exhausted&&batch.checkpoint==checkpoint_))Invalid();
  auto digest=digest_;auto required=required_,matched=matched_,unavailable=unavailable_;
  auto target_checkpoint=target_checkpoint_;int64_t previous=checkpoint_;
  std::map<std::string,Partition> changed;
  const auto& spec=FindPackageSpec(definition_.target.package_id);
  for(const auto& observation:batch.rows){
    const auto& source=observation.source;const auto& record=source.sample.record;
    if(source.ordinal<=previous||source.ordinal>batch.checkpoint||!definition_.scope.channels.count(record.channel)||
        record.model!=definition_.source.model_version||record.captured_ms<definition_.scope.from_ms||
        record.captured_ms>=definition_.scope.to_ms||!source.sample.jpeg.empty()||!record.vector.empty())Invalid();
    migration_authorization::Uuid(record.id);migration_authorization::Hash(source.sample.fingerprint);
    migration_authorization::Hash(source.jpeg_sha256);previous=source.ordinal;
    if(!observation.source_current||source.sample.expires_ms<=now)continue;
    if(++required>definition_.max_records)throw std::runtime_error("migration_report_capacity");
    bool hit=false;
    if(observation.target){const auto& target=*observation.target;
      if(!target.sample.jpeg.empty()||!target.sample.record.vector.empty()||target.ordinal<1)Invalid();
      hit=target.vector_format=="f32le"&&ReencodedMetadataMatches(source.sample,target.sample,definition_.source,definition_.target,
        spec,source.jpeg_sha256,target.jpeg_sha256,target.dimensions);
    }
    digest=SampleSha256(Json::array({"ainvr-search-coverage-row-v1",digest,Anchor(source),record.channel,record.captured_ms,
      source.sample.expires_ms,observation.target?Anchor(*observation.target):Json(nullptr),hit}).dump());
    if(hit){++matched;const auto& target=*observation.target;target_checkpoint=std::max(target_checkpoint,target.ordinal);
      const auto key=record.channel+"/"+Stamp(record.captured_ms,true);
      auto part=changed.find(key);
      if(part==changed.end()){const auto old=partitions_.find(key);part=changed.emplace(key,old==partitions_.end()?Partition{}:old->second).first;}
      ++part->second.records;part->second.checkpoint=std::max(part->second.checkpoint,target.ordinal);
    }else ++unavailable;
  }
  size_t extra=0;for(const auto& part:changed)if(!partitions_.count(part.first))++extra;
  if(partitions_.size()+extra>3200)throw std::runtime_error("migration_report_capacity");
  for(const auto& part:changed)partitions_[part.first]=part.second;
  digest_=std::move(digest);required_=required;matched_=matched;unavailable_=unavailable;target_checkpoint_=target_checkpoint;
  checkpoint_=batch.exhausted?definition_.source_high_watermark:batch.checkpoint;complete_=batch.exhausted;
}
Json MigrationCoveragePass::Header()const{
  return{{"schema_version","search-reencode-artifacts-v1"},{"payload_fingerprint",definition_.payload_fingerprint},
    {"source",Pin(definition_.source)},{"target",Pin(definition_.target)},{"scope",Range(definition_.scope)},
    {"source_completed_through",std::to_string(definition_.source_high_watermark)},
    {"target_checkpoint",std::to_string(target_checkpoint_)},{"scanned",required_},{"encoded",matched_},
    {"unavailable",unavailable_},{"coverage_sha256",digest_}};
}
Json MigrationCoveragePass::State()const{
  auto parts=Json::array();for(const auto& part:partitions_)parts.push_back({{"key",part.first},
    {"checkpoint",std::to_string(part.second.checkpoint)},{"records",part.second.records}});
  Json state{{"schema_version","search-migration-coverage-state-v1"},{"definition_sha256",Identity()},
    {"checkpoint",std::to_string(checkpoint_)},{"target_checkpoint",std::to_string(target_checkpoint_)},
    {"required",required_},{"matched",matched_},{"unavailable",unavailable_},{"coverage_sha256",digest_},
    {"complete",complete_},{"partitions",parts}};
  if(state.dump().size()>512*1024)throw std::runtime_error("migration_report_capacity");
  return{{"state",state},{"state_sha256",SampleSha256(state.dump())}};
}
MigrationCoveragePass MigrationCoveragePass::Restore(MigrationCoverageDefinition definition,const Json& envelope){
  using namespace migration_authorization;
  Keys(envelope,{"state","state_sha256"});const auto& state=envelope.at("state");
  if(Hash(envelope.at("state_sha256"))!=SampleSha256(state.dump())||state.dump().size()>512*1024)Invalid();
  Keys(state,{"schema_version","definition_sha256","checkpoint","target_checkpoint","required","matched","unavailable","coverage_sha256","complete","partitions"});
  MigrationCoveragePass pass(std::move(definition));
  if(state.at("schema_version")!="search-migration-coverage-state-v1"||state.at("definition_sha256")!=pass.Identity())Invalid();
  pass.checkpoint_=Ordinal(state.at("checkpoint"));pass.target_checkpoint_=Ordinal(state.at("target_checkpoint"));
  pass.required_=Count(state.at("required"));pass.matched_=Count(state.at("matched"));pass.unavailable_=Count(state.at("unavailable"));
  pass.digest_=Hash(state.at("coverage_sha256"));pass.complete_=state.at("complete").get<bool>();
  if(pass.checkpoint_>pass.definition_.source_high_watermark||pass.required_>pass.definition_.max_records||
      pass.matched_>pass.required_||pass.unavailable_!=pass.required_-pass.matched_||
      pass.target_checkpoint_<pass.definition_.minimum_target_checkpoint||
      (pass.complete_&&pass.checkpoint_!=pass.definition_.source_high_watermark))Invalid();
  const auto& parts=state.at("partitions");if(!parts.is_array()||parts.size()>3200)Invalid();
  uint64_t total=0;
  for(const auto& part:parts){Keys(part,{"key","checkpoint","records"});const auto key=Text(part.at("key"),47);
    const auto count=Count(part.at("records"));const auto checkpoint=Ordinal(part.at("checkpoint"));
    if(key.size()!=47||key[36]!='/'||!pass.definition_.scope.channels.count(key.substr(0,36))||
        count<1||count>pass.matched_-total||checkpoint<1||checkpoint>pass.target_checkpoint_)Invalid();
    const auto day=DayMillis(key.substr(37));
    if(day>=pass.definition_.scope.to_ms||day+86400000<=pass.definition_.scope.from_ms||
        !pass.partitions_.emplace(key,Partition{checkpoint,count}).second)Invalid();
    total+=count;
  }
  if(total!=pass.matched_)Invalid();
  return pass;
}
Json MigrationCoveragePass::Page(const std::optional<std::string>& after)const{
  if(!complete_)throw std::runtime_error("migration_report_pending");
  if(after&&!partitions_.count(*after))throw std::invalid_argument("invalid_migration_report_cursor");
  auto result=Header();auto parts=Json::array();auto next=after?partitions_.upper_bound(*after):partitions_.begin();
  std::optional<std::string> last;
  for(size_t n=0;n<32&&next!=partitions_.end();++n,++next){last=next->first;parts.push_back({{"channel_id",next->first.substr(0,36)},
    {"day",next->first.substr(37)},{"checkpoint",std::to_string(next->second.checkpoint)},{"records",next->second.records}});}
  result["partitions"]=std::move(parts);result["next_cursor"]=next!=partitions_.end()?Json(*last):Json(nullptr);
  if(result.dump().size()>32768)throw std::runtime_error("migration_report_capacity");
  return result;
}
}  // namespace ainvr::search
