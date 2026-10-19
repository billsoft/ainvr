// AINVR. Original archive JPEG -> JPU -> Mali -> LocateAnything RGB tensor.
#pragma once
#include "../platform/vpu_decoder.hpp"
#include "../platform/locateanything_pillow_preprocess.hpp"
#include <chrono>
#include <functional>
namespace ai_service::analytics {
inline std::pair<int,int> JpegDimensions(const std::vector<uint8_t>& bytes) {
  if(bytes.size()<4||bytes.size()>16U*1024*1024||bytes[0]!=255||bytes[1]!=216)
    throw std::invalid_argument("Invalid review JPEG");
  size_t p=2;
  while(p<bytes.size()) {
    if(bytes[p++]!=255)throw std::invalid_argument("Invalid JPEG marker");
    while(p<bytes.size()&&bytes[p]==255)++p;
    if(p>=bytes.size())break;
    const auto marker=bytes[p++];
    if(marker==0xda||marker==0xd9)break;
    if(marker==0x01||(marker>=0xd0&&marker<=0xd7))continue;
    if(p+2>bytes.size())break;
    const size_t length=(size_t(bytes[p])<<8)|bytes[p+1];
    if(length<2||length>bytes.size()-p)throw std::invalid_argument("Truncated JPEG segment");
    if(marker==0xc0||marker==0xc1||marker==0xc2) {
      if(length<8||bytes[p+2]!=8)throw std::invalid_argument("Unsupported JPEG precision");
      const int h=(int(bytes[p+3])<<8)|bytes[p+4],w=(int(bytes[p+5])<<8)|bytes[p+6];
      if(w<1||h<1||w>8192||h>8192)throw std::invalid_argument("Invalid JPEG dimensions");
      return {w,h};
    }
    p+=length;
  }
  throw std::invalid_argument("JPEG has no supported frame header");
}
class ReviewImage {
 public:
  std::vector<float> Prepare(const std::vector<uint8_t>& jpeg,int width,int height,
      std::chrono::steady_clock::time_point deadline,const std::function<bool()>& cancelled) {
    if(JpegDimensions(jpeg)!=std::make_pair(width,height))
      throw std::invalid_argument("Review image metadata does not match JPEG");
    auto check=[&]{if((cancelled&&cancelled())||std::chrono::steady_clock::now()>=deadline)
      throw std::runtime_error("Review image preparation cancelled or timed out");};
    check();
    const int max_width=(width+15)&~15,max_height=(height+15)&~15;
    ainvr::VpuDecoder decoder(ainvr::Codec::Jpeg,max_width,max_height);
    while(!decoder.Submit(jpeg,0,50))check();
    std::optional<ainvr::Nv12Frame> frame;
    while(!frame){check();frame=decoder.Receive(50);}
    if(frame->width<width||frame->height<height)
      throw std::runtime_error("Decoded review image is smaller than source");
    check();
    if(!color_)color_=std::make_unique<ainvr::GlesPreprocessor>();
    ainvr::ImageTransform transform;transform.width=width;transform.height=height;
    transform.letterbox=false;transform.yuv_bt709=false;transform.yuv_full_range=true;
    transform.source_region=std::array<float,4>{0,0,float(width),float(height)};
    auto rgba=color_->RunNv12Rgba(frame->pixels,frame->width,frame->height,transform);
    check();
    if(!resize_)resize_=std::make_unique<ainvr::LocateAnythingPillowPreprocessor>();
    auto image=resize_->RunRgba(rgba,width,height);check();return image;
  }
 private:
  std::unique_ptr<ainvr::GlesPreprocessor> color_;
  std::unique_ptr<ainvr::LocateAnythingPillowPreprocessor> resize_;
};
}
