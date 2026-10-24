// AINVR. Runtime eligibility uses elapsed time, independent of frame rate.
#pragma once
#include <deque>
#include <cmath>
#include <algorithm>
namespace ai_service::analytics {
class TrackingCadence {
 public:
  bool Observe(double source, double wall) {
    if (!std::isfinite(source)||!std::isfinite(wall)||source<0||wall<0) { Reset(); return false; }
    if (last_source_ >= 0) {
      const double dt=std::max(source-last_source_,wall-last_wall_);
      if (source<=last_source_||wall<last_wall_||dt>1.0) Reset();
      else {
        intervals_.push_back(dt);seconds_+=dt;
        // Retain at least two seconds, including the interval across its boundary.
        while(intervals_.size()>1 && seconds_-intervals_.front()>=2.0) {
          seconds_-=intervals_.front();intervals_.pop_front();
        }
        // Defensive bound for malformed/high-frequency timestamps: fail closed.
        if(intervals_.size()>4096) Reset();
        else {
          const bool adequate=intervals_.size()>=6 && seconds_>=2.0-1e-9 &&
                              intervals_.size()/seconds_>=2.95;
          if(adequate){bad_seconds_=0;ready_=true;}
          else if(ready_){bad_seconds_+=dt;if(bad_seconds_>=1.0-1e-9)ready_=false;}
        }
      }
    }
    last_source_=source;last_wall_=wall;
    return ready_;
  }
  void Reset(){intervals_.clear();seconds_=bad_seconds_=0;last_source_=last_wall_=-1;ready_=false;}
 private:
  bool ready_=false;
  std::deque<double> intervals_;
  double seconds_=0,bad_seconds_=0,last_source_=-1,last_wall_=-1;
};
}
