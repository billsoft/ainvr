// Copyright AINVR.
#include "output/snapshot_renderer.hpp"
#include <nlohmann/json.hpp>
#include <filesystem>
#include <fstream>
#include <iostream>
int main(int argc,char**argv){try{
  if(argc!=2||!std::filesystem::create_directory(argv[1]))throw std::runtime_error("Expected new output directory");
  std::filesystem::path out(argv[1]);
  ainvr::Nv12Frame frame;frame.width=640;frame.height=320;frame.pixels.resize(640*320*3/2,128);
  std::fill_n(frame.pixels.begin(),640*320,100);
  ainvr::SnapshotRenderer renderer;
  ai_service::config::SnapshotConfig cfg;cfg.padding_ratio=0;cfg.max_crop_dimension=320;cfg.jpeg_quality=90;
  if(renderer.RenderOriginal(frame,{100,100,80,80},cfg,false,false,true))throw std::runtime_error("Disabled snapshot emitted");
  cfg.enabled=true;
  if(renderer.RenderOriginal(frame,{0,0,0,10},cfg,false,false,true))throw std::runtime_error("Invalid detection emitted");
  nlohmann::json cases=nlohmann::json::array();
  for(int i=0;i<6;++i){
    cfg.projection_mode=i==4?"erp_equirect":"none";
    std::array<double,4> box=i==0?std::array<double,4>{100,100,80,80}:i==1?std::array<double,4>{10,10,21,19}:i==2?std::array<double,4>{10,10,1,1}:i==3?std::array<double,4>{10,10,2,2}:std::array<double,4>{240,120,80,80};
    auto image=renderer.RenderOriginal(frame,box,cfg,false,false,true);if(!image)throw std::runtime_error("Missing snapshot");
    if(i==0&&image->encoder_backend!="jpu")throw std::runtime_error("JPU was not used");
    if(i>=1&&i<=3&&image->encoder_backend!="cpu-libjpeg")throw std::runtime_error("Missing CPU encoder fallback");
    std::ofstream file(out/(std::to_string(i)+".jpg"),std::ios::binary);file.write(reinterpret_cast<const char*>(image->jpeg.data()),image->jpeg.size());if(!file)throw std::runtime_error("JPEG write failed");
    cases.push_back({{"name",std::to_string(i)},{"width",image->plan.width},{"height",image->plan.height},{"render",image->render_backend},{"encoder",image->encoder_backend},{"erp",image->plan.perspective}});
  }
  cfg.jpeg_quality=101;bool rejected=false;
  try{renderer.RenderOriginal(frame,{10,10,80,80},cfg,false,false,true);}catch(const std::invalid_argument&){rejected=true;}
  if(!rejected)throw std::runtime_error("Invalid quality accepted");
  std::ofstream report(out/"summary.json");report<<cases.dump(2);if(!report)throw std::runtime_error("Report failed");
}catch(const std::exception&e){std::cerr<<e.what()<<"\n";return 1;}}
