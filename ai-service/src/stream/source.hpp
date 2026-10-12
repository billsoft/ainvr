// Copyright AINVR. S100P hardware implementation of the original source contract.
#pragma once
#include "compressed_tap.hpp"
#include "srs_codec_probe.hpp"
#include <atomic>
#include <condition_variable>
#include <exception>
#include <functional>
#include <mutex>
#include <thread>

namespace ai_service::stream {
// Original overload policy: shed non-key AUs until the next random-access frame.
class GopAwareShedder {
 public:
  bool Decide(bool is_keyframe,int64_t queue_level,int64_t queue_max);
  bool shedding()const{return shedding_;}
  int64_t shed_count()const{return shed_count_;}
 private:
  std::atomic<bool> shedding_{false};
  std::atomic<int64_t> shed_count_{0};
};

// Immutable, detached NV12 copy made by the VPU adapter; never a CPU-decoded image.
// Retained references survive source stop/restart without retaining VPU surfaces.
class FrameRef {
 public:
  FrameRef(ainvr::Nv12Frame pixels,int64_t duration,int64_t index,
           std::optional<int64_t> original_pts,bool bt709,bool full_range);
  const int width,height;
  const int64_t pts_ns,duration_ns,frame_index;
  const std::optional<int64_t> source_pts_ns;
  const bool bt709,full_range;
  const ainvr::Nv12Frame nv12;
};
struct EsQueueDiag {
  bool available=false;
  int64_t current_level_buffers=0,max_size_buffers=0,au_seen=0,au_shed=0;
  bool shedding=false;
};
struct DemuxStats {
  bool available=false;
  std::string format;
  uint64_t dropped_frames=0,resyncs=0;
  bool bframes=false;
};
struct SourceStats {
  uint64_t decoded=0,superseded=0,delivered=0,pre_keyframe_discarded=0;
  uint64_t pending_tokens=0;
  bool eof=false;
  std::optional<std::string> error;
};

class StreamSource {
 public:
  StreamSource(std::string url,std::string channel_id,bool publish_enabled=false,
               int io_timeout_ms=5000,size_t tap_max_bytes=32*1024*1024);
  ~StreamSource();
  StreamSource(const StreamSource&)=delete;
  StreamSource& operator=(const StreamSource&)=delete;
  void Start();
  void Stop();
  void Restart();
  std::shared_ptr<FrameRef> PullFrameRef(int timeout_ms=100);
  std::optional<std::pair<int,int>> GetTrueSourceSize()const;
  bool IsRunning()const{return running_;}
  std::string SourceFactoryName()const{return "ffmpeg-demux+s100p-vpu";}
  GstElement* GetEsSinkRef()const;
  int64_t GetAuSeen()const{return au_seen_;}
  int64_t GetAuShed()const;
  int64_t GetStreamGeneration()const{return generation_;}
  EsQueueDiag GetEsQueueDiag()const;
  DemuxStats GetDemuxStats()const;
  SourceStats GetStats()const;
  VideoCodec Codec()const{return static_cast<VideoCodec>(codec_.load());}
  using ErrorCallback=std::function<void(const std::string&)>;
  using CodecResolver=std::function<std::optional<VideoCodec>()>;
  using VideoProgressResolver=std::function<std::optional<SrsVideoProgress>()>;
  // Assigned before Start; callbacks must not synchronously call lifecycle methods.
  void SetErrorCallback(ErrorCallback callback){error_callback_=std::move(callback);}
  void SetCodecResolver(CodecResolver callback){codec_resolver_=std::move(callback);}
  void SetVideoProgressResolver(VideoProgressResolver callback){progress_resolver_=std::move(callback);}
 private:
  void StopLocked();
  void Pump();
  void ReportError(const std::string& error)noexcept;
  const std::string url_,channel_id_;
  const bool publish_enabled_;
  const int io_timeout_ms_;
  const size_t tap_max_bytes_;
  std::mutex lifecycle_mutex_;
  mutable std::mutex mutex_;
  std::condition_variable ready_,frames_;
  std::thread pump_;
  std::atomic<bool> stop_{true},running_{false};
  std::atomic<int64_t> generation_{0},au_seen_{0};
  std::atomic<int> codec_{static_cast<int>(VideoCodec::kH264)};
  bool init_ready_=false;
  std::exception_ptr init_error_;
  std::shared_ptr<ainvr::MediaSource> media_;
  std::shared_ptr<ainvr::CompressedTap> tap_;
  std::shared_ptr<GopAwareShedder> shedder_;
  std::shared_ptr<FrameRef> latest_;
  std::optional<std::pair<int,int>> size_;
  SourceStats stats_;
  DemuxStats demux_;
  ErrorCallback error_callback_;
  CodecResolver codec_resolver_;
  VideoProgressResolver progress_resolver_;
};
} // namespace ai_service::stream
