// Copyright AINVR. Catalog identities match the detector and tracker fallback.
#pragma once
#include "config/config.hpp"
#include <nlohmann/json.hpp>
namespace ai_service::adapters {
inline nlohmann::json RuntimeLabelCatalog(const config::ModelConfig& cfg,
                                         const std::vector<std::string>& loaded_names) {
  auto labels=nlohmann::json::array();
  const bool yoloe=cfg.adapter=="yoloe_bpu",locate=cfg.adapter=="locateanything_bpu";
  if((yoloe||locate)&&!cfg.prompts.empty()) {
    for(size_t i=0;i<cfg.prompts.size();++i){
      const auto& p=cfg.prompts[i];
      labels.push_back({{"class_id",i},{"label_id",p.label_id.empty()?"class:"+std::to_string(i):p.label_id},
        {"name",locate&&p.label_name.empty()?p.description:p.label_name},{"description",p.description}});
    }
  } else if(locate) {
    labels.push_back({{"class_id",0},{"label_id",cfg.label_id.empty()?"class:0":cfg.label_id},
      {"name",cfg.label_name.empty()?cfg.description:cfg.label_name},{"description",cfg.description}});
  } else {
    for(size_t i=0;i<loaded_names.size();++i){
      std::string id="class:"+std::to_string(i),name=loaded_names[i];
      if(yoloe&&!cfg.label_id.empty())id=cfg.label_id+(loaded_names.size()>1?":"+std::to_string(i):"");
      if(yoloe&&loaded_names.size()==1&&!cfg.label_name.empty())name=cfg.label_name;
      labels.push_back({{"class_id",i},{"label_id",id},{"name",name},
        {"description",yoloe?loaded_names[i]:std::string()}});
    }
  }
  nlohmann::json catalog={{"schema_version","1.0"},{"adapter",cfg.adapter},{"labels",labels}};
  // Person remains one detection label. Keypoints are an attached observation,
  // never 17 labels or a second face-landmark channel.
  if(cfg.adapter=="yolo26_pose_bpu")catalog["attributes"]={{"pose",{
      {"schema_version","1.0"},{"type","keypoints"},{"layout","coco17"},
      {"count",17},{"coordinate_space","original_image"},{"point_fields",{"x","y","score"}}}}};
  return catalog;
}
}