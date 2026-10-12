#include "config.hpp"
#include "encoding.hpp"
#include <yaml-cpp/yaml.h>
#include <sys/stat.h>
#include <filesystem>
#include <stdexcept>
#include <algorithm>
namespace ainvr_license {
namespace {
Key32 Key(const std::string&s){auto b=HexDecode(s);if(!b||b->size()!=32)throw std::runtime_error("32-byte key required");Key32 k{};std::copy(b->begin(),b->end(),k.begin());return k;}
}
ServiceConfig LoadConfig(const std::string&path){
  struct stat st{};if(lstat(path.c_str(),&st)!=0||!S_ISREG(st.st_mode)||(st.st_mode&0027))throw std::runtime_error("credential configuration must be a regular file without group write or world access");
  auto y=YAML::LoadFile(path);ServiceConfig c;
  c.device_key=Key(y["device_key"].as<std::string>());
  c.expected_machine=CrockfordNormalize(y["machine_code"].as<std::string>());
  if(c.expected_machine.size()!=24)throw std::runtime_error("machine_code required");
  c.admin_api_key=y["admin_api_key"].as<std::string>();
  if(c.admin_api_key.size()<32||c.admin_api_key.size()>128)throw std::runtime_error("random admin_api_key required");
  if(y["host"])c.host=y["host"].as<std::string>();
  if(c.host!="127.0.0.1"&&c.host!="::1")throw std::runtime_error("license TCP endpoint must be loopback");
  if(y["port"])c.port=y["port"].as<int>();if(c.port<1024||c.port>65535)throw std::runtime_error("port out of range");
  if(y["uds_path"])c.uds_path=y["uds_path"].as<std::string>();
  if(!y["installation_path"])throw std::runtime_error("installation_path is required; no implicit production identity");
  c.installation_path=y["installation_path"].as<std::string>();
  if(!std::filesystem::path(c.installation_path).is_absolute())throw std::runtime_error("absolute installation path required");
  if(y["migration_file"])c.migration_file=y["migration_file"].as<std::string>();
  if(c.uds_path.empty()||c.uds_path[0]!='/')throw std::runtime_error("absolute UDS path required");
  if(y["state"]){
    auto s=y["state"];
    if(s["primary"])c.state_primary=s["primary"].as<std::string>();
    if(s["replica2"])c.state_replica2=s["replica2"].as<std::string>();
    if(s["replica3"])c.state_replica3=s["replica3"].as<std::string>();
  }
  for(const auto&p:c.StatePaths())if(!std::filesystem::path(p).is_absolute())throw std::runtime_error("absolute state path required");
  if(c.state_primary==c.state_replica2||c.state_primary==c.state_replica3||c.state_replica2==c.state_replica3)throw std::runtime_error("state paths must differ");
  for(auto it=y["signal_keys"].begin();it!=y["signal_keys"].end();++it)c.signal_keys[it->first.as<std::string>()]=Key(it->second.as<std::string>());
  for(const char*id:{"ai-service","recorder","console-backend","enforcer"})if(!c.signal_keys.contains(id))throw std::runtime_error("missing consumer key");
  return c;
}
}
