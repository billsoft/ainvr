// Copyright AINVR. Real Mali NV12->RGB8->Pillow-compatible resize routing.
#include "platform/locateanything_pillow_preprocess.hpp"
#include <nlohmann/json.hpp>
#include <array>
#include <chrono>
#include <iostream>
int main(){
  ainvr::GlesPreprocessor reference_color;
  ainvr::LocateAnythingPillowPreprocessor model_images;
  nlohmann::json rows=nlohmann::json::array();
  for(auto dims:{std::array<int,2>{3840,2160},{7680,3840},{3840,2160}}){
    const auto [w,h]=dims;
    std::vector<uint8_t> pixels(size_t(w)*h*3/2,128);
    for(int y=0;y<h;++y)for(int x=0;x<w;++x)pixels[size_t(y)*w+x]=uint8_t(32+(x/11+y/7)%192);
    for(size_t i=size_t(w)*h;i<pixels.size();i+=2){pixels[i]=100;pixels[i+1]=154;}
    for(bool bt709:{false,true})for(bool full:{false,true}){
      ainvr::ImageTransform identity;identity.width=w;identity.height=h;
      identity.letterbox=false;identity.nearest=true;identity.yuv_bt709=bt709;identity.yuv_full_range=full;
      const auto rgba=reference_color.RunNv12Rgba(pixels,w,h,identity);
      const auto reference=model_images.RunRgba(rgba,w,h);
      const auto start=std::chrono::steady_clock::now();
      const auto a=model_images.RunNv12(pixels,w,h,bt709,full);
      const auto b=model_images.RunNv12(pixels,w,h,bt709,full);
      if(a!=reference || a!=b)throw std::runtime_error("NV12 model preprocessing differs from composed GPU reference");
      rows.push_back({{"size",{h,w}},{"bt709",bt709},{"full_range",full},
        {"composed_gpu_reference_exact",true},{"repeat_exact",true},
        {"two_nv12_calls_ms",std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count()}});
    }
  }
  int rejected=0;
  auto bad=[&](auto action){try{action();}catch(const std::invalid_argument&){++rejected;return;}throw std::runtime_error("Invalid image accepted");};
  bad([&]{model_images.RunRgba({},0,0);});
  bad([&]{model_images.RunRgba({},3840,2160);});
  bad([&]{model_images.RunNv12({},33,32,true,false);});
  bad([&]{model_images.RunNv12({},8194,32,true,false);});
  std::cout<<nlohmann::json{{"status","passed"},{"cases",rows},{"invalid_inputs_rejected",rejected},
    {"neural_calls",0},{"cpu_pixel_filtering",false},{"backend","gles-pillow9-rgb8"},
    {"scope","Actual NV12 color and resize composition,12cases48calls;not full model or original RGB codec fidelity"}}.dump()<<"\n";
}
