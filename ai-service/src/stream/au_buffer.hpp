// AuDelayBuffer —— 拉流 / AI / 推流 三方解耦的自适应中间缓存。
// 逐函数对应 Python stream/au_buffer.py,这是全项目里最有含金量的一块
// (fork 盘点原话)。任何"顺手优化"都可能悄悄改掉行为——移植时严格保留:
//   1. on_miss(TOO_LATE) 和 evict 触发的 DROPPED 是两条独立调用路径,
//      绝不能合并成一个函数——混了会重新引入"存不下→抛帧→误判来晚→
//      调长延迟→更存不下"的正反馈死循环,这是已经修过一次的真实故障。
//   2. 弹性放行门槛 = max_delay 与容量上限的中点,必须严格夹在两者之间,
//      门槛排序错了延迟就形同虚设(Python 版写这段时真的踩过)。
//   3. 抛帧只从头部丢,有 I 帧就整段丢到它之前干净重同步。
#pragma once

#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <unordered_map>
#include <vector>

namespace ai_service::stream {

enum class StampResult {
  kStamped,
  // 包已经被推走了:推理来晚了 —— "延迟不够"的硬信号,应该调长
  kTooLate,
  // 包在溢出时被抛掉了:"存不下了"的信号,调长延迟只会更存不下
  // (正反馈死循环),绝不能据此调长
  kDropped,
  // 这个 PTS 从来没进过缓存(重连清空前的旧帧等)
  kUnknown,
};

struct ControllerStats {
  double delay_s = 0.0;
  int samples = 0;
  double p_target_s = 0.0;
  int64_t raise_events = 0;
  int64_t miss_events = 0;
  int64_t outliers = 0;
};

// 按实测的"打标滞后"自动调节缓存延迟。调节策略:涨得快、落得慢。
// 不依赖时钟,只由样本驱动 —— 可确定性单测。
class AdaptiveDelayController {
 public:
  static constexpr double kOutlierFactor = 4.0;

  explicit AdaptiveDelayController(double min_delay_s = 0.10, double max_delay_s = 3.0,
                                    double headroom = 1.4, size_t window = 240,
                                    double percentile = 0.95, double miss_growth = 1.3,
                                    double fall_rate = 0.04);

  // 记录一次成功打标的实际滞后。
  void on_stamp(double lag_s);

  // 推理来晚了(包已经被推走)→ 延迟明显不够,立刻按比例调长。
  // ⚠️ 只有 TOO_LATE 能调用这里,DROPPED 绝不能。
  void on_miss();

  double delay_s() const { return current_; }
  double max_delay_s() const { return max_delay_s_; }
  ControllerStats stats() const;

 private:
  double target_locked() const;

  double min_delay_s_;
  double max_delay_s_;
  double headroom_;
  size_t window_;
  double percentile_;
  double miss_growth_;
  double fall_rate_;

