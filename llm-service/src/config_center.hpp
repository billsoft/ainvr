#pragma once
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <set>
#include <regex>
#include <fstream>
#include <sys/stat.h>
namespace ainvr::llm {
inline nlohmann::json ReadPrivateJson(const std::string& path){
  struct stat st{};
  if(stat(path.c_str(),&st)||!S_ISREG(st.st_mode)||(st.st_mode&077)||st.st_size>65536)
    throw std::runtime_error("private configuration file required");
  std::ifstream f(path);nlohmann::json j;f>>j;return j;
}
inline nlohmann::json NormalizeSettings(const nlohmann::json& s,int version) {
  if(s.at("listen").at("host")!="127.0.0.1"||s.at("listen").at("port")!=8300||
     s.at("model").at("package_id")!="qwen3vl-4b-review-v3")throw std::invalid_argument("unsupported endpoint or model");
  auto admin=s.at("admin_key").get<std::string>();
  if(admin.size()<32||admin.size()>512)throw std::invalid_argument("invalid management key");
  std::set<std::string> keys{admin},names;
  auto callers=s.at("api_keys");
  if(!callers.is_array()||callers.empty()||callers.size()>16)throw std::invalid_argument("invalid callers");
  for(auto& c:callers){
    auto name=c.at("name").get<std::string>(),key=c.at("key").get<std::string>();
    if(!std::regex_match(name,std::regex("[a-zA-Z0-9_-]{1,48}"))||!names.insert(name).second||
       key.size()<32||key.size()>512||!keys.insert(key).second||c.at("scope")!="inference")throw std::invalid_argument("invalid or duplicate caller key");
  }
  auto schedule=s.at("scheduling");
  auto integer=[&](const char* name,int lo,int hi){auto v=schedule.at(name);if(!v.is_number_integer()||v.get<int>()<lo||v.get<int>()>hi)throw std::invalid_argument("invalid scheduling setting");return v.get<int>();};
  double temperature=s.at("tasks").at("alarm-review-zh-v1").at("calibration_temperature").get<double>();
  if(!std::isfinite(temperature)||temperature<.05||temperature>10||s.at("tasks").at("alarm-review-zh-v1").at("aspect_policy")!="reject")throw std::invalid_argument("invalid task settings");
  if(schedule.at("prefill_profile")!="s256"||s.at("model").at("load_policy")!="resident")throw std::invalid_argument("unsupported profile or loading policy");
  return {{"config_version",version},{"enabled",s.at("enabled").get<bool>()},
    {"package_root","/home/sunrise/ainvr/ai-service/models/llm/qwen3vl-4b-review-v3"},{"reservation_root","/run/ainvr"},
    {"api_keys",callers},{"admin_key",admin},{"calibration_temperature",temperature},
    {"queue_size",integer("queue_size",1,32)},{"queue_timeout_s",integer("queue_timeout_s",1,300)},
    {"exec_timeout_s",integer("exec_timeout_s",1,120)},
    {"submit_time_share_cap_percent",integer("submit_time_share_cap_percent",5,90)}};
}
class ConfigTransport {
 public:
  explicit ConfigTransport(const nlohmann::json& b):token_(b.at("service_token")) {
    std::string url=b.at("control_url");
    std::smatch m;if(!std::regex_match(url,m,std::regex("http://(127\\.0\\.0\\.1|localhost):([0-9]{1,5})/?")))throw std::invalid_argument("local config endpoint required");
    int port=std::stoi(m[2]);if(port<1||port>65535||token_.size()<32)throw std::invalid_argument("invalid bootstrap");
    client_=std::make_unique<httplib::Client>(m[1],port);client_->set_connection_timeout(3);client_->set_read_timeout(10);client_->set_write_timeout(10);
  }
  nlohmann::json Request(const std::string& path,const nlohmann::json* body=nullptr){
    httplib::Headers headers={{"x-service-token",token_}};
    auto result=body?client_->Post(("/api/v1/config/"+path).c_str(),headers,body->dump(),"application/json"):
                     client_->Get(("/api/v1/config/"+path).c_str(),headers);
    if(!result||result->status!=200||result->body.size()>1024*1024)throw std::runtime_error("configuration center unavailable");
    auto j=nlohmann::json::parse(result->body);if(j.at("code")!=0)throw std::runtime_error("configuration request failed");return j.at("data");
  }
 private:std::string token_;std::unique_ptr<httplib::Client> client_;
};
} // namespace ainvr::llm
