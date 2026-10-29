#pragma once
#include "sample_contract.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
namespace ainvr::search {
// Coordinates belong to the retained JPEG, not the observation or model input.
// raw-nv12-crop is an affine crop/scale, including tiny-canvas scaling. Unknown
// legacy/projection contracts omit the overlay instead of guessing a target.
inline std::optional<nlohmann::json> DisplayBBox(const Sample& sample) {
  if(sample.record.scene)return std::nullopt;
  const auto& e=sample.evidence;
  try {
    if(e.value("image_space","")!="raw-nv12-crop"||e.value("projection_mode","")!="raw_planar")return std::nullopt;
    const auto& crop=e.at("raw_source_rectangle");const auto& box=e.at("target").at("raw_bbox");
    if(!crop.is_array()||crop.size()!=4||!box.is_array()||box.size()!=4)return std::nullopt;
    const auto c=crop.get<std::array<double,4>>(),b=box.get<std::array<double,4>>();
    for(double v:c)if(!std::isfinite(v))return std::nullopt;
    for(double v:b)if(!std::isfinite(v))return std::nullopt;
    if(c[2]<=0||c[3]<=0||b[2]<=0||b[3]<=0)return std::nullopt;
    const double x=std::clamp((b[0]-c[0])/c[2],0.,1.),y=std::clamp((b[1]-c[1])/c[3],0.,1.);
    const double right=std::clamp((b[0]+b[2]-c[0])/c[2],0.,1.);
    const double bottom=std::clamp((b[1]+b[3]-c[1])/c[3],0.,1.);
    if(right<=x||bottom<=y)return std::nullopt;
    return nlohmann::json::array({x,y,right-x,bottom-y});
  }catch(const nlohmann::json::exception&){return std::nullopt;}
}
}
