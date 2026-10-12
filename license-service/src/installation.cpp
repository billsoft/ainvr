#include "state_store.hpp"
#include "encoding.hpp"
#include "diagnostics.hpp"
#include <chrono>
#include <openssl/crypto.h>
#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace ainvr_license {
namespace {
bool Hex(const std::string& s,size_t n) {
  return s.size()==n && s.find_first_not_of("0123456789abcdef")==std::string::npos;
}
}
void StateStore::PersistIdentity(const std::string& path, const std::string& value) const {
  AtomicPrivateWrite(path, value);
}
void StateStore::WriteIdentity(const nlohmann::json& data) const {
  auto snapshot=std::make_shared<const nlohmann::json>(data);
  auto sig=HmacSha256Hex(dk_,"AINVR/installation/v3|"+data.dump());
  auto started=std::chrono::steady_clock::now();
  auto report=[&](bool ok){
    auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count();
    LicenseDiagnostic({{"event","identity_write"},{"duration_ms",ms},{"ok",ok},
                       {"grant_seq",data.at("grant_seq")},{"revoked",data.at("revoked")}});
  };
  try {PersistIdentity(identity_path_,nlohmann::json{{"data",data},{"sig",sig}}.dump());}
  catch(...) {report(false);throw;}
  identity_=data; // Publish only after durable confirmation.
  std::atomic_store(&published_identity_,std::move(snapshot));
  report(true);
}
void StateStore::EnableV3(std::string path, VerifyKeys keys, std::string migration) {
  if(!std::filesystem::path(path).is_absolute()) throw std::runtime_error("V3_PROVISION_REQUIRED");
  // An unconfigured issuer must not prevent device registration and management.
  // Empty trust accepts no grant: OpenSignedGrant rejects every unknown signer.
  for(const auto& p:paths_) if(std::filesystem::path(p).lexically_normal()==std::filesystem::path(path).lexically_normal())
    throw std::runtime_error("IDENTITY_STATE_PATH_COLLISION");
  if(V3())throw std::runtime_error("V3_ALREADY_INITIALIZED");
  // Read with the device HMAC before enabling installation checks. This is
  // deliberately read-only: a missing/bad ticket must leave a v2 board retryable.
  auto previous=Load();
  if(previous.record && previous.record->schema==2) {
    if(migration.empty())throw std::runtime_error("SIGNED_MIGRATION_REQUIRED");
    auto grant=OpenSignedGrant(keys,migration);
    const auto& r=*previous.record;
    if(grant.purpose!="migrate" || grant.license.fp!=fp_ ||
       grant.legacy_token_hash!=r.token_hash || grant.activation_wall!=r.activation_wall ||
       grant.license.license_id!=r.license_id || grant.license.grant_seq!=r.grant_seq ||
       grant.license.ttl_min*60!=r.total_seconds)
      throw std::runtime_error("MIGRATION_STATE_MISMATCH");
  }
  identity_path_=std::move(path);verify_keys_=std::move(keys);migration_token_=std::move(migration);
  std::lock_guard lk(identity_mu_);
  bool invalid=false;
  if(std::filesystem::exists(identity_path_)) {
    // An I/O failure is not evidence of tampering. Leave the identity untouched
    // so a transient storage problem cannot change an installation binding.
    auto size=std::filesystem::file_size(identity_path_);
    std::string contents;
    if(size<=16384) {
      std::ifstream f(identity_path_,std::ios::binary);
      if(!f)throw std::runtime_error("identity unreadable");
      contents.assign(std::istreambuf_iterator<char>(f),{});
      if(f.bad())throw std::runtime_error("identity read failed");
    }
    try {
      if(size>16384) throw std::runtime_error("identity size");
      auto envelope=nlohmann::json::parse(contents);auto d=envelope.at("data");
      auto sig=envelope.at("sig").get<std::string>();
      auto expected=HmacSha256Hex(dk_,"AINVR/installation/v3|"+d.dump());
      if(sig.size()!=expected.size() || CRYPTO_memcmp(sig.data(),expected.data(),sig.size())!=0 ||
         d.at("v")!=3 || d.at("machine_code")!=fp_ || !Hex(d.at("installation_id").get<std::string>(),32) ||
         !d.at("grant_seq").is_number_integer() || d.at("grant_seq").get<int64_t>()<0 ||
         d.at("grant_seq").get<int64_t>()>kMaxSequence || !d.at("revoked").is_boolean() ||
         !(d.at("challenge")=="" || Hex(d.at("challenge").get<std::string>(),32)) ||
         !(d.at("license_id")=="" || Hex(d.at("license_id").get<std::string>(),32)))
        throw std::runtime_error("identity authentication");
      auto snapshot=std::make_shared<const nlohmann::json>(d);
      identity_=std::move(d);std::atomic_store(&published_identity_,std::move(snapshot));return;
    } catch(const std::bad_alloc&) {
      throw; // Resource exhaustion is not evidence of damaged identity data.
    } catch(const std::exception&) {
      // Wrong credentials and damaged state cannot be distinguished here.
      // Without an authenticated primary, preserve ALL evidence and fail closed.
      if(!previous.record || previous.storage_error || previous.tampered)
        throw std::runtime_error("IDENTITY_AUTH_FAILED_STATE_UNVERIFIED: check provisioned device key and storage; files preserved");
      // Preserve forensic evidence. Never reinterpret a damaged installation as fresh.
      std::filesystem::rename(identity_path_,identity_path_+".invalid."+HexEncode(RandomBytes(8)));
      invalid=true;
    }
  }
  if(!invalid && previous.any_file_present && !previous.record)
    throw std::runtime_error("STATE_UNVERIFIED_WITHOUT_IDENTITY: files preserved; check device key and storage");
  std::string id=HexEncode(RandomBytes(16));
  if(!invalid && !migration_token_.empty()) {
    auto grant=OpenSignedGrant(verify_keys_,migration_token_);
    if(grant.purpose!="migrate" || grant.license.fp!=fp_)throw std::runtime_error("INVALID_MIGRATION_TICKET");
    id=grant.installation_id;
  }
  WriteIdentity({{"v",3},{"machine_code",fp_},{"installation_id",id},{"grant_seq",0},
                 {"license_id",""},{"revoked",false},{"challenge",invalid?HexEncode(RandomBytes(16)):""}});
}
SignedGrant StateStore::VerifyGrant(const std::string& token) const {
  return OpenSignedGrant(verify_keys_,token);
}
std::string StateStore::InstallationId() const {
  return std::atomic_load(&published_identity_)->at("installation_id");
}
int64_t StateStore::GrantFloor() const {
  return std::atomic_load(&published_identity_)->at("grant_seq");
}
void StateStore::RequireRecovery() const {
  if(!V3())return;
  std::lock_guard lk(identity_mu_);
  if(identity_.at("challenge")!="")return;
  auto next=identity_;next["challenge"]=HexEncode(RandomBytes(16));WriteIdentity(next);
}
nlohmann::json StateStore::RegistrationRequest() const {
  if(!V3())return nlohmann::json::object();
  auto snapshot=std::atomic_load(&published_identity_);
  if(!snapshot)throw std::runtime_error("INSTALLATION_NOT_INITIALIZED");
  const auto& identity_=*snapshot;
  nlohmann::json request={{"v",3},{"product","AINVR"},{"machine_code",fp_},
    {"installation_id",identity_.at("installation_id")},{"grant_floor",identity_.at("grant_seq")},
    {"purpose",identity_.at("challenge")==""?"activate":"recover"},{"challenge",identity_.at("challenge")}};
  auto text=request.dump();std::vector<unsigned char> bytes(text.begin(),text.end());
  return {{"installation_id",identity_.at("installation_id")},{"request_kind",request.at("purpose")},
          {"activation_request","AINVR-REQ3-"+B64UrlEncode(bytes)}};
}
void StateStore::AnchorGrant(const LicenseRecord& r) const {
  if(!V3())return;
  std::lock_guard lk(identity_mu_);
  if(r.installation_id!=identity_.at("installation_id"))throw std::runtime_error("INSTALLATION_MISMATCH");
  auto floor=identity_.at("grant_seq").get<int64_t>();
  if(r.grant_seq<floor || (r.grant_seq==floor && identity_.at("license_id")!=r.license_id) ||
     (r.grant_seq==floor && identity_.at("revoked")==true && !r.revoked))
    throw std::runtime_error("STATE_GRANT_ROLLBACK");
  if(r.grant_seq!=floor || identity_.at("revoked")!=r.revoked || identity_.at("challenge")!="") {
    auto next=identity_;next["grant_seq"]=r.grant_seq;next["license_id"]=r.license_id;
    next["revoked"]=r.revoked;next["challenge"]="";
    // Identity commits first. A crash between files requires recovery, never extra time.
    WriteIdentity(next);
  }
}
}
