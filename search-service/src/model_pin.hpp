// One model-space identity shared by the service and AI producer grant.
// Pure metadata contract: no HTTP, Mongo, JSON, SDK or model loading.
#pragma once
#include <regex>
#include <string>
namespace ainvr::search {
struct RuntimeModelPin {
  std::string package_id,package_sha256,model_version;
  bool operator==(const RuntimeModelPin& other) const {
    return package_id==other.package_id&&package_sha256==other.package_sha256&&model_version==other.model_version;
  }
};
inline bool ValidRuntimeModelPin(const RuntimeModelPin& pin) {
  return pin.package_id.size()<=128&&std::regex_match(pin.package_id,std::regex("[a-z0-9][a-z0-9-]*"))&&
    std::regex_match(pin.package_sha256,std::regex("[a-f0-9]{64}"))&&pin.model_version=="search-v1-"+pin.package_sha256;
}
inline bool MatchesRuntimeModelPin(const RuntimeModelPin& left,const RuntimeModelPin& right) {
  return left==right;
}
}  // namespace ainvr::search
