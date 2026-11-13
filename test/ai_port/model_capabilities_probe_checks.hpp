// Copyright AINVR. Pure smoke-probe checks; no image processing or inference.
#pragma once
#include "output/result.hpp"
#include <cmath>
#include <stdexcept>

namespace ainvr::capabilities_probe {
inline void Require(bool ok,const char* message) {
  if(!ok)throw std::runtime_error(message);
}
inline void AllFinite(const nlohmann::json& value) {
  if(value.is_number())Require(std::isfinite(value.get<double>()),"Non-finite result attribute");
  else if(value.is_structured())for(const auto& item:value)AllFinite(item);
}
inline nlohmann::json CheckDetections(const std::vector<ai_service::Detection>& detections,
    int width,int height,const std::vector<std::string>& classes,bool pose_model,
    const std::string& digest) {
  Require(width>0&&height>0,"Invalid source dimensions");
  size_t boxes_outside=0,points_outside=0,valid_points_outside=0,invalid_points=0,points=0,poses=0;
  auto invalid_samples=nlohmann::json::array();
  auto point=[&](double x,double y,bool valid=true) {
    Require(std::isfinite(x)&&std::isfinite(y),"Non-finite source point");
    ++points;if(!valid)++invalid_points;
    if(x<0||y<0||x>width||y>height) {++points_outside;if(valid)++valid_points_outside;}
  };
  for(const auto& d:detections) {
    Require(d.class_id>=0&&size_t(d.class_id)<classes.size()&&
        d.class_name==classes[size_t(d.class_id)],"Detection class differs from contract");
    Require(std::isfinite(d.confidence)&&d.confidence>=0&&d.confidence<=1,"Invalid confidence");
    for(double v:d.bbox)Require(std::isfinite(v),"Non-finite source bbox");
    const auto& b=d.bbox;
    if(b[0]<0||b[1]<0||b[2]<=0||b[3]<=0||b[0]+b[2]>width+1e-6||b[1]+b[3]>height+1e-6)++boxes_outside;
    AllFinite(d.model_extra);
    if(d.landmarks) {
      Require(!pose_model&&d.landmarks->size()==5,"Unexpected face landmarks");
      for(const auto& p:*d.landmarks)point(p[0],p[1]);
    }
    if(pose_model) {
      const auto& attributes=d.model_extra.at("attributes");
      const auto& p=attributes.at("pose");
      Require(p.at("schema_version")=="1.0"&&p.at("type")=="keypoints"&&
          p.at("status")=="observed"&&p.at("layout")=="coco17"&&
          p.at("coordinate_space")=="original_image"&&
          p.at("image_size")==nlohmann::json::array({width,height})&&
          p.at("source_model_sha256")==digest&&p.at("visibility_threshold")==0.5&&
          !p.contains("value"),"Pose attributes differ from source-image contract");
      Require(attributes.dump().size()<=2048,"Pose exceeds SEI attributes budget");
      const auto& keypoints=p.at("points");
      Require(keypoints.is_array()&&keypoints.size()==17,"Incomplete COCO17 skeleton");
      for(size_t index=0;index<keypoints.size();++index) {
        const auto& k=keypoints[index];
        const auto score=k.at("score").get<double>();
        Require(std::isfinite(score)&&score>=0&&score<=1,"Invalid pose visibility score");
        Require(k.at("visible").is_number_integer()&&k.at("visible")==int(score>=0.5),
            "Pose visible flag contradicts score");
        point(k.at("x").get<double>(),k.at("y").get<double>(),score>0);
        if(score==0&&invalid_samples.size()<8)
          invalid_samples.push_back({{"pose_index",poses},{"point_index",index},{"point",k}});
      }
      ++poses;
    }
  }
  return {{"all_finite",true},{"detections",detections.size()},{"poses",poses},
    {"points_checked",points},{"boxes_outside_source",boxes_outside},
    {"points_outside_source",points_outside},
    {"invalid_points",invalid_points},{"valid_points_outside_source",valid_points_outside},
    {"invalid_point_samples",invalid_samples},
    {"source_coordinate_bounds_valid",boxes_outside==0&&valid_points_outside==0},
    {"nonempty_detections",!detections.empty()}};
}
}
