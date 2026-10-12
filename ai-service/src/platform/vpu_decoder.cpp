#include "vpu_decoder.hpp"
#include "media_memory.hpp"
#include <hb_media_codec.h>
#include <hb_media_error.h>
#include <hb_mem_mgr.h>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <deque>
#include <algorithm>
#include <poll.h>
#include <cerrno>
#include <chrono>
extern "C" {
#include <libavcodec/avcodec.h>
}
namespace ainvr {
namespace {
void Check(int rc,const char* operation){if(rc)throw std::runtime_error(std::string(operation)+": "+std::to_string(rc));}
}
struct VpuDecoder::State {
  State(){EnsureMediaMemory();}
  media_codec_context_t context{};
  AVCodecParserContext* parser=nullptr;
  AVCodecContext* parser_context=nullptr;
  struct Pending {int poc;uint64_t token;};
  std::deque<Pending> pending;
  bool initialized=false,started=false,finished=false,failed=false;int max_width=0,max_height=0;
  int output_fd=-1;
  ~State(){if(output_fd>=0)hb_mm_mc_close_fd(&context,output_fd);
    if(started)hb_mm_mc_pause(&context);if(initialized)hb_mm_mc_release(&context);
    if(parser)av_parser_close(parser);avcodec_free_context(&parser_context);}
  bool Queue(const std::vector<uint8_t>& bytes,uint64_t pts,int timeout,bool eos){
    if(timeout<0)throw std::invalid_argument("Negative codec timeout");
    if(finished)throw std::runtime_error("Decoder already received end of stream");
    if((bytes.empty()&&!eos)||bytes.size()>context.video_dec_params.bitstream_buf_size)throw std::invalid_argument("Invalid access unit size");
    media_codec_buffer_t in{};int rc=hb_mm_mc_dequeue_input_buffer(&context,&in,timeout);
    if(rc==HB_MEDIA_ERR_WAIT_TIMEOUT)return false;Check(rc,"dequeue compressed buffer");
    if(parser&&!eos){
      if(pending.size()>=128)throw std::runtime_error("Too many unmatched decoded pictures");
      auto padded=bytes;padded.resize(bytes.size()+AV_INPUT_BUFFER_PADDING_SIZE);
      uint8_t* parsed=nullptr;int parsed_size=0;
      int consumed=av_parser_parse2(parser,parser_context,&parsed,&parsed_size,padded.data(),bytes.size(),AV_NOPTS_VALUE,AV_NOPTS_VALUE,0);
      if(consumed!=int(bytes.size())||parsed_size!=int(bytes.size()))throw std::runtime_error("Incomplete picture parser output");
      pending.push_back({parser->output_picture_number,pts});
    }
    in.type=MC_VIDEO_STREAM_BUFFER;in.vstream_buf.size=bytes.size();in.vstream_buf.pts=pts;in.vstream_buf.stream_end=eos;
    if(!bytes.empty())std::memcpy(in.vstream_buf.vir_ptr,bytes.data(),bytes.size());
    Check(hb_mm_mc_queue_input_buffer(&context,&in,timeout),"submit compressed buffer");finished=eos;return true;
  }
};
VpuDecoder::VpuDecoder(Codec codec,int width,int height):state_(std::make_unique<State>()){
  if(width<=0||height<=0||width%2||height%2||width>8192||height>8192)throw std::invalid_argument("Invalid maximum decode dimensions");
  auto& s=*state_;s.max_width=width;s.max_height=height;auto& c=s.context;auto& p=c.video_dec_params;
  c.encoder=false;p.feed_mode=MC_FEEDING_MODE_FRAME_SIZE;p.pix_fmt=MC_PIXEL_FORMAT_NV12;
  p.bitstream_buf_size=(uint64_t(width)*height*3/2+1023)&~uint64_t(1023);p.bitstream_buf_count=4;p.frame_buf_count=6;
  switch(codec){
    case Codec::H264:c.codec_id=MEDIA_CODEC_ID_H264;p.h264_dec_config.bandwidth_Opt=true;p.h264_dec_config.reorder_enable=true;break;
    case Codec::H265:c.codec_id=MEDIA_CODEC_ID_H265;p.h265_dec_config.bandwidth_Opt=true;p.h265_dec_config.reorder_enable=true;break;
    case Codec::Jpeg:c.codec_id=MEDIA_CODEC_ID_JPEG;break;
    case Codec::Mjpeg:c.codec_id=MEDIA_CODEC_ID_MJPEG;break;
  }
  if(codec==Codec::H264||codec==Codec::H265){
    s.parser=av_parser_init(codec==Codec::H264?AV_CODEC_ID_H264:AV_CODEC_ID_HEVC);
    s.parser_context=avcodec_alloc_context3(nullptr);
    if(!s.parser||!s.parser_context)throw std::runtime_error("Cannot initialize picture-order parser");
    s.parser->flags|=PARSER_FLAG_COMPLETE_FRAMES;
  }
  Check(hb_mm_mc_initialize(&c),"initialize VPU/JPU");s.initialized=true;
  Check(hb_mm_mc_configure(&c),"configure VPU/JPU");mc_av_codec_startup_params_t start{};
  Check(hb_mm_mc_start(&c,&start),"start VPU/JPU");s.started=true;
  // Follow SDK poll mode, then verify the output queue below: the event fd can
  // signal during startup while the render component still has no output.
  Check(hb_mm_mc_get_fd(&c,&s.output_fd),"get VPU/JPU output readiness fd");
  if(s.output_fd<0)throw std::runtime_error("Invalid VPU/JPU readiness fd");
}
VpuDecoder::~VpuDecoder()=default;
bool VpuDecoder::Submit(const std::vector<uint8_t>& bytes,uint64_t pts,int timeout){
  if(state_->failed)throw std::runtime_error("Decoder failed; recreate before resuming");
  try{return state_->Queue(bytes,pts,timeout,false);}catch(...){state_->failed=true;throw;}
}
bool VpuDecoder::Finish(int timeout){
  if(state_->failed)throw std::runtime_error("Decoder failed; recreate before resuming");
  try{return state_->Queue({},0,timeout,true);}catch(...){state_->failed=true;throw;}
}
std::optional<Nv12Frame> VpuDecoder::Receive(int timeout){
  if(state_->failed)throw std::runtime_error("Decoder failed; recreate before resuming");
  struct FailOnException {State& s;int depth=std::uncaught_exceptions();
    ~FailOnException(){if(std::uncaught_exceptions()>depth)s.failed=true;}} guard{*state_};
  if(timeout<0)throw std::invalid_argument("Negative codec timeout");
  auto& s=*state_;media_codec_buffer_t out{};media_codec_output_buffer_info_t info{};
  const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(timeout);
  pollfd descriptor{s.output_fd,POLLIN,0};int ready;
  do{
    const auto remaining=std::chrono::duration_cast<std::chrono::milliseconds>(
        deadline-std::chrono::steady_clock::now()).count();
    ready=poll(&descriptor,1,static_cast<int>(std::max<int64_t>(0,remaining)));
  }while(ready<0&&errno==EINTR&&std::chrono::steady_clock::now()<deadline);
  if(ready==0)return std::nullopt;
  if(ready<0)throw std::runtime_error("Poll VPU/JPU output readiness failed");
  if(descriptor.revents&(POLLERR|POLLHUP|POLLNVAL))
    throw std::runtime_error("VPU/JPU readiness fd reported a hardware failure");
  if(!(descriptor.revents&POLLIN))throw std::runtime_error("Unexpected VPU/JPU readiness event");
  mc_inter_status_t status{};
  Check(hb_mm_mc_get_status(&s.context,&status),"query VPU/JPU output status");
  // Do not dequeue an empty render queue or suppress ERR_UNKNOWN. B-picture
  // startup needs more compressed input before it can produce display frames.
  if(status.cur_output_buf_cnt==0)return std::nullopt;
  const auto remaining=std::chrono::duration_cast<std::chrono::milliseconds>(
      deadline-std::chrono::steady_clock::now()).count();
  int rc=hb_mm_mc_dequeue_output_buffer(&s.context,&out,&info,
      static_cast<int>(std::max<int64_t>(1,remaining)));
  if(rc==HB_MEDIA_ERR_WAIT_TIMEOUT)return std::nullopt;Check(rc,"receive decoded frame");
  struct ReturnBuffer {State& s;media_codec_buffer_t& out;~ReturnBuffer(){hb_mm_mc_queue_output_buffer(&s.context,&out,1000);}} release{s,out};
  auto& v=out.vframe_buf;int w=v.width,h=v.height,ys=v.stride>0?v.stride:w,uvs=v.vstride>0?v.vstride:ys;
  if(w<=0||h<=0||w%2||h%2||w>s.max_width||h>s.max_height||ys<w||uvs<w||!v.vir_ptr[0]||!v.vir_ptr[1])throw std::runtime_error("Unsupported decoded frame layout/resolution change");
  Nv12Frame frame;frame.width=w;frame.height=h;frame.pts=v.pts;
  if(s.parser){
    const auto& metadata=info.video_frame_info;
    if((metadata.decode_result!=1&&metadata.decode_result!=0x10)||metadata.frame_display_index<0||metadata.err_mb_in_frame_decoded>0)
      throw std::runtime_error("Cannot associate damaged or non-display picture");
    // SDK vframe_buf.pts belongs to the decode command, not the displayed
    // picture. POC follows display order. Across a GOP reset consume the oldest
    // outstanding occurrence; never synthesize timestamps or use EOS tokens.
    auto match=std::find_if(s.pending.begin(),s.pending.end(),[&](const State::Pending& p){return p.poc==metadata.display_poc;});
    if(match==s.pending.end())throw std::runtime_error("Unmatched display POC; recreate decoder before resuming");
    frame.pts=match->token;s.pending.erase(match);
  }
  frame.pixels.resize(size_t(w)*h*3/2);
  for(int y=0;y<h;++y)std::memcpy(frame.pixels.data()+size_t(y)*w,v.vir_ptr[0]+size_t(y)*ys,w);
  for(int y=0;y<h/2;++y)std::memcpy(frame.pixels.data()+size_t(w)*h+size_t(y)*w,v.vir_ptr[1]+size_t(y)*uvs,w);
  return frame;
}
}
