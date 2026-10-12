#include "license_manager.hpp"
#include "encoding.hpp"
#include "diagnostics.hpp"
#include "license_budget.hpp"
#include <algorithm>
#include <nlohmann/json.hpp>
#include <stdexcept>
namespace ainvr_license {
namespace {
// A：预算提前续期量。已落盘预算剩余不足 L+A 就发起下一次落盘，这样落盘最多可以卡 L+A 再加上
// 预算本身的余量才会真正影响业务；预算耗尽仍然停止签发租约。
constexpr int64_t NS=1000000000LL,Q=kBudgetReservationSec*NS,L=kMaxLeaseSec*NS,A=kBudgetAheadSec*NS;
void SampleClocks(Clock*clock,const LicenseRecord&n,bool startup,nlohmann::json&d){
    d={{"startup",startup},{"sampling_complete",false},{"sampling_field","mono_ns"},
      {"mono_ns",nullptr},{"boot_ns",nullptr},{"wall_sec",nullptr},{"current_boot_id",nullptr},
      {"previous_mono_ns",n.last_mono_ns},{"previous_boot_ns",n.last_boot_ns},
      {"previous_boot_id",n.boot_id},{"activation_wall_sec",n.activation_wall},
      {"used_before_ns",n.used_ns},{"total_ns",n.total_seconds*NS}};
    auto mono=clock->MonoNs();d["mono_ns"]=mono;
    d["sampling_field"]="boot_ns";
    auto boot_ns=clock->BootNs();d["boot_ns"]=boot_ns;
    d["sampling_field"]="boot_id";
    auto boot=clock->BootId();d["current_boot_id"]=boot;
    d["sampling_field"]="wall_sec";
    auto wall=clock->WallSec();d["wall_sec"]=wall;
    d["sampling_complete"]=true;d["sampling_field"]="complete";
}
// 2026-01-01T00:00:00Z:产品发布之后的时间,早于它的系统时间一定不可信
constexpr int64_t kMinTrustedWallSec=1767225600;
int64_t WallUsed(int64_t wall,const LicenseRecord&r){if(wall<=r.activation_wall)return 0;return std::min(wall-r.activation_wall,r.total_seconds)*NS;}
}
LicenseManager::LicenseManager(MachineInfo m,std::shared_ptr<StateStore>s,Clock*c):machine_(std::move(m)),store_(std::move(s)),clock_(c),epoch_(HexEncode(RandomBytes(16))),worker_([this]{PersistLoop();}){}
LicenseManager::~LicenseManager(){
  {std::lock_guard<std::mutex> lk(pmu_);stop_=true;}
  pcv_.notify_all();
  if(worker_.joinable())worker_.join();   // 先把已入队的落盘写完再退出
}
void LicenseManager::PersistLoop(){
  std::unique_lock<std::mutex> lk(pmu_);
  for(;;){
    pcv_.wait(lk,[&]{return stop_||!queue_.empty();});
    if(queue_.empty()){if(stop_)return;continue;}
    auto item=std::move(queue_.front());queue_.pop_front();busy_=true;
    persist_started_=std::chrono::steady_clock::now();active_persist_seq_=item.rec.seq;active_persist_reserved_ns_=item.rec.reserved_ns;
    auto queue_ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-item.queued).count();
    bool ok=true;std::string err;
    if(persist_failed_.load()){ok=false;err=persist_error_;}   // 已经故障：不再往盘上写任何状态（与原语义一致：修复存储后重启）
    else{
      lk.unlock();
      try{store_->Save(item.rec);}catch(const std::exception&e){ok=false;err=e.what();}catch(...){ok=false;err="unknown storage error";}
      lk.lock();
    }
    if(ok)durable_reserved_ns_.store(item.rec.reserved_ns);
    else if(!persist_failed_.load()){persist_error_=err;persist_failed_.store(true);}
    if(item.result){item.result->done=true;item.result->ok=ok;item.result->error=err;}
    busy_=false;done_cv_.notify_all();
    lk.unlock();
    LicenseDiagnostic({{"event","budget_commit"},{"seq",item.rec.seq},{"queue_ms",queue_ms},{"primary_ms",store_->PrimaryWriteMs()},{"ok",ok},{"reserved_ns",item.rec.reserved_ns},{"used_ns",item.rec.used_ns},{"sync",item.sync}});
    lk.lock();
  }
}
void LicenseManager::Flush(){
  std::unique_lock<std::mutex> lk(pmu_);
  done_cv_.wait(lk,[&]{return queue_.empty()&&!busy_;});
}
void LicenseManager::AbsorbPersistFaultLocked(){
  if(!persist_failed_.load()||!fault_reason_.empty())return;
  std::string reason;{std::lock_guard<std::mutex> lk(pmu_);reason=persist_error_;}
  fault_=LicenseState::kStorageError;fault_reason_=reason.empty()?"STATE_PERSIST_FAILED":reason;
}
void LicenseManager::RequestReservationLocked(const LicenseRecord&at){
  auto target=at;
  if(target.seq>=kMaxSequence||last_seq_>=kMaxSequence)throw std::runtime_error("STATE_SEQUENCE_EXHAUSTED");
  target.seq=++last_seq_;
  target.reserved_ns=std::min(target.total_seconds*NS,at.used_ns+Q);
  requested_reserved_ns_=target.reserved_ns;
  std::lock_guard<std::mutex> lk(pmu_);
  // 紧挨着的上一条也是未开始的续期：合并成最新的一条（序号更大、预算更新）。
  // 绝不合并激活/注销（sync）——它们必须各自按顺序落盘。
  if(!queue_.empty()&&!queue_.back().sync)queue_.back()=PersistItem{std::move(target),false,nullptr};
  else queue_.push_back(PersistItem{std::move(target),false,nullptr});
  pcv_.notify_one();
}
void LicenseManager::SetSignalKeys(std::unordered_map<std::string,Key32>keys){std::lock_guard lk(mu_);signal_keys_=std::move(keys);}
bool LicenseManager::CommitLocked(LicenseRecord next){
  try{
    if(last_seq_>=kMaxSequence)throw std::runtime_error("STATE_SEQUENCE_EXHAUSTED");
    next.seq=++last_seq_;
    auto result=std::make_shared<PersistResult>();
    {
      std::lock_guard<std::mutex> lk(pmu_);
      queue_.push_back(PersistItem{next,true,result});   // 排在已入队的续期之后，旧写入不会覆盖新授权
      pcv_.notify_one();
    }
    {
      std::unique_lock<std::mutex> lk(pmu_);
      done_cv_.wait(lk,[&]{return result->done;});
    }
    if(!result->ok)throw std::runtime_error(result->error.empty()?"STATE_PERSIST_FAILED":result->error);
    requested_reserved_ns_=next.reserved_ns;
    rec_=std::move(next);return true;
  }
  catch(const std::exception&e){fault_=LicenseState::kStorageError;fault_reason_=e.what();return false;}
}
void LicenseManager::Init(){std::lock_guard lk(mu_);InitLocked();}
void LicenseManager::InitLocked(){
  if(loaded_)return;
  loaded_=true;
  try{
    auto lo=store_->Load();
    if(lo.storage_error){fault_=LicenseState::kStorageError;fault_reason_=lo.reason;return;}
    if(lo.tampered){
      fault_=LicenseState::kTampered;fault_reason_=lo.reason;
      try{store_->RequireRecovery();}
      // Corruption is already confirmed: a failed challenge write must neither
      // become a clock error nor downgrade the signed tamper decision to grace.
      catch(const std::exception&){fault_reason_+=";RECOVERY_CHALLENGE_WRITE_FAILED";}
      return;
    }
    rec_=lo.record;if(!rec_)return;
    last_seq_=std::max(last_seq_,rec_->seq);durable_reserved_ns_.store(rec_->reserved_ns);requested_reserved_ns_=rec_->reserved_ns;
    if(rec_->revoked){if(lo.migrated)CommitLocked(*rec_);return;}
    auto n=*rec_;
    SampleClocks(clock_,n,true,last_calculation_);
    auto mono=last_calculation_.at("mono_ns").get<int64_t>(),boot_ns=last_calculation_.at("boot_ns").get<int64_t>();
    auto boot=last_calculation_.at("current_boot_id").get<std::string>();auto wall=last_calculation_.at("wall_sec").get<int64_t>();
    int64_t elapsed=0;
    if(n.boot_id==boot){if(mono<n.last_mono_ns||boot_ns<n.last_boot_ns)throw std::runtime_error("CLOCK_REGRESSION");elapsed=std::max(mono-n.last_mono_ns,boot_ns-n.last_boot_ns);}
    auto total=n.total_seconds*NS;
    auto wall_used=WallUsed(wall,n);
    last_calculation_.update({{"startup",true},{"boot_changed",n.boot_id!=boot},{"wall_sec",wall},{"activation_wall_sec",n.activation_wall},{"mono_ns",mono},{"boot_ns",boot_ns},{"previous_mono_ns",n.last_mono_ns},{"previous_boot_ns",n.last_boot_ns},{"elapsed_ns",elapsed},{"used_before_ns",n.used_ns},{"saved_reserved_ns",n.reserved_ns},{"wall_used_ns",wall_used},{"total_ns",total}});
    n.used_ns=std::min(total,std::max({n.reserved_ns,n.used_ns+std::min(elapsed,total-n.used_ns),wall_used}));
    n.last_mono_ns=mono;n.last_boot_ns=boot_ns;n.boot_id=boot;
    n.reserved_ns=std::min(total,std::max(n.reserved_ns,n.used_ns+Q));
    CommitLocked(n);
    ObserveLocked(SnapshotLocked());
  }catch(const std::exception&e){last_calculation_["calculation_error"]=e.what();fault_=LicenseState::kClockError;fault_reason_=e.what();}
}
void LicenseManager::AdvanceLocked(){
  if(!loaded_)InitLocked();
  AbsorbPersistFaultLocked();
  if(!rec_||rec_->revoked||!fault_reason_.empty())return;
  try{
    auto n=*rec_;
    SampleClocks(clock_,n,false,last_calculation_);
    auto mono=last_calculation_.at("mono_ns").get<int64_t>(),bt=last_calculation_.at("boot_ns").get<int64_t>();
    auto boot=last_calculation_.at("current_boot_id").get<std::string>();auto wall=last_calculation_.at("wall_sec").get<int64_t>();
    if(boot!=n.boot_id||mono<n.last_mono_ns||bt<n.last_boot_ns)throw std::runtime_error("CLOCK_REGRESSION");
    int64_t total=n.total_seconds*NS;
    auto delta=std::max(mono-n.last_mono_ns,bt-n.last_boot_ns);
    auto wall_used=WallUsed(wall,n);
    last_calculation_.update({{"wall_sec",wall},{"activation_wall_sec",n.activation_wall},{"mono_ns",mono},{"boot_ns",bt},{"previous_mono_ns",n.last_mono_ns},{"previous_boot_ns",n.last_boot_ns},{"mono_delta_ns",mono-n.last_mono_ns},{"boot_delta_ns",bt-n.last_boot_ns},{"elapsed_ns",delta},{"used_before_ns",n.used_ns},{"wall_used_ns",wall_used},{"total_ns",total}});
    n.used_ns=std::max(n.used_ns+std::min(delta,total-n.used_ns),wall_used);
    n.last_mono_ns=mono;n.last_boot_ns=bt;
    // 租约只能用到"已确认落盘"的预算：这是原有的安全规则（先持久化再放行），一字未改。
    // 区别只是落盘不再在请求路径上同步等待：预算不足 L+A 时入队续期，立即返回；
    // 落盘卡住期间租约随已落盘预算缩短，耗尽即停止签发。
    n.reserved_ns=std::max(n.reserved_ns,std::min(total,durable_reserved_ns_.load()));
    if(std::max(n.reserved_ns,requested_reserved_ns_)<std::min(total,n.used_ns+L+A))RequestReservationLocked(n);
    n.seq=std::max(n.seq,last_seq_);
    rec_=n;
  }catch(const std::exception&e){last_calculation_["calculation_error"]=e.what();fault_=LicenseState::kClockError;fault_reason_=e.what();}
}
void LicenseManager::Tick(){std::lock_guard lk(mu_);AdvanceLocked();ObserveLocked(SnapshotLocked());}
StatusSnapshot LicenseManager::SnapshotLocked()const{
  StatusSnapshot s;s.fingerprint=machine_.code_grouped;s.soc_model=machine_.soc_model;s.daemon_epoch=epoch_;
  if(rec_){const auto&r=*rec_;s.seq=r.seq;s.grant_seq=r.grant_seq;s.license_id=r.license_id;s.activation_wall=r.activation_wall;s.total_seconds=r.total_seconds;
    auto remaining=r.total_seconds*NS-r.used_ns;
    s.remaining_seconds=(remaining+NS-1)/NS;s.remaining_minutes=(s.remaining_seconds+59)/60;s.used_seconds=r.used_ns/NS;
    s.expires_min=(r.activation_wall+r.total_seconds)/60;
    s.state=remaining>0?LicenseState::kValid:LicenseState::kExpired;
    s.lease_ms=std::min({L,remaining,std::max<int64_t>(0,r.reserved_ns-r.used_ns)})/1000000;
    if(s.state==LicenseState::kExpired)s.reason="LICENSE_EXPIRED";
    else if(s.lease_ms==0)s.reason=remaining<1000000?"LICENSE_EXPIRING":"DURABLE_BUDGET_EXHAUSTED";
    else if(s.lease_ms<10000&&remaining>=L)s.reason="DURABLE_BUDGET_LOW";
  }
  if(rec_&&rec_->revoked){s.state=LicenseState::kUnlicensed;s.reason="";s.license_id="";s.activation_wall=0;s.total_seconds=0;s.used_seconds=0;s.remaining_seconds=0;s.remaining_minutes=0;s.expires_min=0;s.lease_ms=0;}
  if(!fault_reason_.empty()){s.state=fault_;s.reason=fault_reason_;s.service_ok=false;s.lease_ms=0;}
  // 系统时间早于 2026-01-01 必然是错的(无时钟电池首次上电/从未对时):对外报时钟错误,
  // 各服务据此暂停;只影响对外状态,不改持久化授权。授权照常按单调时钟计时,不因这次
  // 时间跳变额外消耗;时间校准后自动恢复。
  else if(s.state==LicenseState::kValid&&clock_->WallSec()<kMinTrustedWallSec){
    s.state=LicenseState::kClockError;s.reason="SYSTEM_TIME_INVALID";s.lease_ms=0;
  }
  return s;
}
nlohmann::json LicenseManager::DiagnosticLocked(const StatusSnapshot&s)const{
  auto d=last_calculation_;
  d["state"]=StateName(s.state);d["reason"]=s.reason;d["lease_ms"]=s.lease_ms;
  d["remaining_seconds"]=s.remaining_seconds;d["seq"]=s.seq;
  d["used_after_ns"]=rec_?rec_->used_ns:0;
  d["remaining_ns"]=rec_?rec_->total_seconds*NS-rec_->used_ns:0;
  d["reserved_ns"]=rec_?rec_->reserved_ns:0;
  d["durable_reserved_ns"]=durable_reserved_ns_.load();d["requested_reserved_ns"]=requested_reserved_ns_;
  d["budget_remaining_ns"]=rec_?std::max<int64_t>(0,rec_->reserved_ns-rec_->used_ns):0;
  d["primary_write_ms"]=store_->PrimaryWriteMs();d["replica_write_ms"]=store_->ReplicaWriteMs();
  d["primary_seq"]=store_->PrimarySeq();d["replica_seq"]=store_->ReplicaSeq();
  {std::lock_guard lk(pmu_);d["primary_busy"]=busy_;d["primary_queue_size"]=queue_.size();
    d["primary_inflight_ms"]=busy_?std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-persist_started_).count():0;
    d["primary_inflight_seq"]=busy_?active_persist_seq_:0;
    d["primary_inflight_reserved_ns"]=busy_?active_persist_reserved_ns_:0;
  }
  return d;
}
void LicenseManager::ObserveLocked(const StatusSnapshot&s){
  auto category=std::string(StateName(s.state))+":"+s.reason;
  if(s.state==LicenseState::kValid&&s.lease_ms<10000)category+=":short";
  auto now=std::chrono::steady_clock::now();
  bool abnormal=s.state!=LicenseState::kValid||s.lease_ms<10000;
  if(category!=last_observation_||(abnormal&&now-last_diagnostic_>=std::chrono::seconds(30))){
    auto d=DiagnosticLocked(s);d["event"]="permission_evaluation";LicenseDiagnostic(std::move(d));
    last_observation_=category;last_diagnostic_=now;
  }
}
StatusSnapshot LicenseManager::status(){std::lock_guard lk(mu_);AdvanceLocked();auto s=SnapshotLocked();ObserveLocked(s);return s;}
std::optional<ActivateError> LicenseManager::ValidateLocked(const std::string&token,LicensePayload&p){
  if(!loaded_)InitLocked();
  if(store_->V3()) {
    SignedGrant g;
    try { g=store_->VerifyGrant(token); }
    catch(const std::exception&) {return ActivateError{"LICENSE_INVALID_KEY","需要有效的 v3 签名注册码；旧版注册码不能重新激活"};}
    p=g.license;
    if(!CodeEquals(p.fp,machine_.code))return ActivateError{"LICENSE_MACHINE_MISMATCH","注册码与本机不匹配"};
    if(g.installation_id!=store_->InstallationId())return ActivateError{"LICENSE_INSTALLATION_MISMATCH","注册码属于另一安装，请复制本机完整授权申请重新签发"};
    const bool recovery=fault_==LicenseState::kTampered && !fault_reason_.empty();
    if(!fault_reason_.empty() && !recovery)return ActivateError{"LICENSE_RECOVERY_REQUIRED","请先修复存储或时钟并重启授权服务"};
    if(!recovery && rec_ && !rec_->revoked && p.license_id==rec_->license_id && HexEncode(Sha256(token))==rec_->token_hash)
      return std::nullopt;
    if(g.purpose=="migrate")return ActivateError{"LICENSE_INVALID_KEY","迁移凭据仅可由受控部署使用"};
    if(recovery) {
      auto request=store_->RegistrationRequest();
      auto encoded=request.at("activation_request").get<std::string>().substr(std::string("AINVR-REQ3-").size());
        auto bytes=B64UrlDecode(encoded);
        if(!bytes)return ActivateError{"LICENSE_RECOVERY_REQUIRED","恢复申请无效，请重新读取申请"};
        auto data=nlohmann::json::parse(*bytes);
      if(g.purpose!="recover" || g.challenge!=data.at("challenge"))return ActivateError{"LICENSE_RECOVERY_REQUIRED","请使用针对当前恢复申请签发的恢复注册码"};
    } else if(g.purpose!="activate")return ActivateError{"LICENSE_INVALID_KEY","恢复注册码只能用于等待恢复的安装"};
    if(p.grant_seq<=store_->GrantFloor() || (rec_ && (p.grant_seq<=rec_->grant_seq || p.license_id==rec_->license_id)))
      return ActivateError{"LICENSE_REPLAY","旧授权或重复序号不能重新计时"};
      try {
        const auto wall=clock_->WallSec();
        if(wall<0 || wall>253402300799LL || wall<std::max<int64_t>(0,p.issued_at-300)) {
          LicenseDiagnostic({{"event","activation_clock_rejected"},{"wall_sec",wall},{"issued_at",p.issued_at}});
          return ActivateError{"LICENSE_CLOCK_UNSYNCED","系统时间早于注册码签发时间，请先校准时间再激活"};
        }
      } catch(const std::exception&) {
        return ActivateError{"LICENSE_CLOCK_ERROR","无法读取系统时间，请校准时间后重试"};
      }
    return std::nullopt;
  }
  return ActivateError{"LICENSE_PROVISION_REQUIRED","必须先配置 v3 安装登记；不支持旧版激活"};
}
std::optional<ActivateError> LicenseManager::Preview(const std::string&t,LicensePayload&p){std::lock_guard lk(mu_);AdvanceLocked();return ValidateLocked(t,p);}
nlohmann::json LicenseManager::RegistrationRequest(){return store_->RegistrationRequest();}
std::optional<ActivateError> LicenseManager::Activate(const std::string&t){
  std::lock_guard lk(mu_);AdvanceLocked();LicensePayload p;
  if(auto error=ValidateLocked(t,p))return error;
  if(rec_&&rec_->license_id==p.license_id)return std::nullopt;
  try{
    LicenseRecord n;n.fp=machine_.code_grouped;n.license_id=p.license_id;n.token_hash=HexEncode(Sha256(t));n.grant_seq=p.grant_seq;n.seq=rec_?rec_->seq:0;
    if(store_->V3()){n.schema=3;n.installation_id=store_->InstallationId();n.signed_grant=t;}
      auto wall=clock_->WallSec();
      if(wall<0||wall>253402300799LL||wall<std::max<int64_t>(0,p.issued_at-300))
        return ActivateError{"LICENSE_CLOCK_UNSYNCED","系统时间异常，请先校准时间再激活"};
      // Tolerate small issuer skew without charging it on clock correction.
      n.activation_wall=std::max(wall,p.issued_at);
    n.total_seconds=p.ttl_min*60;n.reserved_ns=std::min(Q,n.total_seconds*NS);
    n.last_mono_ns=clock_->MonoNs();n.last_boot_ns=clock_->BootNs();n.boot_id=clock_->BootId();if(n.boot_id.empty())throw std::runtime_error("BOOT_ID_UNAVAILABLE");
    if(!CommitLocked(n))return ActivateError{"LICENSE_STORAGE_ERROR","授权未确认，请修复存储后重试；不会放行业务"};
    fault_reason_.clear();fault_=LicenseState::kUnlicensed;
  }catch(const std::exception&e){return ActivateError{"LICENSE_CLOCK_ERROR",e.what()};}
  return std::nullopt;
}
std::optional<ActivateError> LicenseManager::Remove(){
  std::lock_guard lk(mu_);AdvanceLocked();
  if(!fault_reason_.empty())return ActivateError{"LICENSE_RECOVERY_REQUIRED","授权状态异常，请先修复存储或时钟；不能通过删除清除防重放记录"};
  if(!rec_||rec_->revoked)return std::nullopt;
  auto next=*rec_;next.revoked=true;
  // Keep the grant high-water mark. Exhaust the budget so an older binary
  // that does not understand the tombstone also refuses this authorization.
  next.used_ns=next.reserved_ns=next.total_seconds*NS;
  if(!CommitLocked(next))return ActivateError{"LICENSE_STORAGE_ERROR","注销未确认，请修复存储后重试；不会放行业务"};
  return std::nullopt;
}
void LicenseManager::BuildSignedStatus(const std::string&cid,const std::string&nonce,std::string&out,std::string&err){
  std::lock_guard lk(mu_);err.clear();out.clear();auto it=signal_keys_.find(cid);
  if(it==signal_keys_.end()){err="unknown_client";return;}
  if(nonce.size()!=32||nonce.find_first_not_of("0123456789abcdef")!=std::string::npos){err="bad_nonce";return;}
  AdvanceLocked();auto s=SnapshotLocked();ObserveLocked(s);
  nlohmann::json payload={{"v",2},{"device_id",CrockfordNormalize(s.fingerprint)},{"audience",cid},{"license_id",s.license_id},{"grant_seq",s.grant_seq},{"revision",s.seq},{"epoch",epoch_},{"nonce",nonce},{"state",StateName(s.state)},{"remaining_seconds",s.remaining_seconds},{"lease_ms",s.state==LicenseState::kValid?s.lease_ms:0},{"reason",s.reason}};
  payload["diagnostics"]=DiagnosticLocked(s);
  // Business permission lifetime is independent of the short renewal lease.
  payload["authorization_ms"]=s.state==LicenseState::kValid&&rec_?
      std::max<int64_t>(0,rec_->total_seconds*NS-rec_->used_ns)/1000000:0;
  auto canonical=payload.dump();
  auto encoded=B64UrlEncode(reinterpret_cast<const unsigned char*>(canonical.data()),canonical.size());
  out=nlohmann::json{{"payload",encoded},{"sig",HmacSha256Hex(it->second,"AINVR/lease/v2|"+encoded)}}.dump();
}
}
