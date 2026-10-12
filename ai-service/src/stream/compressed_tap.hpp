// Copyright AINVR. Adapt S100P demux packets to the original publisher input contract.
#pragma once
#include "media_source.hpp"
#include "publisher.hpp"
#include <mutex>
namespace ainvr {
struct EncodedStamp {int64_t pts_ns,dts_ns;};
struct TapQueueState {
  uint64_t bytes=0, buffers=0;
  size_t max_bytes=0;
  uint64_t max_buffers=64;
  bool full=false;
};
class CompressedTap {
 public:
  explicit CompressedTap(Codec codec,size_t max_bytes=32*1024*1024);
  ~CompressedTap();
  CompressedTap(const CompressedTap&)=delete;
  CompressedTap& operator=(const CompressedTap&)=delete;
  // nullopt means bounded backpressure; retain and retry the same packet.
  // Returned PTS is the shared inference/result/SEI key on this generation.
  std::optional<EncodedStamp> Feed(const CompressedFrame& packet);
  // Source owns a common clock for both VPU display PTS and compressed SEI AUs.
  // Do not mix Feed and FeedAt on one tap generation.
  std::optional<EncodedStamp> FeedAt(const CompressedFrame& packet, EncodedStamp stamp);
  TapQueueState QueueState(size_t next_packet_bytes=0) const;
  GstElement* SinkReference() const; // Caller must gst_object_unref.
  void Stop();
 private:
  std::optional<EncodedStamp> FeedLocked(const CompressedFrame&, std::optional<EncodedStamp>);
  mutable std::mutex mutex_;
  GstElement *pipeline_=nullptr,*source_=nullptr,*sink_=nullptr;
  bool stopped_=false;
  size_t max_bytes_;
  ai_service::stream::PtsRebaser clock_;
  std::optional<bool> external_clock_;
  std::optional<int64_t> last_dts_;
};
}
