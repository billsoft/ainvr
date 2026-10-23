#include "image_pipeline.hpp"
#include "vpu_decoder.hpp"
#include <fstream>
#include <iostream>
#include <iterator>
#include <chrono>
int main(int argc,char** argv) {
  try {
    if(argc!=6&&argc!=10)throw std::invalid_argument("usage: image_probe rgba|jpeg INPUT WIDTH HEIGHT OUTPUT_F32");
    std::ifstream input(argv[2],std::ios::binary); if(!input)throw std::runtime_error("open input");
    std::vector<uint8_t> bytes{std::istreambuf_iterator<char>(input),{}};
    int width=std::stoi(argv[3]),height=std::stoi(argv[4]);
    ainvr::QwenReviewImagePipeline pipeline; std::vector<float> out;
    if(std::string(argv[1])=="rgba")out=pipeline.RunRgba(bytes,width,height);
    else if(std::string(argv[1])=="jpeg"||std::string(argv[1])=="target") {
      ainvr::VpuDecoder decoder(ainvr::Codec::Jpeg,width,height);
      if(!decoder.Submit(bytes,1,1000))throw std::runtime_error("JPEG submit timeout");
      auto frame=decoder.Receive(3000);
      if(!frame)throw std::runtime_error("JPEG decode timeout");
      if(std::string(argv[1])=="target"){
        if(argc!=10)throw std::invalid_argument("target requires normalized x1 y1 x2 y2");
        auto prepared=pipeline.RunTarget(frame->pixels,frame->width,frame->height,{std::stof(argv[6]),std::stof(argv[7]),std::stof(argv[8]),std::stof(argv[9])});
        auto context=pipeline.RunContext(frame->pixels,frame->width,frame->height,{std::stof(argv[6]),std::stof(argv[7]),std::stof(argv[8]),std::stof(argv[9])},{{.3f,.3f},{.7f,.3f},{.7f,.7f},{.3f,.7f}},.05f);
        std::ofstream marked(std::string(argv[5])+".context.jpg",std::ios::binary);marked.write(reinterpret_cast<const char*>(context.data()),context.size());
        out=std::move(prepared.first);std::ofstream jpeg(std::string(argv[5])+".jpg",std::ios::binary);jpeg.write(reinterpret_cast<const char*>(prepared.second.data()),prepared.second.size());
      }else out=pipeline.RunNv12(frame->pixels,frame->width,frame->height,false,true);
    }else throw std::invalid_argument("unsupported probe input");
    std::ofstream output(argv[5],std::ios::binary); output.write(reinterpret_cast<const char*>(out.data()),out.size()*4);
    if(!output)throw std::runtime_error("output write error");
    return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<std::endl;return 1;}
}
