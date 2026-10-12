// Copyright AINVR. Single-reader demuxer; cancellation may come from another thread.
#pragma once
#include "platform/vpu_decoder.hpp"
#include <memory>
#include <optional>
#include <string>
namespace ainvr {
struct CompressedFrame {
  std::vector<uint8_t> bytes;
  std::optional<int64_t> pts_ns;
  bool key_frame = false; // Demuxer/filter random-access flag for live startup.
  std::optional<int64_t> dts_ns; // Preserve decode order for B-frame publishing.
  int64_t duration_ns = 0;
};
struct MediaInfo {
  Codec codec;
  int width, height;
  bool bt709, full_range;
  bool has_b_frames;
};
class MediaSource {
 public:
  explicit MediaSource(const std::string& url, int timeout_ms=5000);
  ~MediaSource();
  MediaSource(const MediaSource&)=delete;
  MediaSource& operator=(const MediaSource&)=delete;
  const MediaInfo& Info() const;
  std::optional<CompressedFrame> Read(); // null only on drained EOF; errors throw.
  void Cancel() noexcept;
 private:
  struct State;
  std::unique_ptr<State> state_;
};
}
