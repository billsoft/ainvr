// Independent Python hashlib/json golden values preserve pre-extraction HW IDs.
#include "sample_contract.hpp"
#include <iostream>
using namespace ainvr::search;
using Json=nlohmann::json;
void Check(bool ok){if(!ok)throw std::runtime_error("storage_uuid_golden_mismatch");}
int main(){try{
 const std::string input="00000000-0000-4000-8000-000000000001",output="00000000-0000-4000-8000-000000000002";
 const auto common=Json::array({input,output,"processor","session-1"});auto frame=common;frame.push_back(1000000000);frame.push_back(1);frame.push_back(8);frame.push_back(4);
 Check(SampleStorageUuid("ainvr-search-frame-v1",frame)=="cdc0cb58-9554-894c-9a18-bd7a7d15ed4d");
 auto slot=common;slot.push_back("model-v1");slot.push_back("track-7");slot.push_back(0);
 Check(SampleStorageUuid("ainvr-search-slot-v1",slot)=="6647e67a-6fa1-8ae9-8981-6a2724705d0c");
 auto scene=common;scene.push_back("model-v1");scene.push_back(1000000000);scene.push_back(1);
 Check(SampleStorageUuid("ainvr-search-scene-v1",scene)=="25377edf-cf36-86b7-9f97-bb7835afc1bc");
 auto refresh=Json::array({std::string(64,'a'),std::string(64,'b'),"siglip2-base-full-int8","search-v1-"+std::string(64,'d'),input,"2026-10-28",123});
 Check(SampleStorageUuid("ainvr-search-index-refresh-v1",refresh)=="0ed9bfeb-0727-8c22-b459-165a8afd9e82");
 for(const auto& domain:std::vector<std::string>{"","bad\ndomain",std::string(129,'a')}){
  bool refused=false;try{SampleStorageUuid(domain,common);}catch(const std::invalid_argument&){refused=true;}Check(refused);
 }
 bool refused=false;try{SampleStorageUuid("valid",std::string(16385,'a'));}catch(const std::invalid_argument&){refused=true;}Check(refused);
 std::cout<<"8 shared UUID golden/bound checks passed; HW identities unchanged\n";return 0;
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
