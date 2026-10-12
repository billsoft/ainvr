// Copyright AINVR.
#pragma once
#include "snapshot_plan.hpp"
#include "platform/gles_preprocess.hpp"
namespace ainvr {
// Frame color metadata remains explicit. Geometry never silently rounds the
// output to a codec's alignment; the encoder must handle that independently.
inline ImageTransform SnapshotTransform(const SnapshotPlan& plan, bool bt709,
                                        bool full_range) {
  ImageTransform t;
  t.width=plan.width;t.height=plan.height;t.letterbox=false;
  t.yuv_bt709=bt709;t.yuv_full_range=full_range;
  t.mean={0,0,0};t.divisor={1,1,1};t.bgr=false;
  t.erp_perspective=plan.perspective;
  if(plan.perspective){t.yaw=plan.yaw;t.pitch=plan.pitch;t.horizontal_fov=plan.horizontal_fov;}
  else {std::array<float,4> r{};for(int i=0;i<4;++i)r[i]=plan.source_rectangle[i];t.source_region=r;}
  return t;
}
}  // namespace ainvr
