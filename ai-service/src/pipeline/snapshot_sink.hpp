#pragma once

#include <functional>
#include <memory>
#include <cstdint>
#include <string>
#include <vector>
#include <opencv2/core.hpp>
#include "../config/config.hpp"
#include "../output/result.hpp"

namespace ai_service::pipeline {
class SnapshotSink {
 public:
  virtual ~SnapshotSink() = default;
  // Wait before selecting the next source frame, without retaining a decoder surface.
  virtual void WaitForCapacity(const std::function<bool()>&) {}
  virtual void ReserveForFrame(cv::Size) {}
  // snapshot_cfg 由调用方(ChannelWorker::InferOneFrame)每帧从当前生效
  // 配置里现取现传——热更新(§1.2 SNAPSHOT_HOT_SUBFIELDS)因此天然对
  // SnapshotSink 生效,不需要额外的配置同步通路。
  // 只在需要归档且队列有空间时下载一个合并区域。目标 Mat 可跨帧复用。
  // 回调必须在 Offer 返回前同步完成，禁止保存帧视图到后台队列。
  struct Nv12Source {
    std::shared_ptr<const std::vector<uint8_t>> pixels;
    uint64_t tag=0;
    bool bt709=false,full_range=false;
  };
  struct FrameProvider {
    cv::Size size;
    std::function<void(const cv::Rect&, cv::Mat&)> download;
    std::function<bool()> cancelled;
    // Optional immutable, detached pixel owner. Safe on archive workers; never
    // captures a decoder surface, inference-thread GLES context or worker this.
    std::function<void(const cv::Rect&, cv::Mat&)> owned_download;
    // Optional immutable CPU-owned bytes, never a borrowed VPU surface.
    Nv12Source nv12;
  };
  virtual void Offer(const FrameProvider& frame_provider, const std::string& channel_id,
                      const std::string& channel_name, int64_t frame_pts_ns, double timestamp,
                      const std::string& model_name, const std::string& task_type,
                      const std::vector<Detection>& crop_detections,
                      const std::vector<Detection>& stored_detections, bool square_crop,
                      const config::SnapshotConfig& snapshot_cfg) = 0;
  // Full frame result preserves non-box geometry for capable archive sinks.
  // Existing box-only sinks retain their original interface and behavior.
  virtual void OfferResult(const FrameProvider& frame_provider, const FrameResult& result,
                           const std::string& channel_name,
                           const std::vector<Detection>& crop_detections, bool square_crop,
                           const config::SnapshotConfig& snapshot_cfg) {
    Offer(frame_provider, result.channel_id, channel_name, result.frame_pts_ns, result.timestamp,
          result.model_name, result.task_type, crop_detections, result.detections,
          square_crop, snapshot_cfg);
  }
};

}  // namespace ai_service::pipeline
