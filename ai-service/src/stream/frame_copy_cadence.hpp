#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
namespace ai_service::stream {
class FrameCopyCadence {
 public:
 bool Keep(int64_t pts,double rate){
  if(!std::isfinite(rate)||rate<=0){last_=-1;rate_=0;next_=0;return true;}
  const long double interval=1e9L/rate;
  if(last_<0||rate!=rate_||pts<=last_){last_=pts;rate_=rate;next_=static_cast<long double>(pts)+interval;return true;}
  // Container timestamps are whole milliseconds (33/34/33 ms): a frame up to
  // 2 ms ahead of its slot still takes it. A 1 ns allowance dropped 1 in 3
  // frames of a 30 FPS RTMP source copied at 30 FPS.
  if(static_cast<long double>(pts)<next_-std::min(interval/4,2e6L))return false;
  // Preserve phase on fractional source/target ratios: a 10 FPS source must
  // deliver 4 FPS as alternating 200/300 ms gaps, not round down to 3.33 FPS.
  // Skip elapsed slots in O(1); never copy one frame repeatedly to catch up.
  const auto slots=std::max(1.0L,std::floor((static_cast<long double>(pts)-next_)/interval)+1);
  next_+=slots*interval;last_=pts;return true;
 }
 private:int64_t last_=-1;double rate_=0;long double next_=0;
};
}