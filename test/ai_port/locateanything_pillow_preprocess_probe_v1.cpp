// Copyright AINVR. Actual Mali resize replay,strictly isolated image fixtures.
#include "platform/locateanything_pillow_preprocess.hpp"
#include <nlohmann/json.hpp>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <chrono>
int main(int argc,char**argv){
  if(argc!=2)return 2;
  const auto root=std::filesystem::canonical(argv[1]);
  if(root.parent_path()!=std::filesystem::path("/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1"))
    throw std::invalid_argument("Expected isolated task SSD fixtures");
  std::ifstream manifest(root/"manifest.json");nlohmann::json cases;manifest>>cases;
  ainvr::LocateAnythingPillowPreprocessor gpu;
  nlohmann::json results=nlohmann::json::array();
  for(const auto& c:cases){
    const int w=c.at("width"),h=c.at("height");
    const auto name=c.at("name").get<std::string>();
    if(name.empty() || name.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789-_")!=std::string::npos)
      throw std::invalid_argument("Invalid fixture name");
    const auto input=root/(name+".rgba"),output=root/(name+".chw.f32");
    if(std::filesystem::exists(output))throw std::invalid_argument("Output exists");
    if(std::filesystem::file_size(input)!=size_t(w)*h*4)throw std::invalid_argument("Fixture size differs");
    std::vector<uint8_t> pixels(size_t(w)*h*4);std::ifstream in(input,std::ios::binary);
    in.read(reinterpret_cast<char*>(pixels.data()),std::streamsize(pixels.size()));if(!in)throw std::runtime_error("Read failed");
    const auto start=std::chrono::steady_clock::now();
    const auto a=gpu.RunRgba(pixels,w,h),b=gpu.RunRgba(pixels,w,h);
    if(a!=b)throw std::runtime_error("GPU repeat differs");
    const double elapsed=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
    std::ofstream out(output,std::ios::binary);out.write(reinterpret_cast<const char*>(a.data()),std::streamsize(a.size()*sizeof(float)));
    if(!out)throw std::runtime_error("Write failed");
    results.push_back({{"name",name},{"size",{h,w}},{"repeat_exact",true},{"two_calls_ms",elapsed}});
  }
  nlohmann::json result={{"status","captured"},{"neural_calls",0},{"cpu_pixel_filtering",false},{"scope","Actual Mali original-Pillow resize comparison pending"},{"cases",results}};
  std::ofstream(root/"gpu-capture.json")<<result.dump(2)<<"\n";std::cout<<result.dump()<<"\n";
}
