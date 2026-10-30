#include "vpu_decoder.hpp"
#include "media_memory.hpp"
#include "picture_tokens.hpp"
#include "decoded_frame_layout.hpp"
#include "compressed_packet_layout.hpp"
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
  PictureTokens pending;
  Codec codec=Codec::H264;
  JpegOutputLayout jpeg_layout=JpegOutputLayout::StrictVisible;
  bool initialized=false,started=false,finished=false,failed=false;int max_width=0,max_height=0;
  int output_fd=-1;
  ~State(){if(output_fd>=0)hb_mm_mc_close_fd(&context,output_fd);
    if(started)hb_mm_mc_pause(&context);
    if(initialized)hb_mm_mc_release(&context);
    if(parser)av_parser_close(parser);
    avcodec_free_context(&parser_context);}
  bool Queue(const std::vector<uint8_t>& bytes,uint64_t pts,int timeout,bool eos){
    if(timeout<0)throw std::invalid_argument("Negative codec timeout");
    if(finished)throw std::runtime_error("Decoder already received end of stream");
    const auto queued_bytes=DecoderQueuedPacketBytes(codec,bytes.size(),context.video_dec_params.bitstream_buf_size,eos);
    media_codec_buffer_t in{};int rc=hb_mm_mc_dequeue_input_buffer(&context,&in,timeout);
    if(rc==HB_MEDIA_ERR_WAIT_TIMEOUT)return false;
    Check(rc,"dequeue compressed buffer");
    if(parser&&!eos){
      auto padded=bytes;padded.resize(bytes.size()+AV_INPUT_BUFFER_PADDING_SIZE);
      uint8_t* parsed=nullptr;int parsed_size=0;
      int consumed=av_parser_parse2(parser,parser_context,&parsed,&parsed_size,padded.data(),bytes.size(),AV_NOPTS_VALUE,AV_NOPTS_VALUE,0);
      if(consumed!=int(bytes.size())||parsed_size!=int(bytes.size()))throw std::runtime_error("Incomplete picture parser output");
      pending.Push(parser->output_picture_number,pts);
    }
    in.type=MC_VIDEO_STREAM_BUFFER;in.vstream_buf.size=queued_bytes;in.vstream_buf.pts=pts;in.vstream_buf.stream_end=eos;
    if(!bytes.empty())std::memcpy(in.vstream_buf.vir_ptr,bytes.data(),bytes.size());
    if(queued_bytes>bytes.size())std::memset(in.vstream_buf.vir_ptr+bytes.size(),0,queued_bytes-bytes.size());
    Check(hb_mm_mc_queue_input_buffer(&context,&in,timeout),"submit compressed buffer");finished=eos;return true;
  }
};
VpuDecoder::VpuDecoder(Codec codec,int width,int height,JpegOutputLayout jpeg_layout):state_(std::make_unique<State>()){
  if(width<=0||height<=0||width%2||height%2||width>8192||height>8192)throw std::invalid_argument("Invalid maximum decode dimensions");
  if(jpeg_layout!=JpegOutputLayout::StrictVisible&&codec!=Codec::Jpeg&&codec!=Codec::Mjpeg)throw std::invalid_argument("Padded visible layout requires JPEG");
  auto& s=*state_;s.codec=codec;s.jpeg_layout=jpeg_layout;s.max_width=width;s.max_height=height;auto& c=s.context;auto& p=c.video_dec_params;
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
  if(rc==HB_MEDIA_ERR_WAIT_TIMEOUT)return std::nullopt;
  Check(rc,"receive decoded frame");
  struct ReturnBuffer {State& s;media_codec_buffer_t& out;~ReturnBuffer(){hb_mm_mc_queue_output_buffer(&s.context,&out,1000);}} release{s,out};
  auto& v=out.vframe_buf;
  DecodedNv12Layout allocation{v.width,v.height,v.stride,v.vstride,v.size,{v.compSize[0],v.compSize[1]},
    bool(v.vir_ptr[0]),bool(v.vir_ptr[1]),v.pix_fmt==MC_PIXEL_FORMAT_NV12};
  if(s.codec==Codec::Jpeg||s.codec==Codec::Mjpeg){
    const auto& jpeg=info.jpeg_frame_info;
    allocation.display_width=jpeg.display_width;allocation.display_height=jpeg.display_height;allocation.jpeg_decode_result=jpeg.decode_result;
  }
  const auto visible=ValidateDecodedNv12Layout(s.codec,allocation,s.max_width,s.max_height,s.jpeg_layout);
  const int w=visible.width,h=visible.height,ys=visible.luma_stride,uvs=visible.chroma_stride;
  Nv12Frame frame;frame.width=w;frame.height=h;frame.pts=v.pts;
  frame.visible_width=visible.visible_width;frame.visible_height=visible.visible_height;
  if(s.parser){
    const auto& metadata=info.video_frame_info;
    if((metadata.decode_result!=1&&metadata.decode_result!=0x10)||metadata.frame_display_index<0||metadata.err_mb_in_frame_decoded>0)
      throw std::runtime_error("Cannot associate damaged or non-display picture");
    // SDK vframe_buf.pts belongs to the decode command. Only an unambiguous
    // displayed POC may select the original access-unit token.
    frame.pts=s.pending.Take(metadata.display_poc);
  }
  frame.pixels.resize(size_t(w)*h*3/2);
  for(int y=0;y<h;++y)std::memcpy(frame.pixels.data()+size_t(y)*w,v.vir_ptr[0]+size_t(y)*ys,w);
  for(int y=0;y<h/2;++y)std::memcpy(frame.pixels.data()+size_t(w)*h+size_t(y)*w,v.vir_ptr[1]+size_t(y)*uvs,w);
  return frame;
}
}