  std::deque<double> lags_;
  double current_;
  int64_t raise_events_ = 0;
  int64_t miss_events_ = 0;
  int64_t outliers_dropped_ = 0;
};

// 缓存里的一个编码包(H.264/H.265 的一个 AU)
struct BufferedAu {
  int64_t pts_ns = 0;
  int64_t dts_ns = 0;
  int64_t duration_ns = 0;
  std::vector<uint8_t> data;
  bool is_keyframe = false;
  // 到达时刻用单调钟,不用 PTS —— 原因见 Python 版注释:PTS 是内容时间轴,
  // 源管线重启会归零、长时间空洞会跳变。
  double arrived_mono = 0.0;
  bool stamped = false;
  std::optional<int64_t> generation = std::nullopt;
};

enum BufferLimitReason : uint32_t {
  kBufferBytes = 1,
  kBufferFrames = 2,
  kBufferAge = 4,
};

// 只保存最近一次现场,不保存包内容、不在缓存锁内写日志。
struct BufferEviction {
  uint32_t reasons = 0;
  double at_mono = 0.0;
  double oldest_age_s = 0.0;
  double hold_limit_s = 0.0;
  int64_t bytes_before = 0;
  int64_t frames_before = 0;
  int64_t removed = 0;
  bool resumed_at_keyframe = false;
  std::optional<int64_t> generation;
};

struct BufferStats {
  int level = 0;
  double held_s = 0.0;
  int64_t bytes = 0;
  int64_t put = 0;
  int64_t popped = 0;
  int64_t stamped = 0;
  int64_t too_late = 0;
  int64_t dropped = 0;
  int64_t drop_events = 0;
  int64_t byte_limit_events = 0;
  int64_t frame_limit_events = 0;
  int64_t age_limit_events = 0;
  int64_t generation_reset_events = 0;
  int64_t generation_reset_units = 0;
  std::optional<BufferEviction> last_eviction;
  int64_t unknown = 0;
  int64_t duplicate_pts = 0;
  ControllerStats controller;
};

using SeiTransform = std::function<std::vector<uint8_t>(const std::vector<uint8_t>&)>;

// 按 PTS 可寻址的自适应延迟缓存(线程安全)。
class AuDelayBuffer {
 public:
  explicit AuDelayBuffer(std::shared_ptr<AdaptiveDelayController> controller = nullptr,
                          double hold_factor = 1.6, int64_t max_bytes = 256 * 1024 * 1024,
                          int64_t max_frames = 8192);

  // ---- 拉流侧 ----
  void put(BufferedAu au);
  std::optional<double> seconds_since_last_put(double now_mono);

  // ---- 推理侧 ----
  StampResult stamp(int64_t pts_ns, const SeiTransform& transform, double now_mono,
                     std::optional<int64_t> generation = std::nullopt);

  // ---- 推流侧 ----
  std::optional<BufferedAu> pop_ready(double now_mono);

  // ---- 生命周期 / 诊断 ----
  void clear();
  BufferStats stats() const;
  size_t size() const;

  std::shared_ptr<AdaptiveDelayController> controller() const { return controller_; }

 private:
  static constexpr size_t kPtsMemory = 900;

  void clear_locked();
  void remove_index_locked(int64_t pts_ns);
  double hold_s_locked() const;
  double pressure_threshold_locked() const;
  void remember_gone_locked(int64_t pts_ns, StampResult reason);
  void evict_locked(double now_mono);
  bool over_capacity_locked(double now_mono, double hold_s) const;
  size_t find_resync_cut_locked() const;

  std::shared_ptr<AdaptiveDelayController> controller_;
  double hold_factor_;
  int64_t max_bytes_;
  int64_t max_frames_;

  mutable std::mutex mutex_;
  std::deque<BufferedAu> items_;                       // 按到达(解码)顺序
  std::unordered_map<int64_t, BufferedAu*> index_;      // nullptr = 歧义
  std::unordered_map<int64_t, int> pts_counts_;
  std::optional<int64_t> generation_;
  int64_t bytes_ = 0;
  std::unordered_map<int64_t, StampResult> gone_;       // pts_ns → 它是怎么没的
  std::deque<int64_t> gone_order_;
  std::optional<double> last_put_mono_;

  int64_t put_count_ = 0;
  int64_t popped_count_ = 0;
  int64_t stamped_count_ = 0;
  int64_t too_late_count_ = 0;
  int64_t dropped_count_ = 0;
  int64_t drop_events_ = 0;
  int64_t byte_limit_events_ = 0;
  int64_t frame_limit_events_ = 0;
  int64_t age_limit_events_ = 0;
  int64_t generation_reset_events_ = 0;
  int64_t generation_reset_units_ = 0;
  std::optional<BufferEviction> last_eviction_;
  int64_t unknown_count_ = 0;
  int64_t duplicate_pts_count_ = 0;
};

}  // namespace ai_service::stream
