// Copyright AINVR. Attest a completed source frame, never inferred wall-clock coverage.
#pragma once
#include "../output/result.hpp"
namespace ai_service::analytics {
inline nlohmann::json RegionObservationCapabilities(const FrameResult& result) {
  using nlohmann::json;
  json capabilities=json::object();
  const auto& extra=result.model_extra;
  if(!extra.contains("label_catalog"))return capabilities;
  const auto& catalog=extra.at("label_catalog");
  const auto adapter=catalog.value("adapter",std::string());
  if(adapter=="analysis_pipeline"&&(!extra.contains("analysis_pipeline")||
      !extra.at("analysis_pipeline").value("complete",false)))return capabilities;
  const bool pose=catalog.contains("attributes")&&catalog.at("attributes").contains("pose");
  auto add=[&](const char* kind,const json& id){
    if(!capabilities.contains(kind))capabilities[kind]={{"state","valid"},
      {"source_pts_ns",std::to_string(result.frame_pts_ns)},{"label_ids",json::array()}};
    capabilities[kind]["label_ids"].push_back(id);
  };
  for(const auto& label:catalog.at("labels")){
    const auto source=label.value("source_adapter",adapter);
    const auto name=label.value("name",std::string());
    if(source=="yolo26_bpu"){
      if(name=="fire"||name=="smoke")add("fire_smoke",label.at("label_id"));
      // Generic face/head is not evidence of PPE noncompliance.
      if(name=="no_helmet")add("helmet_violation",label.at("label_id"));
    }
    if(pose&&name=="person"&&(source=="yolo26_bpu"||source=="yolo26_pose_bpu"))
      add("suspected_down",label.at("label_id"));
  }
  if(capabilities.contains("suspected_down")&&extra.contains("analysis_pipeline")){
    const auto& pipeline=extra.at("analysis_pipeline");
    bool unresolved=pipeline.value("unassociated_omitted",size_t(0))>0;
    if(pipeline.contains("unassociated_observations"))for(const auto& observation:pipeline.at("unassociated_observations"))
      unresolved=unresolved||(observation.contains("attributes")&&observation.at("attributes").contains("pose"));
    // A detected auxiliary person with no unambiguous owner is not proof of
    // absence. Never clear a region episode merely because fusion discarded it.
    if(unresolved){capabilities["suspected_down"]["state"]="unknown";capabilities["suspected_down"]["reason"]="ambiguous_pose_association";}
  }
  return capabilities;
}
}
