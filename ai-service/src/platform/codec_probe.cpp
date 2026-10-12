#include "vpu_decoder.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <iostream>
#include <memory>
extern "C" {
#include <libavformat/avformat.h>
}
int main(int argc,char** argv){
  try{
    if(argc!=5)throw std::invalid_argument("Usage: ainvr_decode_probe annexb.h264|annexb.h265|image.jpg max_width max_height expected_frames");
    AVFormatContext* raw=nullptr;
    if(avformat_open_input(&raw,argv[1],nullptr,nullptr)<0)throw std::runtime_error("Open input failed");
    auto close=[](AVFormatContext* p){avformat_close_input(&p);};std::unique_ptr<AVFormatContext,decltype(close)> input(raw,close);
    if(avformat_find_stream_info(raw,nullptr)<0)throw std::runtime_error("Read stream info failed");
    int video=av_find_best_stream(raw,AVMEDIA_TYPE_VIDEO,-1,-1,nullptr,0);
    if(video<0)throw std::runtime_error("No video stream");
    auto id=raw->streams[video]->codecpar->codec_id;ainvr::Codec codec;
    if(id==AV_CODEC_ID_H264)codec=ainvr::Codec::H264;
    else if(id==AV_CODEC_ID_HEVC)codec=ainvr::Codec::H265;
    else if(id==AV_CODEC_ID_MJPEG)codec=ainvr::Codec::Jpeg;
    else throw std::runtime_error("Unsupported codec");
    ainvr::VpuDecoder decoder(codec,std::stoi(argv[2]),std::stoi(argv[3]));
    auto free_packet=[](AVPacket* p){av_packet_free(&p);};std::unique_ptr<AVPacket,decltype(free_packet)> packet(av_packet_alloc(),free_packet);
    if(!packet)throw std::bad_alloc();
    int frames=0,packets=0;double sum_y=0;int width=0,height=0;
    auto receive=[&](int timeout){auto frame=decoder.Receive(timeout);if(!frame)return false;
      ++frames;width=frame->width;height=frame->height;uint64_t y=0;
      for(size_t k=0;k<size_t(width)*height;++k)y+=frame->pixels[k];sum_y+=double(y)/(width*height);return true;};
    int rc;
    while((rc=av_read_frame(raw,packet.get()))>=0){
      if(packet->stream_index==video){
        std::vector<uint8_t> bytes(packet->data,packet->data+packet->size);
        auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
        while(!decoder.Submit(bytes,packets,50)){receive(50);if(std::chrono::steady_clock::now()>deadline)throw std::runtime_error("Decoder input stalled");}
        ++packets;receive(50);
      }
      av_packet_unref(packet.get());
    }
    if(rc!=AVERROR_EOF)throw std::runtime_error("Demux error");
    auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
    if(codec!=ainvr::Codec::Jpeg){
      while(!decoder.Finish(50)){receive(50);if(std::chrono::steady_clock::now()>deadline)throw std::runtime_error("EOS stalled");}
    }
    int expected=std::stoi(argv[4]);
    while(frames<expected&&std::chrono::steady_clock::now()<deadline)receive(100);
    nlohmann::json report={{"packets",packets},{"decoded_frames",frames},{"expected_frames",expected},{"width",width},{"height",height},{"mean_y",frames?sum_y/frames:0},{"memory_path","VPU/JPU decoded NV12 copied to packed host storage"}};
    std::cout<<report.dump(2)<<'\n';return frames==expected?0:1;
  }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
