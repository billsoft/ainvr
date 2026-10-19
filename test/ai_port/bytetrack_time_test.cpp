#include "BYTETracker.h"
#include <cassert>
#include <stdexcept>
int main() {
  BYTETracker tracker(10, 30);
  Object person{cv::Rect_<float>(100,100,40,80),0,0.9f};
  auto first=tracker.update_at({person},0,2);
  assert(first.size()==1);
  auto id=first[0].track_id;
  assert(tracker.update_at({person},0.1,2)[0].track_id==id);
  assert(tracker.update_at({},0.5,2).empty());
  assert(tracker.update_at({person},1.5,2)[0].track_id==id);
  bool rejected=false;
  try { tracker.update_at({person},1.5,2); }
  catch(const std::invalid_argument&) {rejected=true;}
  assert(rejected);
  // Even an actively tracked object expires across a source-time gap.
  assert(tracker.update_at({person},4.0,2).empty());
  auto fresh=tracker.update_at({person},4.1,2);
  assert(fresh.size()==1 && fresh[0].track_id!=id);
  // Constant-velocity mean follows elapsed time, not number of calls.
  byte_kalman::KalmanFilter filter;
  DETECTBOX box; box << 100,100,0.5,80;
  auto state=filter.initiate(box);
  state.first(4)=2;
  filter.set_time_step(3);
  filter.predict(state.first,state.second);
  assert(std::abs(state.first(0)-106)<0.001);
}
