// Tracking candidates remain separate from visible and archived detections.
#pragma once
#include "../output/result.hpp"
#include <cmath>
#include <map>
#include <tuple>
namespace ai_service::analytics {
inline void CopyTrackIdentities(const std::vector<Detection>& candidates,
                                std::vector<Detection>& visible) {
  using Key=std::tuple<std::string,int,double,double,double,double>;
  auto key=[](const Detection& d) {
    return Key{d.label_id,d.class_id,d.bbox[0],d.bbox[1],d.bbox[2],d.bbox[3]};
  };
  std::map<Key,std::string> identities;
  for(const auto& d:candidates) {
    bool valid=true;
    for(auto v:d.bbox) valid=valid&&std::isfinite(v);
    if(valid&&!d.track_id.empty()) identities.emplace(key(d),d.track_id);
  }
  for(auto& d:visible) {
    d.track_id.clear();
    bool valid=true;
    for(auto v:d.bbox) valid=valid&&std::isfinite(v);
    if(!valid) continue;
    auto found=identities.find(key(d));
    if(found!=identities.end()) d.track_id=found->second;
  }
}
}
