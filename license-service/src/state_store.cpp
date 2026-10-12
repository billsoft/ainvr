#include "state_store.hpp"
#include "encoding.hpp"
#include "license_payload.hpp"
#include "diagnostics.hpp"
#include <chrono>
#include <openssl/crypto.h>
#include <fcntl.h>
#include <unistd.h>
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <cerrno>
namespace ainvr_license {
namespace fs=std::filesystem;
using nlohmann::json;
namespace {
struct StateReadError : std::runtime_error { using std::runtime_error::runtime_error; };
json Data(const LicenseRecord&r){json d={{"schema",r.schema},{"revoked",r.revoked},{"fp",r.fp},{"license_id",r.license_id},{"token_hash",r.token_hash},{"boot_id",r.boot_id},{"grant_seq",r.grant_seq},{"seq",r.seq},{"activation_wall",r.activation_wall},{"total_seconds",r.total_seconds},{"used_ns",r.used_ns},{"reserved_ns",r.reserved_ns},{"last_mono_ns",r.last_mono_ns},{"last_boot_ns",r.last_boot_ns}};if(r.schema==3){d["installation_id"]=r.installation_id;d["signed_grant"]=r.signed_grant;}return d;}
int64_t Num(const json&j,const char*k,int64_t hi){const auto&v=j.at(k);if(!v.is_number_integer()||(v.is_number_unsigned()&&v.get<uint64_t>()>static_cast<uint64_t>(hi)))throw std::runtime_error("state integer");auto n=v.get<int64_t>();if(n<0||n>hi)throw std::runtime_error("state range");return n;}
}
void AtomicPrivateWrite(const std::string&path,const std::string&value) {
  fs::path p(path);fs::create_directories(p.parent_path());
  auto tmp=path+".tmp."+HexEncode(RandomBytes(8));
  int fd=::open(tmp.c_str(),O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if(fd<0)throw std::runtime_error("state open failed");
  try {
    size_t offset=0;
    while(offset<value.size()){auto n=::write(fd,value.data()+offset,value.size()-offset);if(n<0&&errno==EINTR)continue;if(n<=0)throw std::runtime_error("state write failed");offset+=n;}
    if(::fsync(fd)!=0)throw std::runtime_error("state fsync failed");
    int old=fd;fd=-1;if(::close(old)!=0)throw std::runtime_error("state close failed");
    if(::rename(tmp.c_str(),path.c_str())!=0)throw std::runtime_error("state rename failed");
    int dir=::open(p.parent_path().c_str(),O_RDONLY|O_DIRECTORY|O_CLOEXEC);
    if(dir<0)throw std::runtime_error("state directory open failed");
    int result=::fsync(dir);::close(dir);if(result!=0)throw std::runtime_error("state directory fsync failed");
  }catch(...){if(fd>=0)::close(fd);::unlink(tmp.c_str());throw;}
}
StateStore::StateStore(std::vector<std::string> paths,Key32 key,std::string uid,std::string fp)
  : StateStore(std::move(paths),key,std::move(uid),std::move(fp),AtomicPrivateWrite) {}
StateStore::StateStore(std::vector<std::string> paths,Key32 key,std::string,std::string fp,RecoveryWriter writer)
  : paths_(std::move(paths)),dk_(Hkdf(key,"AINVR/state/v2",CrockfordNormalize(fp))),fp_(CrockfordNormalize(fp)),recovery_writer_(std::move(writer)) {
  if(paths_.empty() || !recovery_writer_)throw std::runtime_error("invalid state store");
  replica_worker_=std::thread([this]{ReplicaLoop();});
}
StateStore::~StateStore(){
  {std::lock_guard lk(replica_mu_);replica_stop_=true;}
  replica_cv_.notify_all();
  if(replica_worker_.joinable())replica_worker_.join();
}
void StateStore::FlushReplicas()const{
  std::unique_lock lk(replica_mu_);
  replica_cv_.wait(lk,[&]{return !pending_replica_&&!replica_busy_;});
}
void StateStore::ReplicaLoop(){
  std::unique_lock lk(replica_mu_);
  for(;;){
    replica_cv_.wait(lk,[&]{return replica_stop_||pending_replica_.has_value();});
    if(!pending_replica_)return;
    auto item=std::move(*pending_replica_);pending_replica_.reset();replica_busy_=true;
    lk.unlock();
    bool all_ok=true;
    for(size_t i=1;i<paths_.size();++i){
      auto started=std::chrono::steady_clock::now();bool ok=true;
      try{recovery_writer_(paths_[i],item.value);}catch(...){ok=false;all_ok=false;}
      auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count();
      replica_ms_.store(ms);
      LicenseDiagnostic({{"event","replica_write"},{"seq",item.seq},{"replica",i},{"duration_ms",ms},{"ok",ok}});
    }
    if(all_ok)replica_seq_.store(item.seq);
    lk.lock();replica_busy_=false;replica_cv_.notify_all();
  }
}
std::string StateStore::CanonicalData(const LicenseRecord&r)const{return Data(r).dump();}
LoadOutcome StateStore::Load()const {
  LoadOutcome out;
  try {
    bool primary=fs::exists(paths_.front());
    for(const auto&p:paths_)out.any_file_present=out.any_file_present||fs::exists(p);
    if(!out.any_file_present){
      if(V3() && (GrantFloor()>0 || RegistrationRequest().at("request_kind")=="recover"))
        throw std::runtime_error("STATE_ALL_MISSING");
      return out;
    }
    if(!primary)throw std::runtime_error("STATE_PRIMARY_MISSING");
    if(fs::file_size(paths_.front())>16384)throw std::runtime_error("STATE_TOO_LARGE");
    std::ifstream f(paths_.front(),std::ios::binary);
    if(!f)throw StateReadError("STATE_UNREADABLE");
    f.exceptions(std::ios::badbit);
    std::string content(std::istreambuf_iterator<char>(f),{});
    json envelope=json::parse(content);const auto&d=envelope.at("data");
    auto expected=HmacSha256Hex(dk_,d.dump());auto sig=envelope.at("sig").get<std::string>();
    if(sig.size()!=expected.size()||CRYPTO_memcmp(sig.data(),expected.data(),sig.size())!=0)throw std::runtime_error("STATE_AUTH_FAILED");
    auto schema=Num(d,"schema",3);if(schema!=2 && schema!=3)throw std::runtime_error("STATE_MIGRATION_REQUIRED");
    LicenseRecord r;r.fp=d.at("fp").get<std::string>();if(CrockfordNormalize(r.fp)!=fp_)throw std::runtime_error("STATE_DEVICE_MISMATCH");
    r.license_id=d.at("license_id").get<std::string>();r.token_hash=d.at("token_hash").get<std::string>();r.boot_id=d.at("boot_id").get<std::string>();
    if(r.license_id.size()!=32||r.token_hash.size()!=64||r.boot_id.empty()||r.boot_id.size()>128)throw std::runtime_error("STATE_FIELDS_INVALID");
    r.grant_seq=Num(d,"grant_seq",kMaxSequence);r.seq=Num(d,"seq",kMaxSequence);r.activation_wall=Num(d,"activation_wall",253402300799LL);
    r.total_seconds=Num(d,"total_seconds",kMaxMinutes*60);if(!r.total_seconds||!r.grant_seq)throw std::runtime_error("STATE_FIELDS_INVALID");
    r.used_ns=Num(d,"used_ns",r.total_seconds*1000000000LL);r.reserved_ns=Num(d,"reserved_ns",r.total_seconds*1000000000LL);
    if(r.used_ns>r.reserved_ns)throw std::runtime_error("STATE_BUDGET_INVALID");
    r.revoked=d.value("revoked",false);
    if(r.revoked&&(r.used_ns!=r.total_seconds*1000000000LL||r.reserved_ns!=r.used_ns))throw std::runtime_error("STATE_REVOCATION_INVALID");
    r.last_mono_ns=Num(d,"last_mono_ns",INT64_MAX);r.last_boot_ns=Num(d,"last_boot_ns",INT64_MAX);
    r.schema=static_cast<int>(schema);
    if(V3()) {
      if(RegistrationRequest().at("request_kind")=="recover")throw std::runtime_error("INSTALLATION_RECOVERY_PENDING");
      if(schema==2) {
        if(migration_token_.empty() || GrantFloor()!=0)throw std::runtime_error("SIGNED_MIGRATION_REQUIRED");
        auto g=VerifyGrant(migration_token_);
        if(g.purpose!="migrate" || g.legacy_token_hash!=r.token_hash || g.activation_wall!=r.activation_wall)
          throw std::runtime_error("MIGRATION_STATE_MISMATCH");
        r.schema=3;r.installation_id=InstallationId();r.signed_grant=migration_token_;
        out.migrated=true;
        r.token_hash=HexEncode(Sha256(migration_token_));
      } else {
        r.installation_id=d.at("installation_id");r.signed_grant=d.at("signed_grant");
      }
      auto g=VerifyGrant(r.signed_grant);
      if(g.license.fp!=fp_ || g.installation_id!=InstallationId() || r.installation_id!=g.installation_id ||
         g.license.license_id!=r.license_id || g.license.grant_seq!=r.grant_seq || g.license.ttl_min*60!=r.total_seconds ||
         HexEncode(Sha256(r.signed_grant))!=r.token_hash || r.grant_seq<GrantFloor() ||
         (g.purpose=="migrate" && r.activation_wall!=g.activation_wall))throw std::runtime_error("STATE_SIGNED_GRANT_MISMATCH");
      {std::lock_guard lk(identity_mu_);
        if(r.grant_seq==identity_.at("grant_seq") &&
           (identity_.at("license_id")!=r.license_id || (identity_.at("revoked")==true && !r.revoked)))
          throw std::runtime_error("STATE_GRANT_ROLLBACK");
      }
    }
    out.record=r;
  }catch(const fs::filesystem_error&){out.storage_error=true;out.reason="STATE_FILESYSTEM_ERROR";}
   catch(const std::ios_base::failure&){out.storage_error=true;out.reason="STATE_READ_FAILED";}
   catch(const StateReadError&e){out.storage_error=true;out.reason=e.what();}
   catch(const std::exception&e){out.tampered=true;out.reason=e.what();}
  return out;
}
void StateStore::Save(const LicenseRecord&r)const {
  AnchorGrant(r);
  auto data=Data(r);auto value=json{{"data",data},{"sig",HmacSha256Hex(dk_,data.dump())}}.dump();
  auto started=std::chrono::steady_clock::now();
  try{AtomicPrivateWrite(paths_.front(),value);}catch(...){
    auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count();
    primary_ms_.store(ms);
    LicenseDiagnostic({{"event","primary_write"},{"seq",r.seq},{"duration_ms",ms},{"ok",false}});throw;
  }
  auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count();
  primary_ms_.store(ms);primary_seq_.store(r.seq);
  // The primary is the sole commit point. A single independent worker writes
  // recovery copies in order; only the newest waiting snapshot is retained.
  if(paths_.size()>1){
    std::lock_guard lk(replica_mu_);
    pending_replica_=PendingReplica{r.seq,std::move(value)};
    replica_cv_.notify_one();
  }
  LicenseDiagnostic({{"event","primary_write"},{"seq",r.seq},{"duration_ms",ms},{"ok",true},{"used_ns",r.used_ns},{"reserved_ns",r.reserved_ns},{"revoked",r.revoked}});
}
} // namespace ainvr_license
