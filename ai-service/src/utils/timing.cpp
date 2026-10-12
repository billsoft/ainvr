#include "timing.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <vector>

#include <nlohmann/json.hpp>

namespace ai_service::utils {

namespace {
double RoundTo(double v, int decimals) {
  double f = std::pow(10.0, decimals);
  return std::round(v * f) / f;
}
}  // namespace

void TimingStats::Add(double value_ms) {
  samples_.push_back(value_ms);
  if (samples_.size() > window_size_) samples_.pop_front();
}

double TimingStats::Mean() const {
  if (samples_.empty()) return 0.0;
  double sum = 0.0;
  for (double v : samples_) sum += v;
  return sum / static_cast<double>(samples_.size());
}

// 线性插值分位数,跟 Python 版 _percentile 算法逐行对应(不是就近取整)。
double TimingStats::Percentile(double p) const {
  if (samples_.empty()) return 0.0;
  std::vector<double> sorted(samples_.begin(), samples_.end());
  std::sort(sorted.begin(), sorted.end());
  double k = static_cast<double>(sorted.size() - 1) * (p / 100.0);
  size_t f = static_cast<size_t>(k);
  size_t c = (f + 1 < sorted.size()) ? f + 1 : f;
  return sorted[f] + (sorted[c] - sorted[f]) * (k - static_cast<double>(f));
}

nlohmann::json TimingStats::ToDict() const {
  return nlohmann::json{
      {"count", Count()},
      {"mean_ms", RoundTo(Mean(), 2)},
      {"p50_ms", RoundTo(P50(), 2)},
      {"p95_ms", RoundTo(P95(), 2)},
  };
}

Timer::Timer()
    : start_ns_(std::chrono::duration_cast<std::chrono::nanoseconds>(
                    std::chrono::steady_clock::now().time_since_epoch())
                    .count()) {}

double Timer::ElapsedMs() const {
  long long now_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
                          std::chrono::steady_clock::now().time_since_epoch())
                          .count();
  return static_cast<double>(now_ns - start_ns_) / 1'000'000.0;
}

}  // namespace ai_service::utils
