// Copyright AINVR. Crop plans -> GLES/CPU -> hardware JPEG.
#include "output/snapshot_transform.hpp"
#include "platform/image_preprocessor.hpp"
#include "platform/jpeg_encoder.hpp"
#include <nlohmann/json.hpp>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <cmath>
int main(int argc,char**argv){try{
  if(argc!=2||!std::filesystem::create_directory(argv[1]))throw std::runtime_error("Expected new output directory");
  std::filesystem::path root(argv[1]);nlohmann::json results=nlohmann::json::array();
  struct Case {const char* name;int w,h;std::array<double,4> bbox;bool square;int maximum;};
  Case cases[]={
    {"interior",640,360,{120,80,240,180},false,160},
    {"top_left_replicate",640,360,{-20,-10,100,80},true,160},
    {"bottom_right_replicate",640,360,{600,320,80,60},true,160},
    {"eight_k",7680,3840,{3300,1500,400,300},true,320},
    {"odd",640,360,{10,10,21,19},false,320},
    {"tiny",640,360,{10,10,2,2},false,320}
  };
  for(auto c:cases){
    ainvr::Nv12Frame frame;frame.width=c.w;frame.height=c.h;frame.pixels.resize(size_t(c.w)*c.h*3/2,128);
    for(int y=0;y<c.h;++y)for(int x=0;x<c.w;++x)frame.pixels[size_t(y)*c.w+x]=32+160*x/c.w+32*y/c.h;
    ai_service::config::SnapshotConfig cfg;cfg.padding_ratio=0;cfg.max_crop_dimension=c.maximum;cfg.projection_mode="none";
    auto plan=ainvr::PlanSnapshot(c.bbox,c.w,c.h,cfg,c.square);if(!plan)throw std::runtime_error("Missing crop plan");
    auto t=ainvr::SnapshotTransform(*plan,false,true);
    ainvr::PreprocessedImage gpu,cpu;
    {ainvr::ImagePreprocessor p;gpu=p.RunNv12(frame,t);}
    {ainvr::ImagePreprocessor p({false,false,true});cpu=p.RunNv12(frame,t);}
    if(gpu.backend!="gles"||!gpu.fallback_reasons.empty())throw std::runtime_error("Unexpected crop backend "+gpu.backend);
    double sum=0;for(size_t i=0;i<cpu.chw.size();++i)sum+=std::abs(cpu.chw[i]-gpu.chw[i]);
    double mae=sum/cpu.chw.size();if(mae>0.1)throw std::runtime_error("Crop GPU/CPU mismatch");
    // Independent expected location, including replicated border. Grayscale
    // NV12 makes RGB luminance directly observable without color tolerances.
    auto r=plan->source_rectangle;
    for(int y=0;y<t.height;++y)for(int x=0;x<t.width;++x){
      double sx=std::clamp(r[0]+(x+.5)*r[2]/t.width-.5,0.,double(c.w-1));
      double sy=std::clamp(r[1]+(y+.5)*r[3]/t.height-.5,0.,double(c.h-1));
      double expected=32+160*sx/c.w+32*sy/c.h;
      if(std::abs(gpu.chw[size_t(y)*t.width+x]-expected)>2.1)throw std::runtime_error("Crop location or border mismatch");
    }
    bool encoded=t.width%2==0&&t.height%2==0&&t.width>=18&&t.height>=18;
    if(encoded){
      ainvr::PreprocessedImage nv;
      {ainvr::ImagePreprocessor p;nv=p.RunJpegNv12(frame,t);}
      ainvr::JpegEncoder encoder(t.width,t.height,90);auto jpeg=encoder.EncodeFullRangeNv12(nv.jpeg_nv12);
      std::ofstream jpg(root/(std::string(c.name)+".jpg"),std::ios::binary);jpg.write(reinterpret_cast<const char*>(jpeg.data()),jpeg.size());
      std::ofstream raw(root/(std::string(c.name)+".nv12"),std::ios::binary);raw.write(reinterpret_cast<const char*>(nv.jpeg_nv12.data()),nv.jpeg_nv12.size());
      if(!jpg||!raw)throw std::runtime_error("Output write failed");
    }
    results.push_back({{"name",c.name},{"width",t.width},{"height",t.height},{"backend",gpu.backend},{"mae",mae},{"encoded",encoded}});
  }
  // Reject conflicting options before entering a hardware path.
  ainvr::ImageTransform invalid;invalid.source_region=std::array<float,4>{0,0,10,10};
  bool rejected=false;try{ainvr::ValidateSourceRegion(invalid);}catch(const std::invalid_argument&){rejected=true;}
  if(!rejected)throw std::runtime_error("Letterbox/crop conflict was accepted");
  std::ofstream report(root/"summary.json");report<<results.dump(2);if(!report)throw std::runtime_error("Report write failed");
  std::cout<<results.dump()<<"\n";
}catch(const std::exception&e){std::cerr<<e.what()<<"\n";return 1;}}
