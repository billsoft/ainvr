#include "config_center.hpp"
#include <iostream>
using Json=nlohmann::json;
int checks=0;
void Check(bool condition){++checks;if(!condition)throw std::runtime_error("search_configuration_contract_failed");}
template<class F> void Reject(F action){bool failed=false;try{action();}catch(...){failed=true;}Check(failed);}
Json Config(){return {{"enabled",true},{"listen",{{"host","127.0.0.1"},{"port",8300}}},
  {"model",{{"package_id","qwen3vl-4b-review-v3"},{"load_policy","resident"}}},
  {"api_keys",Json::array({{{"name","search-verify"},{"scope","inference"},{"key",std::string(48,'s')}}})},
  {"admin_key",std::string(48,'a')},{"tasks",{{"alarm-review-zh-v1",{{"calibration_temperature",2.0},{"aspect_policy","reject"}}}}},
  {"scheduling",{{"queue_size",8},{"queue_timeout_s",30},{"exec_timeout_s",10},{"submit_time_share_cap_percent",90},{"prefill_profile","s256"}}}};}
int main(){try{
  auto old=Config();const auto compatible=ainvr::llm::NormalizeSettings(old,1);
  Check(compatible.at("search_verify_enabled")==true&&compatible.at("calibration_temperature")==2.0);
  old["tasks"]["search-verify-zh-v1"]={{"enabled",false},{"aspect_policy","letterbox"},{"decision_policy","abc-visible-v1"}};
  const auto disabled=ainvr::llm::NormalizeSettings(old,2);
  Check(disabled.at("search_verify_enabled")==false&&disabled.at("calibration_temperature")==2.0);
  old["tasks"]["search-verify-zh-v1"]["enabled"]=true;
  Check(ainvr::llm::NormalizeSettings(old,3).at("search_verify_enabled")==true);
  for(int n=0;n<5;++n){auto bad=old;auto& search=bad["tasks"]["search-verify-zh-v1"];
    if(n==0)search["enabled"]=1;
    if(n==1)search["aspect_policy"]="reject";
    if(n==2)search["decision_policy"]="alarm";
    if(n==3)search["threshold"]=.99;
    if(n==4)search.erase("enabled");
    Reject([&]{ainvr::llm::NormalizeSettings(bad,4);});
  }
  Check(ainvr::llm::NormalizeSettings(old,5).at("package_root")==compatible.at("package_root"));
  std::cout<<checks<<" search configuration checks passed\n";
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
