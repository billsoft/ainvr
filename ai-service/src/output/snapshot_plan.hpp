// Copyright AINVR. Pure geometry; no Jetson, CUDA or OpenCV dependencies.
#pragma once
#include "config/config.hpp"
#include <array>
#include <optional>
namespace ainvr {
struct SnapshotPlan {
  bool perspective=false,replicate_edges=false;
  int width=0,height=0;
  std::array<double,4> source_rectangle{};
  double center_x=0,center_y=0,yaw=0,pitch=0,horizontal_fov=0;
};
// Invalid detections produce nullopt; invalid configuration throws. Keeps the
// reference output dimensions, including odd/small outputs. Encoding policy is
// deliberately separate and must not silently change this field of view.
std::optional<SnapshotPlan> PlanSnapshot(const std::array<double,4>& bbox,
    int source_width,int source_height,const ai_service::config::SnapshotConfig& config,bool square);
}
