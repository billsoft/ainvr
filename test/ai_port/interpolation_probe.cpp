// Copyright AINVR. Bounded hardware experiment; CPU pixels below are test oracles.
#include "platform/image_preprocessor.hpp"
#include "platform/cpu_preprocess.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
using nlohmann::json;
namespace fs=std::filesystem;
template<class T>void Save(const fs::path& p,const std::vector<T>& data){
  std::ofstream f(p,std::ios::binary);f.write(reinterpret_cast<const char*>(data.data()),data.size()*sizeof(T));
  if(!f)throw std::runtime_error("Cannot save fixture artifact");
}
int main(int argc,char** argv){
  try{
    if(argc==2&&std::string(argv[1])=="--validate-contract"){
      int rejected=0;
      auto bad=[&](auto action){try{action();}catch(const std::invalid_argument&){++rejected;return;}
        throw std::runtime_error("Invalid filter contract was accepted");};
      ainvr::ImageTransform t;t.interpolation=static_cast<ainvr::ImageInterpolation>(77);
      bad([&]{ainvr::ValidateInterpolation(t,16,8);});
      t.interpolation=ainvr::ImageInterpolation::Bicubic;t.nearest=true;
      bad([&]{ainvr::ValidateInterpolation(t,16,8);});
      t.nearest=false;t.interpolation=ainvr::ImageInterpolation::Area;t.erp_perspective=true;
      bad([&]{ainvr::ValidateInterpolation(t,16,8);});
      t.erp_perspective=false;t.width=1;t.height=1;
      bad([&]{ainvr::ValidateInterpolation(t,7680,3840);});
      t.width=2;t.height=2;ainvr::Nv12Frame input;input.width=4;input.height=4;input.pixels.assign(24,128);
      ainvr::ImagePreprocessor cpu_only({false,false,true});
      bad([&]{cpu_only.RunNv12(input,t);});
      std::cout<<json{{"passed",rejected==5},{"invalid_contracts_rejected",rejected},
        {"unsupported_cpu_oracle_rejected",true},{"inference_executed",false}}.dump()<<'\n';return 0;
    }
    if(argc!=11)throw std::invalid_argument("Usage: probe new-dir mode iw ih ow oh letterbox format repeats oracle");
    fs::path dir=argv[1];if(!fs::create_directory(dir))throw std::invalid_argument("Use a new fixture directory");
    int mode=std::stoi(argv[2]),w=std::stoi(argv[3]),h=std::stoi(argv[4]);
    int ow=std::stoi(argv[5]),oh=std::stoi(argv[6]),repeats=std::stoi(argv[9]);
    const std::string format=argv[8];bool nv12=format!="rgba",oracle=std::stoi(argv[10])!=0;
    if(w<=0||h<=0||w>8192||h>8192||ow<=0||oh<=0||repeats<1||repeats>30||(nv12&&(w%2||h%2)))
      throw std::invalid_argument("Unbounded fixture dimensions/repetitions");
    ainvr::ImageTransform t;t.width=ow;t.height=oh;t.letterbox=std::stoi(argv[7])!=0;
    t.interpolation=static_cast<ainvr::ImageInterpolation>(mode);
    t.mean={11,13,17};t.divisor={17,31,47};t.padding={114,99,128};t.bgr=true;
    t.yuv_bt709=format!="nv12_601_full";t.yuv_full_range=format=="nv12_601_full";
    ainvr::ValidateInterpolation(t,w,h);
    std::vector<uint8_t> pixels(size_t(w)*h*(nv12?3:4)/(nv12?2:1));
    if(nv12){
      for(int y=0;y<h;++y)for(int x=0;x<w;++x)pixels[size_t(y)*w+x]=32+(x*13+y*17)%192;
      for(int y=0;y<h/2;++y)for(int x=0;x<w/2;++x){
        size_t i=size_t(w)*h+size_t(y)*w+x*2;pixels[i]=108+(x*5+y*7)%41;pixels[i+1]=108+(x*11+y*3)%41;
      }
    }else{
      for(int y=0;y<h;++y)for(int x=0;x<w;++x){
        size_t i=(size_t(y)*w+x)*4;pixels[i]=(x*17+y*13)%256;
        pixels[i+1]=(x*7+y*29)%256;pixels[i+2]=((x/3+y/5)%2)*200+23;pixels[i+3]=255;
      }
    }
    ainvr::Nv12Frame frame;frame.width=w;frame.height=h;
    if(nv12)frame.pixels=std::move(pixels);
    if(oracle){
      Save(dir/(nv12?"input.nv12":"input.rgba"),nv12?frame.pixels:pixels);
      if(nv12){
        ainvr::ImageTransform identity;identity.width=w;identity.height=h;identity.letterbox=false;
        identity.mean={0,0,0};identity.divisor={1,1,1};identity.yuv_bt709=t.yuv_bt709;identity.yuv_full_range=t.yuv_full_range;
        auto floats=ainvr::CpuPreprocess(frame,identity);std::vector<uint8_t> rgb(size_t(w)*h*3);
        for(size_t i=0;i<size_t(w)*h;++i)for(size_t c=0;c<3;++c)
          rgb[i*3+c]=uint8_t(std::floor(std::clamp(floats[c*size_t(w)*h+i],0.f,255.f)+.5f));
        Save(dir/"source-rgb-cpu-oracle.u8",rgb);
      }
    }
    ainvr::GlesPreprocessor gpu;ainvr::ImagePreprocessor dispatcher;
    std::string backend;
    auto run=[&](){
      if(!nv12){backend="gles";return gpu.Run(pixels,w,h,t);}
      auto out=dispatcher.RunNv12(frame,t);backend=out.backend;
      if(mode!=0&&backend!="gles")throw std::runtime_error("Wrong filter dispatched to dedicated/CPU backend");
      return std::move(out.chw);
    };
    auto values=run();std::vector<double> ms;
    for(int i=0;i<repeats;++i){
      auto begin=std::chrono::steady_clock::now();values=run();
      ms.push_back(std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-begin).count());
    }
    if(!std::all_of(values.begin(),values.end(),[](float x){return std::isfinite(x);}))throw std::runtime_error("Nonfinite output");
    Save(dir/"output.f32",values);
    std::sort(ms.begin(),ms.end());double sum=0;for(double x:ms)sum+=x;
    json report={{"passed",true},{"input_size",{w,h}},{"output_size",{ow,oh}},{"format",format},
      {"interpolation_id",mode},{"letterbox",t.letterbox},{"mean",t.mean},{"divisor",t.divisor},{"padding",t.padding},
      {"bgr",t.bgr},{"backend",backend},{"repetitions",repeats},{"warm_mean_ms",sum/repeats},
      {"warm_p50_ms",ms[ms.size()/2]},{"warm_fps",1000/(sum/repeats)},{"inference_executed",false},
      {"cpu_color_conversion_is_test_oracle_only",oracle&&nv12},{"timing_includes_upload_and_host_readback",true}};
    std::ofstream(dir/"native.json")<<report.dump(2)<<'\n';std::cout<<report.dump()<<'\n';return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
