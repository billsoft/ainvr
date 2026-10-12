// 推理线程跳过的帧分两类计:按设定帧率的正常抽帧,和算力跟不上的过载丢帧。
//
// 捕获线程只保留最新一帧,推理线程每次取帧时跳过的帧数 = 两次取帧之间
// 到达的帧数 - 1。源 30fps、推理 15fps 时平均每次跳 1 帧,这是"按设定帧率
// 抽帧",不是丢帧。
//
// 只看跳帧数分不出"算力不够"和"源流抖动":4K 源的帧到达是突发的(生产实测
// 取帧等待 p95 82ms),GPU 只忙 57% 时逐次跳帧数也会 0~3 不等。所以过载的
// 判据是推理本身跟不上节拍——上一帧推理耗时已经超过推理间隔(跟随源流时
// 是超过源帧间隔),这时超出正常抽帧的那部分跳帧才算过载丢帧。
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace ai_service::pipeline {

// Count only decoded frames superseded during archive admission, bounded by
// the actual skipped total (startup and stream resets can change sequence).
inline int64_t ArchiveAdmissionSkips(int64_t before, int64_t picked, int64_t skipped) {
  return before < 0 ? 0 : std::clamp<int64_t>(picked - before, 0, std::max<int64_t>(0, skipped));
}

struct SkipSplit {
  int64_t sampled = 0;
  int64_t overload = 0;
};

// Preserve the configured average cadence across ordinary per-frame jitter.
// After a long stall discard old schedule debt, without adding another idle
// interval. Resetting to actual start on every frame would under-run the target
// even when alternating fast/slow frames fit its average processing budget.
inline double NextInferenceDeadline(double scheduled, double finished, double interval) {
  if (interval <= 0) return finished;
  return finished - scheduled > interval * 2 ? finished : scheduled + interval;
}

// interval_s:推理间隔(1/inference_fps);0 表示跟随源流(每帧都该推理)。
// last_infer_s:上一帧推理(预处理+推理+后处理)实际耗时。
// source_fps 未知(<=0,刚启动还没测出来)时不判过载,避免误报。
inline SkipSplit SplitSkipped(int64_t skipped, double source_fps, double interval_s,
                              double last_infer_s) {
  if (skipped <= 0) return {};
  if (source_fps <= 0.0) return {skipped, 0};
  double pace_s = interval_s > 0.0 ? interval_s : 1.0 / source_fps;
  if (last_infer_s < pace_s) return {skipped, 0};  // 推理跟得上节拍:跳帧是抽帧/到达突发
  auto expected = interval_s > 0.0
                      ? static_cast<int64_t>(std::llround(std::max(0.0, source_fps * interval_s - 1.0)))
                      : int64_t{0};
  int64_t sampled = std::min(skipped, expected);
  return {sampled, skipped - sampled};
}

// 实际能达到的目标帧率:设定值不可能超过源帧率;0 = 跟随源流。
inline double EffectiveTargetFps(double target_fps, double source_fps) {
  if (target_fps <= 0.0) return source_fps;
  if (source_fps <= 0.0) return target_fps;
  return std::min(target_fps, source_fps);
}

// 算力不足 = 实测推理帧率低于有效目标的 ratio,且推理本身把时间占满了
// (单帧推理耗时 × 目标帧率 ≥ ratio 秒/秒)。只满足前者多半是源流卡顿/
// 抖动,提示"减通道"反而误导。多通道争 GPU 时单帧推理耗时会被拉长,
// 这正是它要抓的信号。
inline bool IsUnderCapacity(double actual_fps, double effective_target_fps,
                            double infer_mean_ms, double ratio = 0.9) {
  if (actual_fps <= 0.0 || effective_target_fps <= 0.0) return false;
  bool fps_short = actual_fps < ratio * effective_target_fps;
  bool busy = infer_mean_ms * effective_target_fps / 1000.0 >= ratio;
  return fps_short && busy;
}

}  // namespace ai_service::pipeline
