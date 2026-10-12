// Copyright AINVR. Replace only source hardware; original channel/publisher owns policy.
#include "source.hpp"
#include <chrono>
#include <map>
#include <stdexcept>

namespace ai_service::stream {
bool GopAwareShedder::Decide(bool is_keyframe,int64_t queue_level,int64_t queue_max) {
  if(is_keyframe){shedding_=false;return false;}
  if(shedding_){shed_count_++;return true;}
  if(queue_max>0&&queue_level>=queue_max){shedding_=true;shed_count_++;return true;}
  return false;
}
FrameRef::FrameRef(ainvr::Nv12Frame pixels,int64_t duration,int64_t index,
                  std::optional<int64_t> original_pts,bool bt709_hint,bool full_range_hint)
    :width(pixels.width),height(pixels.height),pts_ns(static_cast<int64_t>(pixels.pts)),
     duration_ns(duration),frame_index(index),source_pts_ns(original_pts),
     bt709(bt709_hint),full_range(full_range_hint),nv12(std::move(pixels)){}

StreamSource::StreamSource(std::string url,std::string channel_id,bool publish,
                           int timeout,size_t max_bytes)
    :url_(std::move(url)),channel_id_(std::move(channel_id)),publish_enabled_(publish),
     io_timeout_ms_(timeout),tap_max_bytes_(max_bytes){
  if(url_.empty()||channel_id_.empty()||timeout<100||timeout>60000||
     max_bytes<1024||max_bytes>256*1024*1024)
    throw std::invalid_argument("Invalid S100P source options");
}
StreamSource::~StreamSource(){Stop();}
void StreamSource::Start(){
  std::lock_guard lifecycle(lifecycle_mutex_);
  if(running_)return;
  if(pump_.joinable())StopLocked();
  {
    std::lock_guard lock(mutex_);
    stats_={};demux_={};size_.reset();latest_.reset();
    init_ready_=false;init_error_=nullptr;
    shedder_=std::make_shared<GopAwareShedder>();
  }
  au_seen_=0;stop_=false;++generation_;
  try{pump_=std::thread(&StreamSource::Pump,this);}
  catch(...){stop_=true;throw;}
  std::exception_ptr error;
  {
    std::unique_lock lock(mutex_);
    ready_.wait(lock,[this]{return init_ready_;});error=init_error_;
  }
  if(error){StopLocked();std::rethrow_exception(error);}
}
void StreamSource::Stop(){
  std::lock_guard lifecycle(lifecycle_mutex_);StopLocked();
}
void StreamSource::Restart(){Stop();Start();}
void StreamSource::StopLocked(){
  ++generation_;stop_=true;running_=false;
  std::shared_ptr<ainvr::MediaSource> media;
  std::shared_ptr<ainvr::CompressedTap> tap;
  {
    std::lock_guard lock(mutex_);
    media=media_;tap=std::move(tap_);latest_.reset();
  }
  // Cancel before joining so a stalled demux or full publisher tap cannot deadlock Stop.
  if(media)media->Cancel();
  if(tap)tap->Stop();
  frames_.notify_all();
  if(pump_.joinable())pump_.join();
  {
    std::lock_guard lock(mutex_);media_.reset();stats_.pending_tokens=0;
  }
}
std::shared_ptr<FrameRef> StreamSource::PullFrameRef(int timeout){
  if(timeout<0||timeout>60000)throw std::invalid_argument("Invalid frame wait timeout");
  std::unique_lock lock(mutex_);
  frames_.wait_for(lock,std::chrono::milliseconds(timeout),[this]{return latest_||!running_||stop_;});
  if(stop_||!latest_)return nullptr;
  ++stats_.delivered;return std::exchange(latest_,nullptr);
}
std::optional<std::pair<int,int>> StreamSource::GetTrueSourceSize()const{
  std::lock_guard lock(mutex_);return size_;
}
GstElement* StreamSource::GetEsSinkRef()const{
  std::shared_ptr<ainvr::CompressedTap> tap;
  {std::lock_guard lock(mutex_);tap=tap_;}
  return tap?tap->SinkReference():nullptr;
}
int64_t StreamSource::GetAuShed()const{
  std::lock_guard lock(mutex_);return shedder_?shedder_->shed_count():0;
}
EsQueueDiag StreamSource::GetEsQueueDiag()const{
  std::shared_ptr<ainvr::CompressedTap> tap;
  std::shared_ptr<GopAwareShedder> shedder;
  {std::lock_guard lock(mutex_);tap=tap_;shedder=shedder_;}
  EsQueueDiag diag;diag.au_seen=au_seen_;
  if(shedder){diag.au_shed=shedder->shed_count();diag.shedding=shedder->shedding();}
  if(tap){auto q=tap->QueueState();diag.available=true;
    diag.current_level_buffers=q.buffers;diag.max_size_buffers=q.max_buffers;}
  return diag;
}
DemuxStats StreamSource::GetDemuxStats()const{
  std::lock_guard lock(mutex_);return demux_;
}
SourceStats StreamSource::GetStats()const{
  std::lock_guard lock(mutex_);return stats_;
}
void StreamSource::ReportError(const std::string& error)noexcept{
  {std::lock_guard lock(mutex_);stats_.error=error;}
  if(error_callback_)try{error_callback_(error);}catch(...){}
}
void StreamSource::Pump(){
  using Clock=std::chrono::steady_clock;
  try{
    // SRS resolver hints do not override the codec actually present in the demuxed stream.
    if(codec_resolver_)try{codec_resolver_();}catch(...){}
    if(progress_resolver_)try{progress_resolver_();}catch(...){}
    auto media=std::make_shared<ainvr::MediaSource>(url_,io_timeout_ms_);
    {
      std::lock_guard lock(mutex_);media_=media;
    }
    if(stop_)media->Cancel();
    const auto info=media->Info();
    if(info.codec!=ainvr::Codec::H264&&info.codec!=ainvr::Codec::H265)
      throw std::runtime_error("S100P video source requires H.264 or H.265");
    ainvr::VpuDecoder decoder(info.codec,info.width,info.height);
    auto tap=publish_enabled_?std::make_shared<ainvr::CompressedTap>(info.codec,tap_max_bytes_):nullptr;
    std::shared_ptr<GopAwareShedder> shedder;
    {
      std::lock_guard lock(mutex_);
      tap_=tap;shedder=shedder_;size_={{info.width,info.height}};
      demux_.bframes=info.has_b_frames;
      // FFmpeg does not expose the original GStreamer HEVC FLV diagnostics.
      demux_.available=false;
      codec_=static_cast<int>(info.codec==ainvr::Codec::H264?VideoCodec::kH264:VideoCodec::kH265);
      running_=!stop_;init_ready_=true;
    }
    ready_.notify_all();
    struct Stamp {ainvr::EncodedStamp mapped;std::optional<int64_t> original;int64_t duration;};
    std::map<uint64_t,Stamp> pending;
    PtsRebaser clock;
    uint64_t token=0;int64_t frame_index=0;
    bool started=false,eof=false,submitted=false;
    auto receive=[&](int timeout){
      // The SDK render component does not exist before its first submitted AU.
      // Do not interpret a pre-submission query as a hardware decode failure.
      if(!submitted||pending.empty())return false;
      auto frame=decoder.Receive(timeout);if(!frame)return false;
      auto it=pending.find(frame->pts);
      if(it==pending.end())throw std::runtime_error("VPU display frame has no source timestamp token");
      auto stamp=it->second;pending.erase(it);
      frame->pts=static_cast<uint64_t>(stamp.mapped.pts_ns);
      auto ref=std::make_shared<FrameRef>(std::move(*frame),stamp.duration,++frame_index,
                                         stamp.original,info.bt709,info.full_range);
      {
        std::lock_guard lock(mutex_);
        if(!stop_){if(latest_)++stats_.superseded;latest_=std::move(ref);++stats_.decoded;}
        stats_.pending_tokens=pending.size();
      }
      frames_.notify_all();return true;
    };
    while(!stop_){
      while(!stop_&&receive(0)){}
      auto packet=media->Read();if(!packet){eof=true;break;}
      if(!started){
        if(!packet->key_frame){std::lock_guard lock(mutex_);++stats_.pre_keyframe_discarded;continue;}
        started=true;
      }
      auto [dts,pts]=clock.Map(packet->dts_ns,packet->pts_ns);
      if(dts<0||pts<0)throw std::runtime_error("Negative mapped source timestamp");
      ainvr::EncodedStamp stamp{pts,dts};
      ++au_seen_;
      if(tap){
        auto q=tap->QueueState(packet->bytes.size());
        // Preserve the original GOP policy. Keyframes wait for bounded space;
        // non-key overload drops continue until the next keyframe, never mid-GOP resume.
        if(!shedder->Decide(packet->key_frame,q.full?64:0,64)){
          while(!stop_&&!tap->FeedAt(*packet,stamp)){
            receive(0);std::this_thread::sleep_for(std::chrono::milliseconds(2));
          }
        }
      }
      if(stop_)break;
      if(pending.size()>=128)throw std::runtime_error("Too many unmatched source pictures");
      const auto current=token++;
      pending.emplace(current,Stamp{stamp,packet->pts_ns,packet->duration_ns});
      {std::lock_guard lock(mutex_);stats_.pending_tokens=pending.size();}
      auto deadline=Clock::now()+std::chrono::seconds(5);
      while(!stop_&&!decoder.Submit(packet->bytes,current,50)){
        receive(0);
        if(Clock::now()>deadline)throw std::runtime_error("S100P VPU input stalled");
      }
      if(!stop_){submitted=true;receive(50);}
    }
    if(eof&&!stop_&&started){
      auto deadline=Clock::now()+std::chrono::seconds(5);
      while(!stop_&&!decoder.Finish(50)){
        receive(0);if(Clock::now()>deadline)throw std::runtime_error("S100P VPU EOF submission stalled");
      }
      while(!stop_&&!pending.empty()){
        receive(50);if(Clock::now()>deadline)throw std::runtime_error("S100P VPU EOF frames did not drain");
      }
    }
    {std::lock_guard lock(mutex_);stats_.eof=eof&&!stop_;}
  }catch(...){
    const auto error=std::current_exception();
    bool during_init;
    {std::lock_guard lock(mutex_);during_init=!init_ready_;
      if(during_init){init_error_=error;init_ready_=true;}}
    if(!stop_){
      try{std::rethrow_exception(error);}
      catch(const std::exception& e){ReportError(e.what());}
      catch(...){ReportError("S100P source failed with an unknown error");}
    }
    ready_.notify_all();
  }
  running_=false;frames_.notify_all();
}
} // namespace ai_service::stream
