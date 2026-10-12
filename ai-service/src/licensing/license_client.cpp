#include "license_client.hpp"
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <poll.h>
#include <pwd.h>
#include <time.h>
#include <ctime>
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>
namespace ai_service::licensing {
namespace {
constexpr int64_t kFailureLogIntervalMs=30000;  // 连续失败：首次立即记，之后每 30 秒一条摘要
constexpr int64_t kSlowRequestMs=1000;          // 单次请求超过这个耗时就值得记一笔
constexpr int kRetryAfterFailureMs=1000;
// 明确的停止信号：到期/未授权，以及时钟异常与被篡改（线上状态名 recovery_required）这类攻击信号。
// 存储故障（storage_error）可能只是磁盘卡顿，仍只降级。
bool IsStopState(const std::string&s){return s=="unlicensed"||s=="expired"||s=="clock_error"||s=="recovery_required";}
constexpr int64_t kShortLeaseMs=10000;          // 低于这个值才算租约被压短（正常 30 秒，轮询 5 秒）
std::string Seconds(int64_t ms){char b[32];std::snprintf(b,sizeof(b),"%.2f",ms/1000.0);return b;}
int64_t Elapsed(){timespec t{};if(clock_gettime(CLOCK_BOOTTIME,&t))throw std::runtime_error("internal clock unavailable");return t.tv_sec*1000LL+t.tv_nsec/1000000;}
std::string Hex(const unsigned char*p,size_t n){static const char chars[]="0123456789abcdef";std::string out;for(size_t i=0;i<n;++i){out+=chars[p[i]>>4];out+=chars[p[i]&15];}return out;}
std::vector<unsigned char> DecodeHex(const std::string&s){std::vector<unsigned char>out;if(s.size()!=64)return out;for(size_t i=0;i<s.size();i+=2){auto digit=[](char c){if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;if(c>='A'&&c<='F')return c-'A'+10;return -1;};int a=digit(s[i]),b=digit(s[i+1]);if(a<0||b<0)return {};out.push_back((a<<4)|b);}return out;}
std::string Decode64(std::string s){if(s.size()>12000||s.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")!=std::string::npos)throw std::runtime_error("invalid payload");std::replace(s.begin(),s.end(),'-','+');std::replace(s.begin(),s.end(),'_','/');size_t pad=(4-s.size()%4)%4;s.append(pad,'=');std::string out(s.size(),'\0');int n=EVP_DecodeBlock(reinterpret_cast<unsigned char*>(out.data()),reinterpret_cast<const unsigned char*>(s.data()),s.size());if(n<0||static_cast<size_t>(n)<pad)throw std::runtime_error("invalid base64");out.resize(n-pad);return out;}
std::string Env(const char*k,const std::string&fallback=""){const char*v=getenv(k);return v?v:fallback;}
std::string Trim(std::string s){auto p=s.find_first_not_of(" \t\r\n");if(p==std::string::npos)return "";s=s.substr(p);s.resize(s.find_last_not_of(" \t\r\n")+1);if(s.size()>=2&&((s.front()=='"'&&s.back()=='"')||(s.front()=='\''&&s.back()=='\'')))s=s.substr(1,s.size()-2);return s;}
bool Ready(int fd,short event,std::chrono::steady_clock::time_point deadline){auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(deadline-std::chrono::steady_clock::now()).count();if(ms<=0)return false;pollfd p{fd,event,0};int rc=poll(&p,1,ms);return rc>0&&(p.revents&(event|POLLHUP));}
void Peer(int fd) {
#ifndef AINVR_LICENSE_SERVICE_USER
#define AINVR_LICENSE_SERVICE_USER "ainvr"
#endif
  passwd account{}, *found=nullptr;
  std::vector<char> buffer(16384);
  if(getpwnam_r(AINVR_LICENSE_SERVICE_USER, &account, buffer.data(), buffer.size(), &found) || !found)
    throw std::runtime_error("license service account missing");
  ucred c{}; socklen_t size=sizeof(c);
  if(getsockopt(fd,SOL_SOCKET,SO_PEERCRED,&c,&size) || c.pid<=0 || c.uid!=account.pw_uid)
    throw std::runtime_error("untrusted peer");
  auto base="/proc/"+std::to_string(c.pid);
  auto exe=std::filesystem::read_symlink(base+"/exe").filename().string();
  if(exe.size()>=10 && exe.compare(exe.size()-10,10," (deleted)")==0)exe.resize(exe.size()-10);
  std::ifstream groups(base+"/cgroup");
  bool in_service=false;
  for(std::string line; std::getline(groups,line);) {
    auto colon=line.find(':');
    if(colon==std::string::npos) continue;
    colon=line.find(':',colon+1);
    if(colon==std::string::npos) continue;
    auto path=std::filesystem::path(line.substr(colon+1));
    if(path.filename()=="ainvr-license.service") in_service=true;
  }
  if(exe!="license_service" || !in_service)
    throw std::runtime_error("untrusted license service");
}
int64_t Number(const nlohmann::json&p,const char*k,int64_t max){const auto&v=p.at(k);if(!v.is_number_integer()||(v.is_number_unsigned()&&v.get<uint64_t>()>static_cast<uint64_t>(max)))throw std::runtime_error("invalid integer");auto n=v.get<int64_t>();if(n<0||n>max)throw std::runtime_error("integer out of range");return n;}
}
std::string GenerateNonce(){unsigned char b[16];if(RAND_bytes(b,16)!=1)throw std::runtime_error("random unavailable");return Hex(b,16);}
LicenseConfig LoadConfigFromEnv(const std::string&path){
  std::ifstream f(path);
  for(std::string line;std::getline(f,line);){line=Trim(line);if(line.empty()||line[0]=='#')continue;auto eq=line.find('=');if(eq!=std::string::npos){auto k=Trim(line.substr(0,eq)),v=Trim(line.substr(eq+1));if(!k.empty()&&!getenv(k.c_str()))setenv(k.c_str(),v.c_str(),0);}}
  // A production executable has no environment-variable licensing bypass.
  LicenseConfig c;
  c.device_id=Env("LICENSE_DEVICE_ID");c.device_id.erase(std::remove(c.device_id.begin(),c.device_id.end(),'-'),c.device_id.end());
  c.signal_key_hex=Env("LICENSE_SIGNAL_KEY");c.uds_path=Env("LICENSE_UDS_PATH",c.uds_path);return c;
}
Fetcher MakeHttpFetcher(const LicenseConfig&cfg){
  return [cfg](const std::string&nonce,std::string&error)->std::optional<TransportResult>{
    int fd=-1;
    try{
      if(cfg.uds_path.size()>=sizeof(sockaddr_un{}.sun_path))throw std::runtime_error("UDS path too long");
      fd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK,0);if(fd<0)throw std::runtime_error("socket failed");
      sockaddr_un a{};a.sun_family=AF_UNIX;std::memcpy(a.sun_path,cfg.uds_path.c_str(),cfg.uds_path.size()+1);
      auto end=std::chrono::steady_clock::now()+std::chrono::seconds(cfg.timeout_sec);
      if(connect(fd,reinterpret_cast<sockaddr*>(&a),sizeof(a))!=0){if(errno!=EINPROGRESS||!Ready(fd,POLLOUT,end))throw std::runtime_error("UDS unavailable");int e=0;socklen_t n=sizeof(e);if(getsockopt(fd,SOL_SOCKET,SO_ERROR,&e,&n)||e)throw std::runtime_error("UDS unavailable");}
      if(cfg.peer_check)Peer(fd);
      auto request="GET /api/v1/license/signed-status?client_id="+cfg.client_id+"&nonce="+nonce+" HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
      size_t sent=0;while(sent<request.size()){if(!Ready(fd,POLLOUT,end))throw std::runtime_error("send deadline");auto n=send(fd,request.data()+sent,request.size()-sent,MSG_NOSIGNAL);if(n<=0)throw std::runtime_error("send failed");sent+=n;}
      std::string raw;for(;;){if(!Ready(fd,POLLIN,end))throw std::runtime_error("read deadline");char b[2048];auto n=recv(fd,b,sizeof(b),0);if(!n)break;if(n<0){if(errno==EAGAIN)continue;throw std::runtime_error("read failed");}raw.append(b,n);if(raw.size()>16384)throw std::runtime_error("response too large");}
      close(fd);fd=-1;auto sep=raw.find("\r\n\r\n");if(sep==std::string::npos)throw std::runtime_error("invalid HTTP");
      std::istringstream stream(raw.substr(0,sep));std::string protocol;int code=0;stream>>protocol>>code;
      if(protocol!="HTTP/1.1"&&protocol!="HTTP/1.0")throw std::runtime_error("invalid HTTP version");
      std::string line;
      std::getline(stream,line);
      std::optional<size_t> length;
      while(std::getline(stream,line)){
        auto colon=line.find(':');if(colon==std::string::npos)throw std::runtime_error("invalid header");
        auto name=Trim(line.substr(0,colon));
        std::transform(name.begin(),name.end(),name.begin(),[](unsigned char c){return std::tolower(c);});
        auto value=Trim(line.substr(colon+1));
        if(name=="transfer-encoding")throw std::runtime_error("unsupported transfer encoding");
        if(name=="content-length"){
          if(length||value.empty()||value.find_first_not_of("0123456789")!=std::string::npos)throw std::runtime_error("invalid content length");
          length=std::stoull(value);
        }
      }
      auto body=raw.substr(sep+4);
      if(!length||*length!=body.size())throw std::runtime_error("truncated HTTP response");
      return TransportResult{code,std::move(body)};
    }catch(const std::exception&e){if(fd>=0)close(fd);error=e.what();return std::nullopt;}
  };
}
LicenseClient::LicenseClient(LicenseConfig c,Fetcher f,Clock clock):cfg_(std::move(c)),fetcher_(std::move(f)),clock_(clock?std::move(clock):Elapsed),key_(DecodeHex(cfg_.signal_key_hex)){
  if(key_.size()!=32||cfg_.device_id.size()!=24)config_error_="device credentials missing";
}
void LicenseClient::SetLogSink(LogSink sink){std::lock_guard lk(mu_);sink_=std::move(sink);}
void LicenseClient::Log(const char*level,const std::string&message)const{
  // 先复制出口再调用，不在持锁时进外部代码
  LogSink sink;{std::lock_guard lk(mu_);sink=sink_;}
  if(sink){try{sink(level,message);}catch(...){}}
}
std::string LicenseClient::ChallengeOnce(){
  std::lock_guard single(challenge_mu_);
  int64_t started_ms=0;
  try{started_ms=clock_();}catch(...){}
  auto finish=[&](const std::string&error)->std::string{
    int64_t now=started_ms,took=0;
    try{now=clock_();took=std::max<int64_t>(0,now-started_ms);}catch(...){}
    std::string line;const char*level="info";
    {
      std::lock_guard lk(mu_);
      last_duration_ms_=took;
      if(!error.empty()){
        last_ok_=false;++failures_;
        if(!first_failure_ms_)first_failure_ms_=now;
        if(!last_failure_log_ms_||now-*last_failure_log_ms_>=kFailureLogIntervalMs){
          last_failure_log_ms_=now;
          auto remaining=std::max<int64_t>(0,deadline_-now);
          level="warn";
          line="授权请求失败: "+error+" (耗时 "+Seconds(took)+"s, 连续 "+std::to_string(failures_)+" 次, 租约剩余 "+Seconds(remaining)+"s)";
        }
      }else{
        const int failures=failures_;const auto since=first_failure_ms_;
        last_ok_=true;failures_=0;first_failure_ms_.reset();last_failure_log_ms_.reset();last_success_ms_=now;
        if(failures){
          line="授权请求恢复: 连续失败 "+std::to_string(failures)+" 次, 中断 "+Seconds(since?now-*since:0)+"s";
        }else if(took>=kSlowRequestMs){
          level="warn";
          line="授权请求偏慢: 耗时 "+Seconds(took)+"s (租约剩余 "+Seconds(std::max<int64_t>(0,deadline_-now))+"s)";
        }
      }
    }
    if(!line.empty())Log(level,line);
    return error;
  };
  try{
    if(!config_error_.empty())throw std::runtime_error(config_error_);
    auto started=clock_();auto nonce=GenerateNonce();std::string error;auto response=fetcher_(nonce,error);
    if(!response||response->status!=200)throw std::runtime_error(error.empty()?"license request failed":error);
    if(response->body.size()>16384)throw std::runtime_error("response too large");
    auto envelope=nlohmann::json::parse(response->body);auto encoded=envelope.at("payload").get<std::string>(),sig=envelope.at("sig").get<std::string>();
    auto msg="AINVR/lease/v2|"+encoded;unsigned char digest[EVP_MAX_MD_SIZE];unsigned int size=0;
    if(!HMAC(EVP_sha256(),key_.data(),key_.size(),reinterpret_cast<const unsigned char*>(msg.data()),msg.size(),digest,&size))throw std::runtime_error("HMAC failed");
    auto expect=Hex(digest,size);if(sig.size()!=expect.size()||CRYPTO_memcmp(sig.data(),expect.data(),sig.size()))throw std::runtime_error("bad signature");
    auto p=nlohmann::json::parse(Decode64(encoded));
    if(p.at("v")!=2||p.at("device_id")!=cfg_.device_id||p.at("audience")!=cfg_.client_id||p.at("nonce")!=nonce)throw std::runtime_error("lease binding mismatch");
    auto state=p.at("state").get<std::string>();
    if(state!="valid"&&state!="unlicensed"&&state!="expired"&&state!="recovery_required"&&state!="storage_error"&&state!="clock_error")throw std::runtime_error("unknown state");
    auto lease=Number(p,"lease_ms",30000),remaining=Number(p,"remaining_seconds",315360000);
    Number(p,"revision",9007199254740991LL);Number(p,"grant_seq",9007199254740991LL);
    if(lease>remaining*1000||(state!="valid"&&lease))throw std::runtime_error("invalid lease");
    if(p.at("epoch").get<std::string>().size()!=32)throw std::runtime_error("invalid epoch");
    auto id=p.at("license_id").get<std::string>();
    if((state=="valid"||state=="expired")&&(id.size()!=32||id.find_first_not_of("0123456789abcdef")!=std::string::npos))throw std::runtime_error("invalid license id");
    auto authorization=p.contains("authorization_ms")?Number(p,"authorization_ms",remaining*1000):std::max<int64_t>(0,remaining-1)*1000;
    int64_t after=started;try{after=clock_();}catch(...){}
    {std::lock_guard lk(mu_);payload_=p;deadline_=started+lease;error_.clear();
      last_contact_ms_=after;last_took_ms_=std::max<int64_t>(0,after-started);
      if(state=="valid")licensed_until_ms_=started+authorization;
      else if(IsStopState(state))licensed_until_ms_=0;
      if(state=="valid"&&lease<kShortLeaseMs){if(!short_since_ms_)short_since_ms_=after;}else short_since_ms_.reset();
      cv_.notify_all();}
    return finish("");
  }catch(const std::exception&e){{std::lock_guard lk(mu_);error_=e.what();}return finish(e.what());}
}
std::string LicenseClient::Tick(std::string*old_phase,std::string*new_phase){
  auto error=ChallengeOnce();
  std::string old_p,new_p,line,degraded_line;
  {
    std::lock_guard lk(mu_);
    new_p=PhaseLocked();old_p=previous_phase_;
    if(const bool d=DegradedLocked();d!=was_degraded_){
      was_degraded_=d;
      degraded_line=d?"授权续查降级：保留已验证授权至内部时刻 "+Seconds(licensed_until_ms_)+"s":std::string("授权续查恢复正常");
    }
    if(new_p!=old_p){
      previous_phase_=new_p;
      // Signed authority diagnostics contain clocks/budgets only, never credentials.
      auto inputs=nlohmann::json{{"event","permission_decision"},{"client",cfg_.client_id},{"phase",new_p},{"lease_deadline_ms",deadline_},{"licensed_until_ms",licensed_until_ms_},{"short_since_ms",short_since_ms_.value_or(-1)},{"last_contact_ms",last_contact_ms_.value_or(-1)},{"last_request_ms",last_took_ms_},{"retain_verified_grant",cfg_.retain_verified_grant},{"failures",failures_},{"last_error",error_}};
      try{inputs["internal_ms"]=clock_();}catch(...){inputs["clock_error"]=true;}
      inputs["wall_sec"]=std::time(nullptr);
      if(payload_){inputs["signed_state"]=payload_->value("state","");inputs["signed_lease_ms"]=payload_->value("lease_ms",int64_t{0});inputs["signed_remaining_seconds"]=payload_->value("remaining_seconds",int64_t{0});inputs["authority_reason"]=payload_->value("reason","");inputs["authority"]=payload_->value("diagnostics",nlohmann::json::object());}
      line=inputs.dump();
      if(new_p=="dormant"){
        int64_t now=0;try{now=clock_();}catch(...){}
        const auto since=last_success_ms_?now-*last_success_ms_:-1;
        line+=" 授权相位 "+old_p+" -> "+new_p+" (最后错误="+(error_.empty()?std::string("无"):error_)+"; 距上次成功 "+
             (since<0?std::string("未知"):Seconds(since)+"s")+"; 连续失败 "+std::to_string(failures_)+" 次; 末次请求耗时 "+Seconds(last_duration_ms_)+"s)";
      }else line+=" 授权相位 "+old_p+" -> "+new_p;
    }
  }
  if(!degraded_line.empty())Log("warn",degraded_line);
  if(!line.empty())Log("warn",line);
  if(old_phase)*old_phase=old_p;
  if(new_phase)*new_phase=new_p;
  return error;
}
int LicenseClient::NextWaitMs(){
  std::lock_guard lk(mu_);
  const int normal=std::clamp(cfg_.poll_sec,1,5)*1000;
  if(!last_ok_)return std::min(normal,kRetryAfterFailureMs);
  int wait=normal;
  if(payload_&&payload_->at("state")=="valid"){
    try{auto remaining=std::max<int64_t>(0,deadline_-clock_());
      if(remaining<2LL*normal)wait=std::min(wait,static_cast<int>(std::clamp<int64_t>(remaining/2,100,kRetryAfterFailureMs)));
    }catch(...){wait=std::min(wait,kRetryAfterFailureMs);}
  }
  return wait;
}
std::string LicenseClient::PhaseLocked()const{
  if(!config_error_.empty())return "configuration_error";
  if(!payload_)return "starting";
  auto state=payload_->at("state").get<std::string>();
  if(IsStopState(state))return "invalid";
  try{auto now=clock_();if((state=="valid"&&now<deadline_)||RetainsGrantLocked(now))return "valid";
    if(state!="valid"&&!licensed_until_ms_)return "starting";
    return "dormant";}catch(...){return "dormant";}
}
// 续查失败只降级，权限不会越过最后一次验证的激活截止时间。
bool LicenseClient::RetainsGrantLocked(int64_t now)const{
  return cfg_.retain_verified_grant && now<licensed_until_ms_;
}
bool LicenseClient::DegradedLocked()const{
  if(!payload_)return false;
  try{auto now=clock_();return now>=deadline_&&RetainsGrantLocked(now);}catch(...){return false;}
}
bool LicenseClient::Degraded(){std::lock_guard lk(mu_);return DegradedLocked();}
std::string LicenseClient::Phase(){std::lock_guard lk(mu_);return PhaseLocked();}
std::string LicenseClient::LastError(){std::lock_guard lk(mu_);return error_;}
nlohmann::json LicenseClient::StatusSnapshot(){std::lock_guard lk(mu_);auto j=payload_.value_or(nlohmann::json::object());j["phase"]=PhaseLocked();j["degraded"]=DegradedLocked();j["last_error"]=config_error_.empty()?error_:config_error_;j["enabled"]=cfg_.enabled;return j;}
nlohmann::json LicenseClient::DecisionDiagnostics(){
  std::lock_guard lk(mu_);
  nlohmann::json j={{"phase",PhaseLocked()},{"wall_sec",std::time(nullptr)},{"lease_deadline_ms",deadline_},{"licensed_until_ms",licensed_until_ms_},{"last_contact_ms",last_contact_ms_.value_or(-1)},{"short_since_ms",short_since_ms_.value_or(-1)},{"retain_verified_grant",cfg_.retain_verified_grant},{"last_request_ms",last_took_ms_},{"failures",failures_},{"last_error",error_}};
  try{j["internal_ms"]=clock_();}catch(...){j["clock_error"]=true;}
  if(payload_){j["signed_state"]=payload_->value("state","");j["signed_lease_ms"]=payload_->value("lease_ms",int64_t{0});j["signed_remaining_seconds"]=payload_->value("remaining_seconds",int64_t{0});j["authority"]=payload_->value("diagnostics",nlohmann::json::object());}
  return j;
}
void LicenseClient::Start(PhaseChange cb){
  if(thread_.joinable())return;{std::lock_guard lk(mu_);stop_=false;}
  thread_=std::thread([this,cb]{
    for(;;){
      std::string old_phase,new_phase;
      Tick(&old_phase,&new_phase);
      if(new_phase!=old_phase&&cb)try{cb(old_phase,new_phase);}catch(...){}
      const int wait_ms=NextWaitMs();
      std::unique_lock lk(mu_);
      if(cv_.wait_for(lk,std::chrono::milliseconds(wait_ms),[&]{return stop_;}))return;
    }
  });
}
void LicenseClient::Stop(){{std::lock_guard lk(mu_);stop_=true;}cv_.notify_all();if(thread_.joinable())thread_.join();}
bool LicenseClient::WaitForValid(int seconds){auto end=std::chrono::steady_clock::now()+std::chrono::seconds(std::max(0,seconds));while(!IsLicensed()){if(seconds>0&&std::chrono::steady_clock::now()>=end)return false;std::unique_lock lk(mu_);if(stop_)return false;cv_.wait_for(lk,std::chrono::milliseconds(100));}return true;}
}
