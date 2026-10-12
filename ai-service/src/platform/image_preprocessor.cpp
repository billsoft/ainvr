// Copyright AINVR.
#include "image_preprocessor.hpp"
#include "cpu_preprocess.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>
namespace ainvr {
PreprocessedImage ImagePreprocessor::RunNv12(const Nv12Frame& input,const ImageTransform& transform){
  return RunImpl(input,transform,false);
}
PreprocessedImage ImagePreprocessor::RunJpegNv12(const Nv12Frame& input,const ImageTransform& transform){
  if(transform.width%2||transform.height%2)throw std::invalid_argument("JPEG requires even output dimensions");
  auto t=transform;t.mean={0,0,0};t.divisor={1,1,1};t.bgr=false;
  return RunImpl(input,t,true);
}
PreprocessedImage ImagePreprocessor::RunImpl(const Nv12Frame& input,const ImageTransform& transform,bool jpeg){
  if(owner_!=std::this_thread::get_id())throw std::logic_error("Image preprocessor thread mismatch");
  ValidateTransform(input,transform);
  int ow=transform.width,oh=transform.height;
  if(transform.letterbox&&!transform.erp_perspective){
    double ratio=std::min(double(ow)/input.width,double(oh)/input.height);
    ow=std::nearbyint(input.width*ratio);oh=std::nearbyint(input.height*ratio);
  }
  Nv12Frame intermediate;const Nv12Frame* image=&input;
  ImageTransform final_transform=transform;std::string prefix;double configuration_ms=0;
  if(options_.dedicated_hardware&&!gdc_failed_&&transform.interpolation==ImageInterpolation::Bilinear&&GdcProjector::Supports(input.width,input.height,transform)){
    try{
      std::array<int,4> dims{input.width,input.height,transform.width,transform.height};
      std::array<float,3> angles{transform.yaw,transform.pitch,transform.horizontal_fov};
      if(!gdc_||gdc_dimensions_!=dims||gdc_angles_!=angles){
        gdc_.reset();gdc_=std::make_unique<GdcProjector>(input.width,input.height,transform);
        gdc_dimensions_=dims;gdc_angles_=angles;configuration_ms=gdc_->ConfigurationMilliseconds();
      }
      intermediate=gdc_->Run(input);image=&intermediate;prefix="gdc+";
      final_transform.erp_perspective=false;final_transform.letterbox=false;
    }catch(const std::runtime_error& e){gdc_.reset();gdc_failed_=true;failures_.push_back(std::string("GDC unavailable: ")+e.what());}
  }else if(options_.dedicated_hardware&&!pym_failed_&&!transform.nearest&&transform.interpolation==ImageInterpolation::Bilinear&&!transform.erp_perspective&&
           !transform.source_region&&(ow<input.width||oh<input.height)&&PymScaler::Supports(input.width,input.height,ow,oh)){
    try{
      std::array<int,4> dimensions{input.width,input.height,ow,oh};
      if(!pym_||dimensions_!=dimensions){
        pym_.reset();pym_=std::make_unique<PymScaler>(input.width,input.height,ow,oh);dimensions_=dimensions;
      }
      intermediate=pym_->Run(input);image=&intermediate;prefix="pym+";
    }catch(const std::runtime_error& e){pym_.reset();pym_failed_=true;failures_.push_back(std::string("PYM unavailable: ")+e.what());}
  }
  if(options_.gpu&&!gles_failed_){
    try{
      if(!gles_)gles_=std::make_unique<GlesPreprocessor>();
      if(jpeg){
        auto bytes=gles_->RunJpegNv12(image->pixels,image->width,image->height,final_transform);
        return {{},prefix+(prefix.empty()?"gles":"gles-color"),failures_,configuration_ms,std::move(bytes)};
      }
      auto values=gles_->RunNv12(image->pixels,image->width,image->height,final_transform);
      return {std::move(values),prefix+(prefix.empty()?"gles":"gles-color"),failures_,configuration_ms};
    }catch(const std::runtime_error& e){gles_.reset();gles_failed_=true;failures_.push_back(std::string("GLES unavailable: ")+e.what());}
  }
  if(!options_.cpu_reference)
    throw std::runtime_error("Image hardware unavailable; CPU image processing is disabled");
  auto rgb=CpuPreprocess(*image,final_transform);
  if(!jpeg)return {std::move(rgb),prefix+(prefix.empty()?"cpu":"cpu-color"),failures_,configuration_ms};
  size_t area=size_t(transform.width)*transform.height;std::vector<uint8_t> bytes(area*3/2);
  auto byte=[](float x){return uint8_t(std::floor(std::clamp(x,0.f,255.f)+0.5f));};
  for(size_t i=0;i<area;++i)bytes[i]=byte(0.299f*rgb[i]+0.587f*rgb[area+i]+0.114f*rgb[2*area+i]);
  for(int y=0;y<transform.height;y+=2)for(int x=0;x<transform.width;x+=2){
    float c[3]{};
    for(int dy=0;dy<2;++dy)for(int dx=0;dx<2;++dx){size_t i=size_t(y+dy)*transform.width+x+dx;
      for(int k=0;k<3;++k)c[k]+=rgb[k*area+i]*0.25f;}
    size_t uv=area+size_t(y/2)*transform.width+x;
    bytes[uv]=byte(128-0.168736f*c[0]-0.331264f*c[1]+0.5f*c[2]);
    bytes[uv+1]=byte(128+0.5f*c[0]-0.418688f*c[1]-0.081312f*c[2]);
  }
  return {{},prefix+(prefix.empty()?"cpu":"cpu-color"),failures_,configuration_ms,std::move(bytes)};
}
}
