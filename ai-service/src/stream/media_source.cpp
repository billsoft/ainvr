// Copyright AINVR.
#include "media_source.hpp"
#include <atomic>
#include <algorithm>
#include <chrono>
#include <stdexcept>
extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/bsf.h>
}
namespace ainvr {
namespace {
int64_t Now() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}
void Check(int rc, const char* operation) {
  if(rc>=0)return;
  char message[AV_ERROR_MAX_STRING_SIZE];av_strerror(rc,message,sizeof(message));
  // Never include a source URL, which can contain credentials.
  throw std::runtime_error(std::string(operation)+": "+message);
}
}
struct MediaSource::State {
  AVFormatContext* format=nullptr;
  AVBSFContext* filter=nullptr;
  AVPacket* input=nullptr;
  AVPacket* output=nullptr;
  int video=-1, timeout_ms=5000;
  MediaInfo info{};
  bool eof=false, failed=false;
  std::atomic<bool> cancelled{false};
  std::atomic<bool> interrupted{false};
  std::atomic<int64_t> deadline{0};
  static int Interrupt(void* opaque) {
    auto* self=static_cast<State*>(opaque);
    if(self->cancelled.load() || Now()>=self->deadline.load()) {
      self->interrupted=true;return 1;
    }
    return 0;
  }
  void Arm(){interrupted=false;deadline=Now()+timeout_ms;}
  void RequireUninterrupted() {
    if(interrupted || cancelled) {
      failed=true;throw std::runtime_error("Media operation interrupted; reopen source");
    }
  }
  ~State(){
    av_packet_free(&input);av_packet_free(&output);av_bsf_free(&filter);
    avformat_close_input(&format);
  }
};
MediaSource::MediaSource(const std::string& url,int timeout_ms):state_(std::make_unique<State>()) {
  if(url.empty()||timeout_ms<100||timeout_ms>60000)throw std::invalid_argument("Invalid media source options");
  auto& s=*state_;s.timeout_ms=timeout_ms;s.Arm();
  s.format=avformat_alloc_context();if(!s.format)throw std::bad_alloc();
  s.format->interrupt_callback={State::Interrupt,&s};
  // Let stream analysis finish normally BEFORE the I/O watchdog. FFmpeg may
  // return success after an interrupted probe with partially buffered packets.
  // Such a context must never be reused for live packet reading.
  s.format->max_analyze_duration=std::min<int64_t>(500000,int64_t(timeout_ms)*250);
  s.format->fps_probe_size=2;
  AVDictionary* options=nullptr;
  av_dict_set(&options,"rtsp_transport","tcp",0);
  av_dict_set_int(&options,"rw_timeout",int64_t(timeout_ms)*1000,0);
  int rc=avformat_open_input(&s.format,url.c_str(),nullptr,&options);
  av_dict_free(&options);Check(rc,"Open media");s.RequireUninterrupted();
  s.Arm();Check(avformat_find_stream_info(s.format,nullptr),"Read stream information");
  s.RequireUninterrupted();
  s.video=av_find_best_stream(s.format,AVMEDIA_TYPE_VIDEO,-1,-1,nullptr,0);
  Check(s.video,"Find video stream");
  auto* stream=s.format->streams[s.video];auto* par=stream->codecpar;
  const char* filter_name=nullptr;
  if(par->codec_id==AV_CODEC_ID_H264){s.info.codec=Codec::H264;filter_name="h264_mp4toannexb";}
  else if(par->codec_id==AV_CODEC_ID_HEVC){s.info.codec=Codec::H265;filter_name="hevc_mp4toannexb";}
  else if(par->codec_id==AV_CODEC_ID_MJPEG)s.info.codec=Codec::Jpeg;
  else throw std::invalid_argument("Unsupported video codec");
  s.info.width=par->width;s.info.height=par->height;
  s.info.has_b_frames=par->video_delay>0;
  if(par->width<=0||par->height<=0)throw std::runtime_error("Unknown video dimensions");
  s.info.bt709=par->color_space==AVCOL_SPC_BT709;
  s.info.full_range=par->color_range==AVCOL_RANGE_JPEG;
  if(filter_name){
    auto* descriptor=av_bsf_get_by_name(filter_name);
    if(!descriptor)throw std::runtime_error("Annex B filter is unavailable");
    Check(av_bsf_alloc(descriptor,&s.filter),"Allocate bitstream filter");
    Check(avcodec_parameters_copy(s.filter->par_in,par),"Copy codec information");
    s.filter->time_base_in=stream->time_base;
    Check(av_bsf_init(s.filter),"Initialize Annex B filter");
  }
  s.input=av_packet_alloc();s.output=av_packet_alloc();
  if(!s.input||!s.output)throw std::bad_alloc();
}
MediaSource::~MediaSource()=default;
const MediaInfo& MediaSource::Info()const{return state_->info;}
void MediaSource::Cancel()noexcept{state_->cancelled=true;}
std::optional<CompressedFrame> MediaSource::Read(){
  auto& s=*state_;
  if(s.failed)throw std::runtime_error("Media source failed; reopen before reading");
  s.Arm();
  auto copy=[&](AVPacket* packet,AVRational time_base){
    if(packet->size<=0||packet->size>64*1024*1024)throw std::runtime_error("Invalid compressed frame size");
    CompressedFrame frame;
    frame.key_frame = (packet->flags & AV_PKT_FLAG_KEY) != 0;
    frame.bytes.assign(packet->data,packet->data+packet->size);
    if(packet->pts!=AV_NOPTS_VALUE)frame.pts_ns=av_rescale_q(packet->pts,time_base,AVRational{1,1000000000});
    if(packet->dts!=AV_NOPTS_VALUE)frame.dts_ns=av_rescale_q(packet->dts,time_base,AVRational{1,1000000000});
    if(packet->duration>0)frame.duration_ns=av_rescale_q(packet->duration,time_base,AVRational{1,1000000000});
    av_packet_unref(packet);return frame;
  };
  for(;;){
    if(State::Interrupt(&s))s.RequireUninterrupted();
    if(s.filter){
      int rc=av_bsf_receive_packet(s.filter,s.output);
      if(rc>=0)return copy(s.output,s.filter->time_base_out);
      if(rc==AVERROR_EOF)return std::nullopt;
      if(rc!=AVERROR(EAGAIN))Check(rc,"Receive filtered packet");
    }
    if(s.eof)return std::nullopt;
    int rc=av_read_frame(s.format,s.input);
    s.RequireUninterrupted();
    if(rc==AVERROR_EOF){
      s.eof=true;
      if(s.filter)Check(av_bsf_send_packet(s.filter,nullptr),"Drain bitstream filter");
      continue;
    }
    Check(rc,"Read video packet");
    if(s.input->stream_index!=s.video){av_packet_unref(s.input);continue;}
    if(!s.filter)return copy(s.input,s.format->streams[s.video]->time_base);
    Check(av_bsf_send_packet(s.filter,s.input),"Submit bitstream filter");
  }
}
}
