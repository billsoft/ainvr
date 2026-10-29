// Strict metadata boundary for the existing PG migration lease authority.
// A grant is not a transaction spanning PG and Mongo and never authorizes
// checkpoint/publication/activation after a lease has been revoked.
#pragma once
#include "model_pin.hpp"
#include "vector_index.hpp"
#include <nlohmann/json.hpp>
#include <charconv>
#include <limits>
#include <optional>
namespace ainvr::search {
struct MigrationWriteProof {
  std::string job_id,worker,actor,payload_fingerprint;
  int64_t generation=0;
};
struct MigrationSourceProof {
  std::string sample_id,fingerprint,channel_id,jpeg_sha256;
  int64_t captured_ms=0,ordinal=0;
};
struct MigrationWriteGrant {
  RuntimeModelPin source,target;
  Scope scope;
  int64_t source_high_watermark=0,lease_until_ms=0,job_expires_ms=0,target_checkpoint=0;
};

struct MigrationReportReadProof {
  std::string job_id,actor,payload_fingerprint;
  int64_t generation=0;
};
// Distinct type: read-only grants can never be passed to an artifact writer.
struct MigrationReportReadGrant {
  RuntimeModelPin source,target;
  Scope scope;
  int64_t source_high_watermark=0,job_expires_ms=0,target_checkpoint=0;
};
namespace migration_authorization {
using Json=nlohmann::json;
inline void Keys(const Json& value,std::initializer_list<const char*> keys) {
  if(!value.is_object()||value.size()!=keys.size())throw std::invalid_argument("invalid_migration_authorization");
  for(const auto* key:keys)if(!value.contains(key))throw std::invalid_argument("invalid_migration_authorization");
}
inline std::string Text(const Json& value,size_t maximum) {
  if(!value.is_string())throw std::invalid_argument("invalid_migration_authorization");
  const auto text=value.get<std::string>();
  if(text.empty()||text.size()>maximum||std::any_of(text.begin(),text.end(),[](unsigned char c){return c<32||c==127;}))
    throw std::invalid_argument("invalid_migration_authorization");
  return text;
}
inline std::string Hash(const Json& value) {
  auto text=Text(value,64);if(!std::regex_match(text,std::regex("[a-f0-9]{64}")))
    throw std::invalid_argument("invalid_migration_authorization");
  return text;
}
inline std::string Uuid(const Json& value) {
  auto text=Text(value,36);
  if(!std::regex_match(text,std::regex("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}")))
    throw std::invalid_argument("invalid_migration_authorization");
  return text;
}
inline int64_t Number(const Json& value,int64_t minimum=0) {
  if(!value.is_number_integer()||value<minimum||value>9007199254740991LL)
    throw std::invalid_argument("invalid_migration_authorization");
  return value.get<int64_t>();
}
inline int64_t Ordinal(const Json& value) {
  const auto text=Text(value,19);int64_t number=0;
  if(text.size()>1&&text.front()=='0')throw std::invalid_argument("invalid_migration_authorization");
  for(const char c:text)if(c<'0'||c>'9')throw std::invalid_argument("invalid_migration_authorization");
  const auto parsed=std::from_chars(text.data(),text.data()+text.size(),number);
  if(parsed.ec!=std::errc()||parsed.ptr!=text.data()+text.size()||number<0)
    throw std::invalid_argument("invalid_migration_authorization");
  return number;
}
inline RuntimeModelPin Pin(const Json& value) {
  Keys(value,{"package_id","package_sha256","model_version"});
  RuntimeModelPin pin{Text(value.at("package_id"),128),Hash(value.at("package_sha256")),Text(value.at("model_version"),74)};
  if(!ValidRuntimeModelPin(pin))throw std::invalid_argument("invalid_migration_authorization");
  return pin;
}
}  // namespace migration_authorization
inline MigrationWriteProof ReadMigrationWriteProof(const nlohmann::json& body) {
  using namespace migration_authorization;
  return {Uuid(body.at("job_id")),Uuid(body.at("worker")),Text(body.at("actor"),256),
    Hash(body.at("payload_fingerprint")),Number(body.at("generation"),1)};
}
inline nlohmann::json MigrationAuthorizationRequest(const MigrationWriteProof& proof,
    const std::optional<MigrationSourceProof>& source=std::nullopt) {
  nlohmann::json out{{"action","authorize_write"},{"job_id",proof.job_id},{"worker",proof.worker},
    {"actor",proof.actor},{"generation",proof.generation},{"payload_fingerprint",proof.payload_fingerprint}};
  if(source) {
    using namespace migration_authorization;
    if(source->ordinal<1)throw std::invalid_argument("invalid_migration_authorization");
    out["source"]={{"sample_id",Uuid(source->sample_id)},{"fingerprint",Hash(source->fingerprint)},
      {"channel_id",Uuid(source->channel_id)},{"captured_ms",Number(source->captured_ms)},
      {"ordinal",std::to_string(source->ordinal)},{"jpeg_sha256",Hash(source->jpeg_sha256)}};
  }
  // Constructed proofs must have the same validation as incoming ones.
  ReadMigrationWriteProof(out);return out;
}
inline std::optional<MigrationWriteGrant> ReadMigrationWriteGrant(const nlohmann::json& reply,
    const MigrationWriteProof& proof,int64_t now_ms) {
  using namespace migration_authorization;
  Keys(reply,{"grant"});const auto& value=reply.at("grant");if(value.is_null())return std::nullopt;
  Keys(value,{"job_id","worker","generation","payload_fingerprint","source","target","scope","source_high_watermark","lease_until_ms","job_expires_ms","target_checkpoint"});
  if(Uuid(value.at("job_id"))!=proof.job_id||Uuid(value.at("worker"))!=proof.worker||
      Number(value.at("generation"),1)!=proof.generation||Hash(value.at("payload_fingerprint"))!=proof.payload_fingerprint)
    throw std::runtime_error("migration_authorization_mismatch");
  MigrationWriteGrant grant;grant.target=Pin(value.at("target"));grant.source=Pin(value.at("source"));
  if(grant.source.model_version==grant.target.model_version)
    throw std::runtime_error("migration_authorization_mismatch");
  const auto& scope=value.at("scope");Keys(scope,{"channel_ids","from_ms","to_ms"});
  const auto& channels=scope.at("channel_ids");if(!channels.is_array()||channels.empty()||channels.size()>100)
    throw std::invalid_argument("invalid_migration_authorization");
  for(const auto& channel:channels)if(!grant.scope.channels.insert(Uuid(channel)).second)
    throw std::invalid_argument("invalid_migration_authorization");
  grant.scope.from_ms=Number(scope.at("from_ms"));grant.scope.to_ms=Number(scope.at("to_ms"));
  if(grant.scope.to_ms<=grant.scope.from_ms||grant.scope.to_ms-grant.scope.from_ms>31LL*86400000)
    throw std::invalid_argument("invalid_migration_authorization");
  grant.source_high_watermark=Ordinal(value.at("source_high_watermark"));grant.lease_until_ms=Number(value.at("lease_until_ms"));
  grant.job_expires_ms=Number(value.at("job_expires_ms"));grant.target_checkpoint=Ordinal(value.at("target_checkpoint"));
  if(now_ms<0||grant.lease_until_ms-now_ms<1000||grant.job_expires_ms<grant.lease_until_ms)return std::nullopt;
  return grant;
}
inline MigrationReportReadProof ReadMigrationReportReadProof(const nlohmann::json& body) {
  using namespace migration_authorization;
  return {Uuid(body.at("job_id")),Text(body.at("actor"),256),Hash(body.at("payload_fingerprint")),Number(body.at("generation"),1)};
}
inline nlohmann::json MigrationReportReadRequest(const MigrationReportReadProof& proof) {
  nlohmann::json out{{"action","authorize_report_read"},{"job_id",proof.job_id},{"actor",proof.actor},
    {"generation",proof.generation},{"payload_fingerprint",proof.payload_fingerprint}};
  ReadMigrationReportReadProof(out);return out;
}
inline std::optional<MigrationReportReadGrant> ReadMigrationReportReadGrant(const nlohmann::json& reply,
    const MigrationReportReadProof& proof,int64_t now_ms) {
  using namespace migration_authorization;
  Keys(reply,{"grant"});const auto& value=reply.at("grant");if(value.is_null())return std::nullopt;
  Keys(value,{"mode","job_id","generation","actor","payload_fingerprint","source","target","scope","source_high_watermark","job_expires_ms","target_checkpoint"});
  if(value.at("mode")!="report_read"||Uuid(value.at("job_id"))!=proof.job_id||Text(value.at("actor"),256)!=proof.actor||
      Number(value.at("generation"),1)!=proof.generation||Hash(value.at("payload_fingerprint"))!=proof.payload_fingerprint)
    throw std::runtime_error("migration_authorization_mismatch");
  MigrationReportReadGrant grant;grant.target=Pin(value.at("target"));grant.source=Pin(value.at("source"));
  if(grant.source.model_version==grant.target.model_version)throw std::runtime_error("migration_authorization_mismatch");
  const auto& scope=value.at("scope");Keys(scope,{"channel_ids","from_ms","to_ms"});
  const auto& channels=scope.at("channel_ids");if(!channels.is_array()||channels.empty()||channels.size()>100)
    throw std::invalid_argument("invalid_migration_authorization");
  for(const auto& channel:channels)if(!grant.scope.channels.insert(Uuid(channel)).second)
    throw std::invalid_argument("invalid_migration_authorization");
  grant.scope.from_ms=Number(scope.at("from_ms"));grant.scope.to_ms=Number(scope.at("to_ms"));
  if(grant.scope.to_ms<=grant.scope.from_ms||grant.scope.to_ms-grant.scope.from_ms>31LL*86400000)
    throw std::invalid_argument("invalid_migration_authorization");
  grant.source_high_watermark=Ordinal(value.at("source_high_watermark"));grant.job_expires_ms=Number(value.at("job_expires_ms"));
  grant.target_checkpoint=Ordinal(value.at("target_checkpoint"));
  if(now_ms<0||grant.job_expires_ms<=now_ms)return std::nullopt;
  return grant;
}
inline bool SameMigrationWriteAuthority(const MigrationWriteGrant& first,const MigrationWriteGrant& last) {
  return MatchesRuntimeModelPin(first.target,last.target)&&MatchesRuntimeModelPin(first.source,last.source)&&
    first.source_high_watermark==last.source_high_watermark&&first.scope.channels==last.scope.channels&&
    first.scope.from_ms==last.scope.from_ms&&first.scope.to_ms==last.scope.to_ms;
}
}  // namespace ainvr::search
