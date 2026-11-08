#pragma once
#include <chrono>
#include <cmath>
#include <deque>
#include <utility>

namespace ainvr::llm {
using SubmissionClock = std::chrono::steady_clock;
using SubmissionHistory =
    std::deque<std::pair<SubmissionClock::time_point, double>>;

// Completed SDK task wait time in the trailing ten seconds. This deliberately
// preserves the service's existing accounting: it is not an estimate of future
// task cost or a guarantee that an individual task cannot overshoot the share.
inline bool SubmissionAllowed(SubmissionHistory& history,
                              SubmissionClock::time_point now,
                              double cap_percent) {
  if (!std::isfinite(cap_percent) || cap_percent < 5 || cap_percent > 90 ||
      std::floor(cap_percent) != cap_percent)
    return false;
  while (!history.empty() &&
         now - history.front().first >= std::chrono::seconds(10))
    history.pop_front();
  double used = 0;
  for (const auto& item : history) {
    if (item.first > now || !std::isfinite(item.second) || item.second < 0)
      return false;
    used += item.second;
  }
  return std::isfinite(used) && used < cap_percent * .1;
}
// Spread the allowance across completed tasks instead of spending the entire
// ten-second budget in a burst. Accounted time includes SDK queue waiting;
// this is conservative pacing, not a claim of measured BPU occupancy.
inline bool PacedSubmissionAllowed(SubmissionHistory& history,
                                  SubmissionClock::time_point now,
                                  double cap_percent) {
  if(!std::isfinite(cap_percent)||cap_percent<5||cap_percent>90||
     std::floor(cap_percent)!=cap_percent)return false;
  if(!history.empty()) {
    const auto& last=history.back();
    if(last.first>now||!std::isfinite(last.second)||last.second<0)return false;
    const double quiet=last.second*(100.0/cap_percent-1.0);
    // Do not prune the last completion while a long cooldown is still pending.
    if(!std::isfinite(quiet)||std::chrono::duration<double>(now-last.first).count()+1e-9<quiet)return false;
  }
  return SubmissionAllowed(history,now,cap_percent);
}
}  // namespace ainvr::llm
