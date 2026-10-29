// Pure plan policy: reuse PlanSnapshot and retain its source rectangle/FOV.
#pragma once
#include "output/snapshot_plan.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>
namespace ai_service::output {
inline ainvr::SnapshotPlan SearchHardwarePlan(const std::array<double,4>& bbox,int width,int height,
    bool scene,int maximum,double padding){
  if(maximum<18||maximum>4096||!std::isfinite(padding)||padding<0||padding>1)
    throw std::invalid_argument("search_hardware_plan_options_invalid");
  config::SnapshotConfig cfg;cfg.enabled=true;cfg.max_crop_dimension=maximum;cfg.padding_ratio=scene?0:padding;
  auto plan=ainvr::PlanSnapshot(scene?std::array<double,4>{0,0,double(width),double(height)}:bbox,width,height,cfg,false);
  if(!plan||plan->perspective)throw std::runtime_error("search_hardware_plan_unavailable");
  // Explicit encoding canvas scaling only. No invented image detail and no
  // reverse change to raw FOV; vision squashes this same raw ROI to 256x256.
  plan->width=std::max(18,(plan->width+1)&~1);plan->height=std::max(18,(plan->height+1)&~1);
  return *plan;
}
}
