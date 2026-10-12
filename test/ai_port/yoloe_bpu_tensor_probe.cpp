// Copyright AINVR. Bounded native dual-input HBM tensor test, no CPU NN.
#include "platform/bpu.hpp"
#include "platform/bpu_image_input.hpp"
#include "platform/tensor_decode.hpp"
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>

std::vector<float> Read(const std::string& path,size_t count) {
  std::ifstream file(path,std::ios::binary|std::ios::ate);
  if(!file || file.tellg()!=std::streamoff(count*sizeof(float)))
    throw std::invalid_argument("Input file size differs from the fixed tensor contract");
  file.seekg(0);std::vector<float> values(count);
  file.read(reinterpret_cast<char*>(values.data()),count*sizeof(float));
  if(!file)throw std::runtime_error("Input read failed");
  for(float x:values)if(!std::isfinite(x))throw std::invalid_argument("Non-finite input");
  return values;
}
int main(int argc,char** argv) {
  try {
    if(argc!=5)throw std::invalid_argument("Expected HBM, image tensor, prompt tensor, new output file");
    if(std::filesystem::exists(argv[4]))throw std::invalid_argument("Output file already exists");
    ainvr::BpuModel model(argv[1]);auto description=model.Describe();
    auto images=Read(argv[2],3*640*640),prompts=Read(argv[3],8*512);
    auto inputs=ainvr::PackBpuFloatInputs(images,description.at("inputs"),"images",{{"prompt_embeddings",prompts}});
    auto start=std::chrono::steady_clock::now();auto raw=model.Run(inputs);
    auto ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
    if(raw.size()!=1)throw std::invalid_argument("Expected one raw detection tensor");
    auto output=ainvr::DecodeTensor(raw[0],description.at("outputs").at(0));
    if(output.size()!=12*8400)throw std::invalid_argument("Expected 1x12x8400 raw boxes/scores");
    float score=0;for(size_t i=0;i<output.size();++i) {
      if(!std::isfinite(output[i]))throw std::runtime_error("Non-finite BPU output");
      if(i>=4*8400)score=std::max(score,output[i]);
    }
    std::ofstream file(argv[4],std::ios::binary);
    file.write(reinterpret_cast<const char*>(output.data()),output.size()*sizeof(float));
    if(!file)throw std::runtime_error("Output write failed");
    std::cout<<nlohmann::json({{"scope","Native named-input packing and SDK inference only"},
       {"latency_ms",ms},{"max_score",score},{"output_shape",{1,12,8400}},
       {"neural_backend","BPU"},{"accuracy_verified",false},
       {"full_dynamic_text_pipeline_verified",false}}).dump()<<std::endl;
    return 0;
  } catch(const std::exception& e) {std::cerr<<e.what()<<std::endl;return 1;}
}
