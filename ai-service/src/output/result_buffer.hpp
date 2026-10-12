// 结果环形缓冲 —— 对应 Python output/result_buffer.py。deque + mutex,
// 线程安全:写入方是通道 Worker 线程,读取方是 HTTP 请求处理线程。
#pragma once

#include <deque>
#include <mutex>
#include <optional>
#include <vector>

#include "result.hpp"

namespace ai_service {

class ResultBuffer {
 public:
  explicit ResultBuffer(size_t max_frames = 30) : max_frames_(max_frames) {}

  void Append(FrameResult result);
  std::optional<FrameResult> Latest() const;
  std::vector<FrameResult> LastN(size_t n) const;
  std::vector<FrameResult> All() const;
  size_t Size() const;
  void Clear();

  // 调整环形缓冲容量(架构 §11.2 热参数档:result_buffer.max_frames,改
  // 配置不需要重启通道)。缩容时只保留最近 new_max 条,扩容时旧数据原样
  // 保留、之后自然填满到新容量。
  void Resize(size_t new_max);

 private:
  mutable std::mutex mutex_;
  std::deque<FrameResult> buf_;
  size_t max_frames_;
};

}  // namespace ai_service
