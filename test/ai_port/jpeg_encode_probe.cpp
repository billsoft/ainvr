// Copyright AINVR. Changing-frame JPU regression fixture.
#include "platform/jpeg_encoder.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <fstream>
#include <filesystem>
#include <iostream>
int main(int argc,char**argv){try{
  if(argc!=4)throw std::runtime_error("Usage: probe width height new-output-directory");
  int w=std::stoi(argv[1]),h=std::stoi(argv[2]);std::filesystem::path dir(argv[3]);
  if(!std::filesystem::create_directory(dir))throw std::runtime_error("Output directory exists");
  ainvr::JpegEncoder encoder(w,h,90);
  bool rejected=false;try{encoder.EncodeFullRangeNv12({1,2,3});}catch(const std::invalid_argument&){rejected=true;}
  if(!rejected)throw std::runtime_error("Short input accepted");
  nlohmann::json results=nlohmann::json::array();
  for(int frame=0;frame<3;++frame){
    std::vector<uint8_t> pixels(size_t(w)*h*3/2);
    for(int y=0;y<h;++y)for(int x=0;x<w;++x)pixels[size_t(y)*w+x]=32+frame*40+(x>=w/2?32:0)+(y>=h/2?24:0);
    for(size_t k=size_t(w)*h;k<pixels.size();k+=2){pixels[k]=90+frame*10;pixels[k+1]=160-frame*10;}
    auto start=std::chrono::steady_clock::now();auto jpeg=encoder.EncodeFullRangeNv12(pixels);
    double ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
    std::ofstream file(dir/(std::to_string(frame)+".jpg"),std::ios::binary);file.write(reinterpret_cast<char*>(jpeg.data()),jpeg.size());
    file.close();if(!file)throw std::runtime_error("Write failed");
    results.push_back({{"frame",frame},{"bytes",jpeg.size()},{"encode_ms",ms}});
  }
  std::ofstream report(dir/"summary.json");report<<nlohmann::json({{"backend","jpu"},{"width",w},{"height",h},{"frames",results}}).dump(2);
  report.close();if(!report)throw std::runtime_error("Report failed");return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<"\n";return 1;}}
