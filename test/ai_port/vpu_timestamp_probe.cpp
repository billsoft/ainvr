// Copyright AINVR. Diagnostic only: compare SDK display metadata with input tokens.
#include "stream/media_source.hpp"
#include "platform/media_memory.hpp"
#include <hb_media_codec.h>
#include <hb_media_error.h>
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstring>
#include <fstream>
#include <filesystem>
#include <iostream>
extern "C" {
#include <libavcodec/avcodec.h>
}
struct Parser {
  AVCodecParserContext* p=nullptr;AVCodecContext* c=nullptr;
  ~Parser(){av_parser_close(p);avcodec_free_context(&c);}
};
void check(int rc){if(rc)throw std::runtime_error("SDK error "+std::to_string(rc));}
struct Context {
  media_codec_context_t c{};bool initialized=false,started=false;
  ~Context(){if(started)hb_mm_mc_pause(&c);if(initialized)hb_mm_mc_release(&c);}
};
int main(int argc,char**argv){try{
  if(argc!=4)throw std::runtime_error("Usage: probe input.mp4 output.yuv output.json");
  if(std::filesystem::exists(argv[2])||std::filesystem::exists(argv[3]))throw std::runtime_error("Output exists");
  ainvr::MediaSource source(argv[1]);auto info=source.Info();
  if(info.codec!=ainvr::Codec::H264&&info.codec!=ainvr::Codec::H265)throw std::runtime_error("Expected H264/H265");
  Parser parser;parser.p=av_parser_init(info.codec==ainvr::Codec::H264?AV_CODEC_ID_H264:AV_CODEC_ID_HEVC);
  parser.c=avcodec_alloc_context3(nullptr);
  if(!parser.p||!parser.c)throw std::runtime_error("Parser allocation failed");
  parser.p->flags|=PARSER_FLAG_COMPLETE_FRAMES;
  ainvr::EnsureMediaMemory();Context context;auto& c=context.c;auto& p=c.video_dec_params;
  c.encoder=false;c.codec_id=info.codec==ainvr::Codec::H264?MEDIA_CODEC_ID_H264:MEDIA_CODEC_ID_H265;
  p.feed_mode=MC_FEEDING_MODE_FRAME_SIZE;p.pix_fmt=MC_PIXEL_FORMAT_NV12;
  p.bitstream_buf_size=(uint64_t(info.width)*info.height*3/2+1023)&~uint64_t(1023);
  p.bitstream_buf_count=4;p.frame_buf_count=6;
  if(info.codec==ainvr::Codec::H264){p.h264_dec_config.bandwidth_Opt=true;p.h264_dec_config.reorder_enable=true;}
  else {p.h265_dec_config.bandwidth_Opt=true;p.h265_dec_config.reorder_enable=true;}
  check(hb_mm_mc_initialize(&c));context.initialized=true;check(hb_mm_mc_configure(&c));
  mc_av_codec_startup_params_t startup{};check(hb_mm_mc_start(&c,&startup));context.started=true;
  nlohmann::json inputs=nlohmann::json::array(),outputs=nlohmann::json::array();
  std::ofstream pixels(argv[2],std::ios::binary);if(!pixels)throw std::runtime_error("Open output failed");
  auto receive=[&](int timeout){
    media_codec_buffer_t out{};media_codec_output_buffer_info_t meta{};
    int rc=hb_mm_mc_dequeue_output_buffer(&c,&out,&meta,timeout);
    if(rc==HB_MEDIA_ERR_WAIT_TIMEOUT)return false;check(rc);
    auto& v=out.vframe_buf;auto& m=meta.video_frame_info;
    outputs.push_back({{"token",v.pts},{"display_index",m.frame_display_index},
      {"decoded_index",m.frame_decoded_index},{"display_poc",m.display_poc},
      {"decoded_poc",m.decoded_poc},{"decode_result",m.decode_result},
      {"sequence",m.sequence_no},{"frame_end",v.frame_end}});
    int w=v.width,h=v.height,ys=v.stride>0?v.stride:w,uvs=v.vstride>0?v.vstride:ys;
    if(w!=info.width||h!=info.height||!v.vir_ptr[0]||!v.vir_ptr[1])throw std::runtime_error("Unexpected frame layout");
    for(int y=0;y<h;++y)pixels.write(reinterpret_cast<char*>(v.vir_ptr[0]+y*ys),w);
    for(int y=0;y<h/2;++y)pixels.write(reinterpret_cast<char*>(v.vir_ptr[1]+y*uvs),w);
    check(hb_mm_mc_queue_output_buffer(&c,&out,1000));return true;
  };
  auto submit=[&](const std::vector<uint8_t>& bytes,uint64_t token,bool eos){
    auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
    media_codec_buffer_t in{};int rc;
    while((rc=hb_mm_mc_dequeue_input_buffer(&c,&in,50))==HB_MEDIA_ERR_WAIT_TIMEOUT){
      receive(50);if(std::chrono::steady_clock::now()>deadline)throw std::runtime_error("Input stalled");
    }check(rc);if(bytes.size()>p.bitstream_buf_size)throw std::runtime_error("Packet too large");
    in.type=MC_VIDEO_STREAM_BUFFER;in.vstream_buf.size=bytes.size();in.vstream_buf.pts=token;in.vstream_buf.stream_end=eos;
    if(!bytes.empty())std::memcpy(in.vstream_buf.vir_ptr,bytes.data(),bytes.size());
    check(hb_mm_mc_queue_input_buffer(&c,&in,1000));receive(50);
  };
  while(auto packet=source.Read()){
    if(inputs.size()>=120)throw std::runtime_error("Diagnostic limit: 120 packets");
    auto padded=packet->bytes;padded.resize(padded.size()+AV_INPUT_BUFFER_PADDING_SIZE);
    uint8_t* parsed=nullptr;int parsed_size=0;
    int consumed=av_parser_parse2(parser.p,parser.c,&parsed,&parsed_size,padded.data(),packet->bytes.size(),AV_NOPTS_VALUE,AV_NOPTS_VALUE,0);
    if(consumed<0||parsed_size!=int(packet->bytes.size()))throw std::runtime_error("Incomplete parser output");
    uint64_t token=1000+inputs.size();inputs.push_back({{"token",token},{"pts_ns",packet->pts_ns.value_or(-1)},
      {"parser_poc",parser.p->output_picture_number},{"keyframe",parser.p->key_frame}});
    submit(packet->bytes,token,false);
  }
  submit({},999999,true);
  auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
  while(outputs.size()<inputs.size()&&std::chrono::steady_clock::now()<deadline)receive(100);
  pixels.close();if(!pixels)throw std::runtime_error("Write failed");
  std::ofstream report(argv[3]);report<<nlohmann::json({{"inputs",inputs},{"outputs",outputs}}).dump(2);report.close();
  if(!report||outputs.size()!=inputs.size())throw std::runtime_error("Incomplete diagnostic");
  std::cout<<"frames="<<outputs.size()<<"\n";return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<"\n";return 1;}}
