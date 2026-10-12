#pragma once

#include <functional>
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
  virtual void WaitForCapacity(const std::function<bool()>& cancelled) {}
  virtual void ReserveForFrame(cv::Size size) {}
  // snapshot_cfg 由调用方(ChannelWorker::InferOneFrame)每帧从当前生效
  // 配置里现取现传——热更新(§1.2 SNAPSHOT_HOT_SUBFIELDS)因此天然对
  // SnapshotSink 生效,不需要额外的配置同步通路。
  // 只在需要归档且队列有空间时下载一个合并区域。目标 Mat 可跨帧复用。
  // 回调必须在 Offer 返回前同步完成，禁止保存帧视图到后台队列。
  struct FrameProvider {
    cv::Size size;
    std::function<void(const cv::Rect&, cv::Mat&)> download;
    std::function<bool()> cancelled;
  };
  virtual void Offer(const FrameProvider& frame_provider, const std::string& channel_id,
                      const std::string& channel_name, int64_t frame_pts_ns, double timestamp,
                      const std::string& model_name, const std::string& task_type,
                      const std::vector<Detection>& crop_detections,
                      const std::vector<Detection>& stored_detections, bool square_crop,
                      const config::SnapshotConfig& snapshot_cfg) = 0;
};

}  // namespace ai_service::pipeline
