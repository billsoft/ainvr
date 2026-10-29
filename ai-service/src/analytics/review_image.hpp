// AINVR. Original archive JPEG -> JPU -> Mali -> LocateAnything RGB tensor.
#pragma once
#include "../platform/vpu_decoder.hpp"
#include "../platform/locateanything_pillow_preprocess.hpp"
#include <chrono>
#include <functional>
#include "jpeg_dimensions.hpp"
namespace ai_service::analytics {
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
