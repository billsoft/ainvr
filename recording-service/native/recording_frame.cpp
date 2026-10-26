// Exact MP4 packet recovery. Demux on CPU; decoding, scaling and JPEG on hardware.
#include "vpu_decoder.hpp"
#include "gles_preprocess.hpp"
#include "jpeg_encoder.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/bsf.h>
}
int main(int argc,char** argv){
 try{
  if(argc!=5)throw std::runtime_error("invalid_arguments");
  const auto target=std::stoll(argv[2]);const auto seconds=std::stod(argv[3]);
  if(target<0||seconds<0||seconds>86400)throw std::runtime_error("invalid_target");
  AVFormatContext* in=nullptr;
  if(avformat_open_input(&in,argv[1],nullptr,nullptr)<0||avformat_find_stream_info(in,nullptr)<0)throw std::runtime_error("invalid_recording");
  int vi=av_find_best_stream(in,AVMEDIA_TYPE_VIDEO,-1,-1,nullptr,0);if(vi<0)throw std::runtime_error("no_video");
  auto* st=in->streams[vi];auto* cp=st->codecpar;bool h264=cp->codec_id==AV_CODEC_ID_H264;
  if(!h264&&cp->codec_id!=AV_CODEC_ID_HEVC)throw std::runtime_error("unsupported_codec");
  if(cp->width<32||cp->height<32||cp->width>8192||cp->height>8192)throw std::runtime_error("unsupported_dimensions");
  AVBSFContext* bsf=nullptr;av_bsf_alloc(av_bsf_get_by_name(h264?"h264_mp4toannexb":"hevc_mp4toannexb"),&bsf);
  if(!bsf)throw std::runtime_error("bsf_unavailable");
  avcodec_parameters_copy(bsf->par_in,cp);bsf->time_base_in=st->time_base;if(av_bsf_init(bsf)<0)throw std::runtime_error("bsf_init");
  // Seek to a preceding keyframe; packet position, not a rounded timestamp, selects the image.
  av_seek_frame(in,vi,int64_t(std::max(0.0,seconds-2)/av_q2d(st->time_base)),AVSEEK_FLAG_BACKWARD);
  ainvr::VpuDecoder decoder(h264?ainvr::Codec::H264:ainvr::Codec::H265,cp->width,cp->height);
  ainvr::GlesPreprocessor color;bool found=false;
  auto receive=[&](int wait){auto frame=decoder.Receive(wait);if(!frame)return;
   if(frame->pts!=uint64_t(target))return;
   if(frame->width<cp->width||frame->height<cp->height)throw std::runtime_error("decoded_dimensions");
   double scale=std::min(1.0,1280.0/std::max(cp->width,cp->height));
   ainvr::ImageTransform t;t.width=int(cp->width*scale)/2*2;t.height=int(cp->height*scale)/2*2;t.letterbox=false;
   t.source_region=std::array<float,4>{0,0,float(cp->width),float(cp->height)};
   t.yuv_bt709=cp->color_space==AVCOL_SPC_BT709;t.yuv_full_range=cp->color_range==AVCOL_RANGE_JPEG;
   auto rgba=color.RunNv12Rgba(frame->pixels,frame->width,frame->height,t);
   ainvr::ImageTransform encode;encode.width=t.width;encode.height=t.height;encode.yuv_full_range=true;
   auto nv12=color.RunRgbaJpegNv12(rgba,t.width,t.height,encode);ainvr::JpegEncoder jpeg(t.width,t.height,85);
   auto bytes=jpeg.EncodeFullRangeNv12(nv12);if(bytes.size()>2*1024*1024)throw std::runtime_error("image_capacity");
   std::ofstream out(argv[4],std::ios::binary);out.write(reinterpret_cast<char*>(bytes.data()),bytes.size());if(!out)throw std::runtime_error("write_failed");found=true;
  };
  auto end=std::chrono::steady_clock::now()+std::chrono::seconds(20);auto* packet=av_packet_alloc();auto* au=av_packet_alloc();int packets=0;
  while(!found&&packets<1800&&std::chrono::steady_clock::now()<end&&av_read_frame(in,packet)>=0){
   if(packet->stream_index==vi){++packets;
    if(packet->pos<0)throw std::runtime_error("packet_identity_missing");
    // Preserve original file position through the bitstream filter.
    packet->pts=packet->pos;packet->dts=packet->pos;
    if(av_bsf_send_packet(bsf,packet)<0)throw std::runtime_error("bsf_submit");
    while(av_bsf_receive_packet(bsf,au)>=0){std::vector<uint8_t> bytes(au->data,au->data+au->size);
     while(!decoder.Submit(bytes,uint64_t(au->pts),20)){receive(20);if(std::chrono::steady_clock::now()>end)throw std::runtime_error("decode_timeout");}
     receive(20);av_packet_unref(au);
    }
   }av_packet_unref(packet);
  }
  if(!found){decoder.Finish(100);for(int i=0;i<20&&!found;i++)receive(50);}
  av_packet_free(&packet);av_packet_free(&au);av_bsf_free(&bsf);avformat_close_input(&in);
  if(!found)throw std::runtime_error("exact_frame_unavailable");return 0;
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
