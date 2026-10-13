// Copyright AINVR. SDK-owned buffers, bounded synchronous JPU encode.
#include "jpeg_encoder.hpp"
#include "media_memory.hpp"
#include <hb_media_codec.h>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <algorithm>
namespace ainvr {
namespace {void Check(int rc,const char* action){if(rc)throw std::runtime_error(std::string(action)+": "+std::to_string(rc));}}
struct JpegEncoder::State {
  media_codec_context_t context{};
  bool initialized=false,started=false,failed=false;
  int width=0,height=0,visible_width=0,visible_height=0;
  std::mutex mutex;
  ~State(){if(started)hb_mm_mc_pause(&context);if(initialized)hb_mm_mc_release(&context);}
};
JpegEncoder::JpegEncoder(int width,int height,int quality,int visible_width,int visible_height):state_(std::make_unique<State>()){
  if(width<18||height<18||width>8192||height>8192||width%2||height%2||quality<1||quality>100)
    throw std::invalid_argument("Invalid JPEG dimensions or quality");
  EnsureMediaMemory();auto& s=*state_;s.width=width;s.height=height;
  s.visible_width=visible_width?visible_width:width;s.visible_height=visible_height?visible_height:height;
  if(s.visible_width<=0||s.visible_height<=0||s.visible_width>width||s.visible_height>height||
     (s.visible_width+15)/16!=(width+15)/16||(s.visible_height+15)/16!=(height+15)/16)
    throw std::invalid_argument("Visible JPEG crop must preserve the MCU grid");
  auto& c=s.context;auto& p=c.video_enc_params;c.encoder=true;c.codec_id=MEDIA_CODEC_ID_JPEG;
  p.width=std::max(32,(width+15)&~15);p.height=std::max(32,(height+7)&~7);p.pix_fmt=MC_PIXEL_FORMAT_NV12;
  p.bitstream_buf_size=std::max<uint64_t>(8192,(uint64_t(p.width)*p.height*3/2+4095)&~uint64_t(4095));
  p.frame_buf_count=3;p.bitstream_buf_count=3;p.external_frame_buf=false;
  p.gop_params.gop_preset_idx=1;p.rot_degree=MC_CCW_0;p.mir_direction=MC_DIRECTION_NONE;
  p.enable_user_pts=true;p.jpeg_enc_config.quality_factor=quality;
  p.jpeg_enc_config.restart_interval=p.width/16;
  Check(hb_mm_mc_initialize(&c),"Initialize JPU");s.initialized=true;
  Check(hb_mm_mc_configure(&c),"Configure JPU");mc_av_codec_startup_params_t start{};
  Check(hb_mm_mc_start(&c,&start),"Start JPU");s.started=true;
}
JpegEncoder::~JpegEncoder()=default;
std::vector<uint8_t> JpegEncoder::EncodeFullRangeNv12(const std::vector<uint8_t>& pixels,int visible_width,int visible_height){
  auto& s=*state_;std::lock_guard<std::mutex> lock(s.mutex);
  if(pixels.size()!=size_t(s.width)*s.height*3/2)throw std::invalid_argument("Incorrect packed NV12 size");
  const int vw=visible_width?visible_width:s.visible_width;
  const int vh=visible_height?visible_height:s.visible_height;
  if(vw<=0||vh<=0||vw>s.width||vh>s.height||
     (vw+15)/16!=(s.width+15)/16||(vh+15)/16!=(s.height+15)/16)
    throw std::invalid_argument("Visible JPEG size must preserve the MCU grid");
  if(s.failed)throw std::runtime_error("JPU failed; recreate encoder");
  try{
    media_codec_buffer_t input{};
    Check(hb_mm_mc_dequeue_input_buffer(&s.context,&input,2000),"Acquire JPU input");
    auto& v=input.vframe_buf;const auto& params=s.context.video_enc_params;
    int ew=params.width,eh=params.height;
    int ys=v.stride>0?v.stride:ew,uvs=v.vstride>0?v.vstride:ys;
    if(ys<ew||uvs<ew||!v.vir_ptr[0]||!v.vir_ptr[1])throw std::runtime_error("Unsupported JPU input layout");
    input.type=MC_VIDEO_FRAME_BUFFER;v.width=ew;v.height=eh;v.pix_fmt=MC_PIXEL_FORMAT_NV12;
    v.size=size_t(ew)*eh*3/2;v.pts=0;v.frame_end=false;
    for(int y=0;y<eh;++y){
      auto src=pixels.data()+size_t(std::min(y,s.height-1))*s.width;auto dst=v.vir_ptr[0]+size_t(y)*ys;
      std::memcpy(dst,src,s.width);std::fill(dst+s.width,dst+ew,src[s.width-1]);
    }
    for(int y=0;y<eh/2;++y){
      auto src=pixels.data()+size_t(s.width)*s.height+size_t(std::min(y,s.height/2-1))*s.width;
      auto dst=v.vir_ptr[1]+size_t(y)*uvs;std::memcpy(dst,src,s.width);
      for(int x=s.width;x<ew;x+=2){dst[x]=src[s.width-2];dst[x+1]=src[s.width-1];}
    }
    Check(hb_mm_mc_queue_input_buffer(&s.context,&input,2000),"Submit JPU input");
    media_codec_buffer_t output{};media_codec_output_buffer_info_t info{};
    Check(hb_mm_mc_dequeue_output_buffer(&s.context,&output,&info,2000),"Receive JPEG");
    struct Release {State& s;media_codec_buffer_t& buffer;bool active=true;
      ~Release(){if(active)hb_mm_mc_queue_output_buffer(&s.context,&buffer,2000);}} release{s,output};
    auto& bytes=output.vstream_buf;
    if(!bytes.vir_ptr||bytes.size<4||bytes.size>s.context.video_enc_params.bitstream_buf_size)
      throw std::runtime_error("Invalid JPU output");
    std::vector<uint8_t> jpeg(bytes.vir_ptr,bytes.vir_ptr+bytes.size);
    Check(hb_mm_mc_queue_output_buffer(&s.context,&output,2000),"Release JPEG buffer");release.active=false;
    // JPU may pad its aligned output buffer with zeroes after JPEG EOI.
    while(jpeg.size()>4&&jpeg.back()==0)jpeg.pop_back();
    if(jpeg[0]!=0xff||jpeg[1]!=0xd8||jpeg[jpeg.size()-2]!=0xff||jpeg.back()!=0xd9)
      throw std::runtime_error("Incomplete JPEG output");
    // This SDK emits a two-byte APP9 frame counter, which decoders try to
    // interpret as JPEG XT. Remove only this short vendor segment.
    std::vector<uint8_t> normalized{0xff,0xd8};size_t offset=2;bool dimensions_set=false;
    while(offset<jpeg.size()){
      if(jpeg[offset]!=0xff)throw std::runtime_error("Invalid JPEG header marker");
      while(offset<jpeg.size()&&jpeg[offset]==0xff)++offset;
      if(offset+2>=jpeg.size())throw std::runtime_error("Truncated JPEG header");
      uint8_t marker=jpeg[offset++];size_t length=(size_t(jpeg[offset])<<8)|jpeg[offset+1];
      if(length<2||length>jpeg.size()-offset)throw std::runtime_error("Invalid JPEG segment length");
      if(marker==0xc0){
        // Baseline 4:2:0 uses 16x16 MCUs. Padding to 16x8 leaves the MCU grid
        // unchanged; SOF can retain the requested visible size without
        // recompressing pixels or changing the restart interval.
        if(dimensions_set||length!=17||jpeg[offset+2]!=8||jpeg[offset+7]!=3||
           jpeg[offset+9]!=0x22||jpeg[offset+12]!=0x11||jpeg[offset+15]!=0x11||
           ((int(jpeg[offset+3])<<8)|jpeg[offset+4])!=eh||
           ((int(jpeg[offset+5])<<8)|jpeg[offset+6])!=ew||
           (s.width+15)/16!=(ew+15)/16||(s.height+15)/16!=(eh+15)/16)
          throw std::runtime_error("Unexpected JPEG layout for visible-size cropping");
        jpeg[offset+3]=vh>>8;jpeg[offset+4]=vh&255;
        jpeg[offset+5]=vw>>8;jpeg[offset+6]=vw&255;dimensions_set=true;
      }
      bool empty_app9=marker==0xe9&&length==4;
      if(!empty_app9){
        normalized.push_back(0xff);normalized.push_back(marker);
        normalized.insert(normalized.end(),jpeg.begin()+offset,jpeg.begin()+offset+length);
      }
      offset+=length;
      if(marker==0xda){
        if(!dimensions_set)throw std::runtime_error("JPEG frame header missing");
        // Keep entropy data and restart markers unchanged. Only normalize
        // header fill bytes, which older FFmpeg treats as malformed APP data.
        normalized.insert(normalized.end(),jpeg.begin()+offset,jpeg.end());
        return normalized;
      }
    }
    throw std::runtime_error("Missing JPEG scan");
  }catch(...){s.failed=true;throw;}
}
}
