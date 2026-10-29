// Software-only negative-path checks. No GPU/JPU/BPU operation is executed.
#include "output/snapshot_renderer.hpp"
#include <iostream>
#include <stdexcept>
#include <limits>
using namespace ainvr;
void Check(bool condition) { if (!condition) throw std::runtime_error("strict_snapshot_assertion"); }
template<class F> void Reject(F fn, const char* code) {
  try { fn(); } catch (const std::exception& error) { Check(std::string(error.what())==code); return; }
  throw std::runtime_error("strict_snapshot_not_rejected");
}
int main() {
  Reject([]{SnapshotRenderer unused({false,true,false},SnapshotEncodingPolicy::HardwareOnly);},
    "snapshot_hardware_policy_requires_hardware");
  Reject([]{SnapshotRenderer unused({true,true,true},SnapshotEncodingPolicy::HardwareOnly);},
    "snapshot_hardware_policy_requires_hardware");
  SnapshotRenderer strict({},SnapshotEncodingPolicy::HardwareOnly);
  Nv12Frame frame; frame.width=640;frame.height=320;
  ai_service::config::SnapshotConfig cfg;cfg.padding_ratio=0;cfg.max_crop_dimension=320;
  Check(!strict.RenderOriginal(frame,{0,0,21,19},cfg,false,true,false));
  cfg.enabled=true;
  Check(!strict.RenderOriginal(frame,{0,0,0,20},cfg,false,true,false));
  for (auto box : {std::array<double,4>{10,10,21,19},std::array<double,4>{10,10,2,2}})
    Reject([&]{strict.RenderOriginal(frame,box,cfg,false,true,false);},"snapshot_hardware_dimensions_unsupported");
  SnapshotPlan explicit_plan;explicit_plan.width=21;explicit_plan.height=19;explicit_plan.source_rectangle={10,10,21,19};
  Reject([&]{strict.RenderPlanned(frame,explicit_plan,85,true,false);},"snapshot_hardware_dimensions_unsupported");
  explicit_plan.width=explicit_plan.height=2;
  Reject([&]{strict.RenderPlanned(frame,explicit_plan,85,true,false);},"snapshot_hardware_dimensions_unsupported");
  explicit_plan.width=explicit_plan.height=18;
  Reject([&]{strict.RenderPlanned(frame,explicit_plan,0,true,false);},"Invalid explicit snapshot plan");
  // A real ERP plan intentionally has no planar rectangle. Empty pixels make
  // the existing preprocessor reject before any GPU/JPU allocation, proving
  // that both public paths accept its geometry without executing hardware.
  cfg.projection_mode="erp_equirect";
  const std::array<double,4> erp_box{300,140,40,40};
  const auto erp=PlanSnapshot(erp_box,frame.width,frame.height,cfg,false);
  Check(erp&&erp->perspective&&erp->source_rectangle==std::array<double,4>{});
  const auto size_error=erp->width<18||erp->height<18||erp->width%2||erp->height%2 ?
    "snapshot_hardware_dimensions_unsupported":"Invalid NV12 input or output dimensions";
  Reject([&]{strict.RenderOriginal(frame,erp_box,cfg,false,true,false);},size_error);
  auto projected=*erp;projected.width=projected.height=18;
  Reject([&]{strict.RenderPlanned(frame,projected,85,true,false);},"Invalid NV12 input or output dimensions");
  for(int field=0;field<5;++field){
    auto invalid=projected;
    if(field==0)invalid.yaw=std::numeric_limits<double>::quiet_NaN();
    if(field==1)invalid.pitch=std::numeric_limits<double>::infinity();
    if(field==2)invalid.horizontal_fov=0;
    if(field==3)invalid.horizontal_fov=3.14159265358979323846;
    if(field==4)invalid.horizontal_fov=std::numeric_limits<double>::quiet_NaN();
    Reject([&]{strict.RenderPlanned(frame,invalid,85,true,false);},"Invalid explicit snapshot plan");
  }
  auto planar=projected;planar.perspective=false;
  Reject([&]{strict.RenderPlanned(frame,planar,85,true,false);},"Invalid explicit snapshot plan");
  std::cout<<"strict snapshot policy: configuration and unsupported-size rejection passed; no hardware executed\n";
}
