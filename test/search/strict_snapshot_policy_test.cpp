// Software-only negative-path checks. No GPU/JPU/BPU operation is executed.
#include "output/snapshot_renderer.hpp"
#include <iostream>
#include <stdexcept>
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
  std::cout<<"strict snapshot policy: configuration and unsupported-size rejection passed; no hardware executed\n";
}
