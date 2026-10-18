// Copyright AINVR. Isolate existing GPU resizing;no model inference/production writes.
#include <GLES3/gl31.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include "platform/gles_preprocess.hpp"
int main(int argc,char**argv){
  if(argc!=2)return 2;
  const auto base=std::filesystem::path("/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1");
  const auto output=std::filesystem::absolute(argv[1]).lexically_normal();
  if(output.parent_path()!=base || std::filesystem::exists(output))throw std::runtime_error("Expected new task SSD output directory");
  std::filesystem::create_directory(output);
  constexpr int width=3840,height=2160;
  std::vector<uint8_t> rgba(size_t(width)*height*4);
  for(int y=0;y<height;++y)for(int x=0;x<width;++x){
    auto* p=rgba.data()+(size_t(y)*width+x)*4;
    p[0]=((x+y)%2)*255;p[1]=((x/3+y/2)%2)*255;p[2]=((x/7+y/11)%2)*255;p[3]=255;
  }
  ainvr::ImageTransform transform;transform.width=448;transform.height=224;transform.letterbox=false;
  transform.interpolation=ainvr::ImageInterpolation::Bicubic;
  transform.mean={127.5f,127.5f,127.5f};transform.divisor={127.5f,127.5f,127.5f};
  ainvr::GlesPreprocessor images;auto values=images.Run(rgba,width,height,transform);
  const auto* name=glGetString(GL_RENDERER);const std::string renderer=name?reinterpret_cast<const char*>(name):"";
  if(renderer.find("Mali")==std::string::npos)throw std::runtime_error("A real Mali renderer is required");
  if(values.size()!=3U*224*448)throw std::runtime_error("Wrong GPU output shape");
  std::ofstream source(output/"input.rgba",std::ios::binary);source.write(reinterpret_cast<const char*>(rgba.data()),rgba.size());source.close();
  std::ofstream result(output/"output.chw.f32",std::ios::binary);result.write(reinterpret_cast<const char*>(values.data()),values.size()*sizeof(float));result.close();
  nlohmann::json report={{"status","captured"},{"renderer",renderer},{"input_size",{height,width}},
     {"output_size",{224,448}},{"neural_calls",0},{"source","Synthetic high-frequency RGB control"},
     {"scope","Actual existing generic Mali bicubic resize;native Pillow comparison pending;not model quality"}};
  std::ofstream(output/"capture.json")<<report.dump(2)<<"\n";
  std::cout<<report.dump()<<"\n";
}
