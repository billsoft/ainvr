#include "image_pipeline.hpp"
#include "vpu_decoder.hpp"
#include "request.hpp"
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
    // Historical crop audit: JPU returns MCU-aligned storage, while the JPEG
    // header describes visible pixels. Crop that padding on GLES, then fit the
    // complete original crop to the model canvas without CPU image conversion.
    if(std::string(argv[1])=="retained") {
      if(width<1||height<1||width>8192||height>4096)throw std::invalid_argument("invalid retained crop dimensions");
      ainvr::VpuDecoder decoder(ainvr::Codec::Jpeg,(width+63)/64*64,(height+63)/64*64,ainvr::JpegOutputLayout::EvenPaddedSurface);
      if(!decoder.Submit(bytes,1,1000))throw std::runtime_error("JPEG submit timeout");
      auto frame=decoder.Receive(3000);
      if(!frame||frame->visible_width!=width||frame->visible_height!=height)throw std::runtime_error("JPEG visible dimensions unavailable");
      ainvr::GlesPreprocessor color;
      ainvr::ImageTransform fit;fit.width=width;fit.height=height;fit.letterbox=false;fit.nearest=true;fit.yuv_full_range=true;
      fit.source_region=std::array<float,4>{0,0,float(width),float(height)};
      auto rgba=color.RunNv12Rgba(frame->pixels,frame->width,frame->height,fit);
      ainvr::ImageTransform encode;encode.width=896;encode.height=448;encode.yuv_full_range=true;
      auto nv12=color.RunRgbaJpegNv12(rgba,width,height,encode);
      ainvr::JpegEncoder encoder(896,448,90);auto jpeg=encoder.EncodeFullRangeNv12(nv12);
      std::ofstream output(argv[5],std::ios::binary);output.write(reinterpret_cast<const char*>(jpeg.data()),jpeg.size());
      if(!output)throw std::runtime_error("output write error");return 0;
    }
    ainvr::QwenReviewImagePipeline pipeline; std::vector<float> out;
    if(std::string(argv[1])=="rgba")out=pipeline.RunRgba(bytes,width,height);
    else if(std::string(argv[1])=="jpeg"||std::string(argv[1])=="target"||std::string(argv[1])=="target-jpeg") {
      const auto visible=ainvr::llm::JpegDimensions(bytes,true);
      if(visible[0]!=width||visible[1]!=height)throw std::invalid_argument("JPEG metadata does not match header");
      ainvr::VpuDecoder decoder(ainvr::Codec::Jpeg,(width+63)/64*64,(height+63)/64*64,ainvr::JpegOutputLayout::EvenPaddedSurface);
      if(!decoder.Submit(bytes,1,1000))throw std::runtime_error("JPEG submit timeout");
      auto frame=decoder.Receive(3000);
      if(!frame)throw std::runtime_error("JPEG decode timeout");
      if(frame->visible_width!=width||frame->visible_height!=height)throw std::runtime_error("JPEG visible geometry mismatch");
      if(std::string(argv[1])=="target"||std::string(argv[1])=="target-jpeg"){
        if(argc!=10)throw std::invalid_argument("target requires normalized x1 y1 x2 y2");
        auto prepared=pipeline.RunTarget(frame->pixels,frame->width,frame->height,{std::stof(argv[6]),std::stof(argv[7]),std::stof(argv[8]),std::stof(argv[9])},width,height);
        auto context=pipeline.RunContext(frame->pixels,frame->width,frame->height,{std::stof(argv[6]),std::stof(argv[7]),std::stof(argv[8]),std::stof(argv[9])},{{.3f,.3f},{.7f,.3f},{.7f,.7f},{.3f,.7f}},.05f,width,height);
        std::ofstream marked(std::string(argv[5])+".context.jpg",std::ios::binary);marked.write(reinterpret_cast<const char*>(context.data()),context.size());
        out=std::move(prepared.first);const bool jpeg_only=std::string(argv[1])=="target-jpeg";
        std::ofstream jpeg(std::string(argv[5])+(jpeg_only?"":".jpg"),std::ios::binary);jpeg.write(reinterpret_cast<const char*>(prepared.second.data()),prepared.second.size());
        if(!jpeg)throw std::runtime_error("JPEG output write error");if(jpeg_only)return 0;
      }else out=pipeline.RunNv12(frame->pixels,frame->width,frame->height,false,true,true,width,height);
    }else throw std::invalid_argument("unsupported probe input");
    std::ofstream output(argv[5],std::ios::binary); output.write(reinterpret_cast<const char*>(out.data()),out.size()*4);
    if(!output)throw std::runtime_error("output write error");
    return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<std::endl;return 1;}
}
