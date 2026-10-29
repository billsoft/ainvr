// Raw-JPEG control-plane boundary. No decoder, SDK, HTTP transport or file I/O.
#pragma once
#include "../../../search-service/src/model_pin.hpp"
#include "../../../search-service/src/sample_contract.hpp"
#include <set>
namespace ai_service::api {
inline constexpr size_t kSearchReencodeMaxImageBytes=8*1024*1024;
class SearchReencodeInputError:public std::invalid_argument {
 public:
  explicit SearchReencodeInputError(bool expired=false):std::invalid_argument(expired?
    "search_reencode_expired":"invalid_search_reencode_request"),expired(expired){}
  bool expired;
};
inline nlohmann::json ReadSearchReencodeHttpRequest(const std::string& header,const std::string& jpeg,int64_t now_ms) {
  using Json=nlohmann::json;
  const auto invalid=[](){throw SearchReencodeInputError();};
  if(header.empty()||header.size()>2048||jpeg.size()<4||jpeg.size()>kSearchReencodeMaxImageBytes||now_ms<0)invalid();
  for(unsigned char c:header)if(c<32||c>126)invalid();
  try {
    std::vector<std::set<std::string>> keys;
    auto value=Json::parse(header,[&](int depth,Json::parse_event_t event,Json& parsed){
      if(depth>4)throw SearchReencodeInputError();
      if(event==Json::parse_event_t::object_start)keys.emplace_back();
      else if(event==Json::parse_event_t::key) {
        if(keys.empty()||!keys.back().insert(parsed.get<std::string>()).second)throw SearchReencodeInputError();
      }else if(event==Json::parse_event_t::object_end)keys.pop_back();
      return true;
    });
    const std::set<std::string> fields{"schema_version","request_id","job_id","generation","payload_fingerprint",
      "target","sample_id","source_fingerprint","jpeg_sha256","expires_ms"};
    if(!value.is_object()||value.size()!=fields.size())invalid();
    for(const auto& key:fields)if(!value.contains(key))invalid();
    if(value.at("schema_version")!="search-reencode-image-v1")invalid();
    const auto text=[&](const Json& parent,const char* key)->std::string {
      if(!parent.at(key).is_string())invalid();
      return parent.at(key).template get<std::string>();
    };
    for(const auto* key:{"request_id","job_id","sample_id"})if(!std::regex_match(text(value,key),
      std::regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")))invalid();
    for(const auto* key:{"payload_fingerprint","source_fingerprint","jpeg_sha256"})
      if(!std::regex_match(text(value,key),std::regex("[a-f0-9]{64}")))invalid();
    const auto positive=[&](const char* key)->int64_t {
      const auto& v=value.at(key);
      if(!v.is_number_integer())invalid();
      if(v.is_number_unsigned()){const auto n=v.template get<uint64_t>();if(n<1||n>9007199254740991ULL)invalid();return int64_t(n);}
      const auto n=v.template get<int64_t>();if(n<1||n>9007199254740991LL)invalid();return n;
    };
    (void)positive("generation");const auto expires=positive("expires_ms");
    if(expires<=now_ms||expires-now_ms>30000)throw SearchReencodeInputError(true);
    const auto& target=value.at("target");
    if(!target.is_object()||target.size()!=3||!target.contains("package_id")||!target.contains("package_sha256")||!target.contains("model_version"))invalid();
    if(!ainvr::search::ValidRuntimeModelPin({text(target,"package_id"),text(target,"package_sha256"),text(target,"model_version")}))invalid();
    if(uint8_t(jpeg[0])!=255||uint8_t(jpeg[1])!=216||uint8_t(jpeg[jpeg.size()-2])!=255||uint8_t(jpeg.back())!=217||
        ainvr::search::SampleSha256(reinterpret_cast<const uint8_t*>(jpeg.data()),jpeg.size())!=text(value,"jpeg_sha256"))invalid();
    return value;
  }catch(const Json::exception&){invalid();}
  throw SearchReencodeInputError();
}
}  // namespace ai_service::api
