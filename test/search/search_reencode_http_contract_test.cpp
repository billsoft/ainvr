// Synthetic bytes and metadata only. Never decode/load/run a device.
#include "api/search_reencode_http_contract.hpp"
#include <iostream>
using namespace ai_service::api;
using Json=nlohmann::json;
namespace {
size_t checks=0;
void Check(bool value,const char* message){++checks;if(!value)throw std::runtime_error(message);}
template<class F>void Reject(F run){bool rejected=false;try{run();}catch(const SearchReencodeInputError&){rejected=true;}Check(rejected,"invalid HTTP reencode accepted");}
}
int main(){try{
  const int64_t now=1793200000000;const std::string jpeg{"\xff\xd8\x07\x08\xff\xd9",6};
  const Json target{{"package_id","siglip2-base-full-int8"},{"package_sha256",std::string(64,'b')},{"model_version","search-v1-"+std::string(64,'b')}};
  const Json valid{{"schema_version","search-reencode-image-v1"},{"request_id","10000000-0000-4000-8000-000000000001"},
    {"job_id","10000000-0000-4000-8000-000000000002"},{"generation",1},{"payload_fingerprint",std::string(64,'a')},
    {"target",target},{"sample_id","10000000-0000-4000-8000-000000000003"},{"source_fingerprint",std::string(64,'c')},
    {"jpeg_sha256",ainvr::search::SampleSha256(jpeg)},{"expires_ms",now+20000}};
  Check(ReadSearchReencodeHttpRequest(valid.dump(),jpeg,now)==valid,"valid request changed");
  for(const auto& [key,value]:valid.items()) {
    (void)value;auto missing=valid;missing.erase(key);Reject([&]{ReadSearchReencodeHttpRequest(missing.dump(),jpeg,now);});
  }
  for(int change=0;change<16;++change){auto bad=valid;
    switch(change){case 0:bad["extra"]=true;break;case 1:bad["schema_version"]="other";break;
      case 2:bad["request_id"]="bad-id";break;case 3:bad["generation"]=0;break;case 4:bad["generation"]=-1;break;
      case 5:bad["generation"]=1.5;break;case 6:bad["generation"]=9007199254740992ULL;break;
      case 7:bad["payload_fingerprint"]=std::string(64,'X');break;case 8:bad["target"]["package_id"]="../model";break;
      case 9:bad["target"]["package_sha256"]=std::string(64,'a');break;case 10:bad["target"]["path"]="/tmp/model";break;
      case 11:bad["jpeg_sha256"]=std::string(64,'d');break;case 12:bad["expires_ms"]=now;break;
      case 13:bad["expires_ms"]=now+30001;break;case 14:bad["expires_ms"]=true;break;case 15:bad["target"]=nullptr;break;}
    Reject([&]{ReadSearchReencodeHttpRequest(bad.dump(),jpeg,now);});
  }
  auto duplicate=valid.dump();duplicate.insert(1,"\"generation\":2,");Reject([&]{ReadSearchReencodeHttpRequest(duplicate,jpeg,now);});
  Reject([&]{ReadSearchReencodeHttpRequest(std::string(2049,' '),jpeg,now);});
  Reject([&]{ReadSearchReencodeHttpRequest(valid.dump()+"\n",jpeg,now);});
  Reject([&]{ReadSearchReencodeHttpRequest("[[[[[[1]]]]]]",jpeg,now);});
  Reject([&]{ReadSearchReencodeHttpRequest(valid.dump(),std::string(kSearchReencodeMaxImageBytes+1,'a'),now);});
  auto corrupted=jpeg;corrupted[2]=char(9);Reject([&]{ReadSearchReencodeHttpRequest(valid.dump(),corrupted,now);});
  Check(ReadSearchReencodeHttpRequest(valid.dump(),jpeg,now+19999)==valid,"positive short TTL lost");
  std::cout<<"reencode HTTP boundary pure checks: "<<checks<<" passed; no codec/SDK access\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
