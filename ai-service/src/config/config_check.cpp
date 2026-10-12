// Copyright AINVR. Offline deployment preflight; never echoes credentials.
#include "config_store.hpp"
#include <iostream>
#include <nlohmann/json.hpp>
int main(int argc,char** argv){
  if(argc!=2&&argc!=3){std::cerr<<"Usage: ainvr_config_check CONFIG.yaml [OVERLAY.json]\n";return 2;}
  try{
    std::filesystem::path base=argv[1];
    auto overlay=argc==3?std::filesystem::path(argv[2]):ai_service::config::DeriveOverlayPath(base);
    ai_service::config::ConfigStore store(base,overlay);auto config=store.Load();
    nlohmann::json channels=nlohmann::json::array();
    for(const auto& c:config.channels)channels.push_back({{"id",c.id},{"enabled",c.enabled},{"adapter",c.model.adapter},{"provider",c.model.provider}});
    std::cout<<nlohmann::json({{"configuration_valid",true},{"models_loaded",false},{"channels",channels}}).dump(2)<<"\n";return 0;
  }catch(const std::exception&){std::cerr<<"Configuration validation failed; check schema, model provider/format and file permissions.\n";return 1;}
}
