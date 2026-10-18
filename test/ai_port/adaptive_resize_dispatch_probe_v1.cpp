// Copyright AINVR. Actual hardware dispatch across changing decoded-frame sizes.
#include "platform/image_preprocessor.hpp"
#include <nlohmann/json.hpp>
#include <array>
#include <chrono>
#include <iostream>
int main(){
  ainvr::ImagePreprocessor processor;ainvr::ImageTransform t;
  nlohmann::json rows=nlohmann::json::array();
  for(auto dims:{std::array<int,2>{3840,2160},{5120,2880},{6144,3456},{7168,3584},{7680,3840},{3840,2160}}){
    const auto [w,h]=dims;
    ainvr::Nv12Frame input{w,h,42,std::vector<uint8_t>(size_t(w)*h*3/2,128)};
    for(int y=0;y<h;++y)for(int x=0;x<w;++x)input.pixels[size_t(y)*w+x]=uint8_t(48+(x>=w/2?48:0)+(y>=h/2?96:0));
    const auto start=std::chrono::steady_clock::now();
    const auto image=processor.RunNv12(input,t);
    const auto expected=w<=4096?"pym+gles-color":"gles";
    if(image.backend!=expected || !image.fallback_reasons.empty() || image.chw.size()!=640U*640*3)
      throw std::runtime_error("Adaptive backend differs: "+image.backend);
    const int resized_h=int(std::nearbyint(640.0*h/w)),top=(640-resized_h)/2;
    for(int c=0;c<3;++c)for(int y=0;y<2;++y)for(int x=0;x<2;++x){
      const int ox=160+x*320,oy=top+resized_h*(1+2*y)/4;
      const double value=(48+48*x+96*y-16)/219.0;
      if(std::abs(image.chw[size_t(c)*640*640+oy*640+ox]-value)>.008)
        throw std::runtime_error("Adaptive GPU/PYM geometry or colors differ");
    }
    rows.push_back({{"input_size",{w,h}},{"output_size",{640,640}},{"backend",image.backend},
      {"fallback_reasons",image.fallback_reasons},{"quadrants_checked",12},
      {"one_call_ms",std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count()}});
  }
  t.interpolation=ainvr::ImageInterpolation::Bicubic;
  ainvr::Nv12Frame frame{3840,2160,43,std::vector<uint8_t>(size_t(3840)*2160*3/2,128)};
  const auto cubic=processor.RunNv12(frame,t);
  if(cubic.backend!="gles")throw std::runtime_error("Bicubic was incorrectly sent to PYM");
  std::cout<<nlohmann::json{{"status","passed"},{"cases",rows},{"same_processor_instance",true},
    {"four_k_bicubic_backend",cubic.backend},{"neural_calls",0},
    {"scope","Actual decoded-NV12 preprocessing only;not video decoder,network,AI,SEI/archive or streaming FPS acceptance"}}.dump()<<"\n";
}
