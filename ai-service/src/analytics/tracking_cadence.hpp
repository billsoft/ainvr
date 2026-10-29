// AINVR. Runtime eligibility uses elapsed time, independent of frame rate.
#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <deque>
#include <cmath>
#include <algorithm>
namespace ai_service::analytics {
// Process-wide diagnostics: why tracking eligibility was reset (all channels).
enum class CadenceReset : size_t { Invalid, NotMonotonic, SourceGapOver1s, WallGapOver1s, TooManyIntervals, ReadyLost, Count };
inline std::array<std::atomic<uint64_t>,size_t(CadenceReset::Count)>& CadenceResetCounters() noexcept {
  static std::array<std::atomic<uint64_t>,size_t(CadenceReset::Count)> counters;return counters;
}
inline void CountCadenceReset(CadenceReset r) noexcept {CadenceResetCounters()[size_t(r)].fetch_add(1,std::memory_order_relaxed);}
class TrackingCadence {
 public:
  bool Observe(double source, double wall) {
    if (!std::isfinite(source)||!std::isfinite(wall)||source<0||wall<0) { CountCadenceReset(CadenceReset::Invalid);Reset(); return false; }
    if (last_source_ >= 0) {
      const double dt=std::max(source-last_source_,wall-last_wall_);
      if (source<=last_source_||wall<last_wall_||dt>1.0) {
        CountCadenceReset(source<=last_source_||wall<last_wall_?CadenceReset::NotMonotonic:
          source-last_source_>1.0?CadenceReset::SourceGapOver1s:CadenceReset::WallGapOver1s);
        Reset();
      }
      else {
        intervals_.push_back(dt);seconds_+=dt;
        // Retain at least two seconds, including the interval across its boundary.
        while(intervals_.size()>1 && seconds_-intervals_.front()>=2.0) {
          seconds_-=intervals_.front();intervals_.pop_front();
        }
        // Defensive bound for malformed/high-frequency timestamps: fail closed.
        if(intervals_.size()>4096) {CountCadenceReset(CadenceReset::TooManyIntervals);Reset();}
        else {
          const bool adequate=intervals_.size()>=6 && seconds_>=2.0-1e-9 &&
                              intervals_.size()/seconds_>=2.95;
          if(adequate){bad_seconds_=0;ready_=true;}
          else if(ready_){bad_seconds_+=dt;if(bad_seconds_>=1.0-1e-9){ready_=false;CountCadenceReset(CadenceReset::ReadyLost);}}
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
