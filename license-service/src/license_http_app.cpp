#include "license_http_app.hpp"
#include <openssl/crypto.h>
#include <nlohmann/json.hpp>
namespace ainvr_license {
using nlohmann::json;
namespace {
WebResponse Reply(int code,const json&body){return {code,body.dump()};}
json Snapshot(const StatusSnapshot&s,bool tripped){return {{"state",StateName(s.state)},{"mode",s.mode},{"machine_code",s.fingerprint},{"soc_model",s.soc_model},{"remaining_minutes",s.remaining_minutes},{"remaining_seconds",s.remaining_seconds},{"total_seconds",s.total_seconds},{"used_seconds",s.used_seconds},{"activation_wall",s.activation_wall},{"expires_min",s.expires_min},{"seq",s.seq},{"grant_seq",s.grant_seq},{"license_id",s.license_id},{"daemon_epoch",s.daemon_epoch},{"reason",s.reason},{"service_ok",s.service_ok},{"enforcer_tripped",tripped}};}
std::unordered_map<std::string,std::string> Query(const std::string&q){
  std::unordered_map<std::string,std::string> result;size_t pos=0;
  while(pos<q.size()){auto end=q.find('&',pos);if(end==std::string::npos)end=q.size();auto part=q.substr(pos,end-pos);auto eq=part.find('=');if(eq!=std::string::npos)result.emplace(part.substr(0,eq),part.substr(eq+1));pos=end+1;}return result;
}
}
LicenseHttpApp::LicenseHttpApp(LicenseManager*m,std::string key):mgr_(m),admin_key_(std::move(key)){}
WebResponse LicenseHttpApp::Dispatch(const WebRequest&req)const{
  try{
    auto sep=req.target.find('?');auto path=req.target.substr(0,sep);
    if(req.method=="GET"&&path=="/healthz")return Reply(200,{{"ok",true},{"ready",mgr_->status().service_ok}});
    if(req.method=="GET"&&path=="/api/v1/license/machine-code"){const auto&m=mgr_->machine();auto result=mgr_->RegistrationRequest();result.update({{"machine_code",m.code_grouped},{"fingerprint_version","v2-board-serial"},{"soc_model",m.soc_model}});return Reply(200,result);}
    if(req.method=="GET"&&path=="/api/v1/license/status")return Reply(200,Snapshot(mgr_->status(),enforcer_tripped_));
    if(req.method=="GET"&&path=="/api/v1/license/signed-status"){
      auto q=Query(sep==std::string::npos?"":req.target.substr(sep+1));std::string body,error;
      mgr_->BuildSignedStatus(q["client_id"],q["nonce"],body,error);
      if(!error.empty())return Reply(400,{{"code","LICENSE_BAD_CHALLENGE"},{"message",error}});
      return {200,body};
    }
    if(req.method=="POST"&&(path=="/api/v1/license/activate"||path=="/api/v1/license/preview"||path=="/api/v1/license/remove")){
      auto it=req.headers.find("x-api-key");
      if(admin_key_.empty()||it==req.headers.end()||it->second.size()!=admin_key_.size()||CRYPTO_memcmp(it->second.data(),admin_key_.data(),admin_key_.size())!=0)return Reply(401,{{"code","UNAUTHORIZED"},{"message","管理凭据不匹配"}});
      if(req.body.size()>10000)return Reply(413,{{"code","LICENSE_INVALID_KEY"},{"message","请求过大"}});
      if(path=="/api/v1/license/remove"){
        auto confirmation=json::parse(req.body,nullptr,false);
        if(!confirmation.is_object()||!confirmation.contains("confirmation")||confirmation["confirmation"]!="删除注册密钥")return Reply(400,{{"code","LICENSE_CONFIRMATION_REQUIRED"},{"message","请完整输入：删除注册密钥"}});
        if(auto e=mgr_->Remove())return Reply(409,{{"code",e->code},{"message",e->message}});
        return Reply(200,Snapshot(mgr_->status(),enforcer_tripped_));
      }
      json body;std::string token;
      try{body=json::parse(req.body);token=body.at("key").get<std::string>();}catch(...){return Reply(400,{{"code","LICENSE_INVALID_KEY"},{"message","需要注册码字符串"}});}
      if(token.empty()||token.size()>8192)return Reply(400,{{"code","LICENSE_INVALID_KEY"},{"message","注册码长度无效"}});
      LicensePayload payload;
      if(auto e=mgr_->Preview(token,payload))return Reply(409,{{"code",e->code},{"message",e->message}});
      auto before=mgr_->status();bool same=before.license_id==payload.license_id;
      if(path=="/api/v1/license/preview")return Reply(200,{{"license_id",payload.license_id},{"grant_seq",payload.grant_seq},{"duration_minutes",payload.ttl_min},{"policy","hybrid_local"},{"operation",same?"already_active":"replace"},{"current_remaining_seconds",before.remaining_seconds}});
      if(auto e=mgr_->Activate(token))return Reply(409,{{"code",e->code},{"message",e->message}});
      auto result=Snapshot(mgr_->status(),enforcer_tripped_);result["activation_result"]=same?"already_active":"activated";
      return Reply(200,result);
    }
    return Reply(404,{{"code","NOT_FOUND"},{"message","not found"}});
  }catch(const std::exception&){return Reply(503,{{"code","LICENSE_SERVICE_UNAVAILABLE"},{"message","授权服务暂时无法完成请求"}});}
}
}
