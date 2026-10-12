// Copyright AINVR. Geometry/color -> full-range NV12 -> JPU integration.
#include "platform/image_preprocessor.hpp"
#include "platform/jpeg_encoder.hpp"
#include <nlohmann/json.hpp>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <cmath>
int main(int argc,char**argv){try{
  if(argc!=2||!std::filesystem::create_directory(argv[1]))throw std::runtime_error("Expected new output directory");
  std::filesystem::path root(argv[1]);nlohmann::json cases=nlohmann::json::array();
  struct Case{int w,h,ow,oh;bool erp,bt709,full;const char* backend;};
  Case specs[]={{640,360,638,358,false,false,false,"pym+gles-color"},
    {640,360,640,360,false,true,false,"gles"},{640,360,640,360,false,true,true,"gles"},
    {1920,1080,640,360,false,false,false,"pym+gles-color"},
    {1920,960,640,360,true,true,false,"gdc+gles-color"},
    {7680,3840,640,360,true,true,false,"gles"},
    {7680,3840,7680,3840,false,true,false,"gles"}};
  int index=0;
  for(auto c:specs){
    ainvr::Nv12Frame input;input.width=c.w;input.height=c.h;input.pixels.resize(size_t(c.w)*c.h*3/2);
    for(int y=0;y<c.h;++y)for(int x=0;x<c.w;++x)input.pixels[size_t(y)*c.w+x]=32+(160*x/c.w+32*y/c.h)%190;
    for(size_t i=size_t(c.w)*c.h;i<input.pixels.size();i+=2){input.pixels[i]=100;input.pixels[i+1]=155;}
    ainvr::ImageTransform t;t.width=c.ow;t.height=c.oh;t.letterbox=false;
    t.erp_perspective=c.erp;t.horizontal_fov=1.3f;t.yaw=.2f;t.pitch=.1f;t.yuv_bt709=c.bt709;t.yuv_full_range=c.full;
    ainvr::PreprocessedImage accelerated;
    {ainvr::ImagePreprocessor hardware;accelerated=hardware.RunJpegNv12(input,t);}
    ainvr::PreprocessedImage reference;
    {ainvr::ImagePreprocessor cpu({false,false,true});reference=cpu.RunJpegNv12(input,t);}
    if(accelerated.backend!=c.backend||!accelerated.fallback_reasons.empty())throw std::runtime_error("Unexpected backend "+accelerated.backend);
    if(accelerated.jpeg_nv12.size()!=size_t(c.ow)*c.oh*3/2||accelerated.jpeg_nv12.size()!=reference.jpeg_nv12.size())throw std::runtime_error("Invalid output size");
    double sum=0;int maximum=0;
    for(size_t i=0;i<reference.jpeg_nv12.size();++i){int d=std::abs(int(accelerated.jpeg_nv12[i])-int(reference.jpeg_nv12[i]));sum+=d;maximum=std::max(maximum,d);}
    double mae=sum/reference.jpeg_nv12.size();if(mae>1.5)throw std::runtime_error("Color/geometry mismatch "+std::to_string(mae));
    std::string name=std::to_string(index++);
    bool encoded=true;
    if(encoded){
      ainvr::JpegEncoder encoder(c.ow,c.oh,90);auto jpeg=encoder.EncodeFullRangeNv12(accelerated.jpeg_nv12);
      std::ofstream file(root/(name+".jpg"),std::ios::binary);file.write(reinterpret_cast<char*>(jpeg.data()),jpeg.size());file.close();
      if(!file)throw std::runtime_error("JPEG write failed");
    }
    std::ofstream ref(root/(name+".nv12"),std::ios::binary);ref.write(reinterpret_cast<char*>(reference.jpeg_nv12.data()),reference.jpeg_nv12.size());ref.close();
    if(!ref)throw std::runtime_error("Reference write failed");
    cases.push_back({{"case",name},{"width",c.ow},{"height",c.oh},{"backend",accelerated.backend},
      {"erp",c.erp},{"bt709",c.bt709},{"full_range",c.full},{"gpu_cpu_mae",mae},{"gpu_cpu_max",maximum},{"jpeg_encoded",encoded}});
  }
  std::ofstream report(root/"summary.json");report<<nlohmann::json({{"cases",cases}}).dump(2);report.close();
  if(!report)throw std::runtime_error("Report write failed");std::cout<<cases.dump()<<"\n";return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<"\n";return 1;}}
