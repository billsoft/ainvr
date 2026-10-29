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
}  // namespace ainvr::llm
