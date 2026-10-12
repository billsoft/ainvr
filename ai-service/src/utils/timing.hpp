// 耗时统计工具 —— 对应 Python utils/timing.py。TimingStats::ToDict() 的
// 输出形状是 /api/v1/channels/{id} 和 /api/v1/stats 响应体 stats.timing.*
// 的一部分(外部 API 契约,不是内部实现细节),必须精确复刻:字段名、
// round(x,2) 的四舍五入位数、线性插值分位数算法都不能变。
#pragma once

#include <cstddef>
#include <deque>

#include <nlohmann/json_fwd.hpp>

namespace ai_service::utils {

class TimingStats {
 public:
  explicit TimingStats(size_t window_size = 100) : window_size_(window_size) {}

  void Add(double value_ms);

  size_t Count() const { return samples_.size(); }
  double Mean() const;
  double P50() const { return Percentile(50.0); }
  double P95() const { return Percentile(95.0); }

  // {"count", "mean_ms", "p50_ms", "p95_ms"},全部 round(x, 2)。
  nlohmann::json ToDict() const;

 private:
  double Percentile(double p) const;

  size_t window_size_;
  std::deque<double> samples_;
};

// 上下文管理器等价物 —— 记录一段代码的耗时(毫秒)。
class Timer {
 public:
  Timer();
  double ElapsedMs() const;

 private:
  long long start_ns_;
};

}  // namespace ai_service::utils
