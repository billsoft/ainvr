// Copyright AINVR. Native text-HBM execution; token/index logic only on CPU.
#include "platform/bpu.hpp"
#include "platform/tensor_decode.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <cstring>
#include <cmath>
int main(int argc,char** argv) {
  try {
    if(argc!=4)throw std::invalid_argument("Expected HBM, 77 INT32 token file and new output file");
    if(std::filesystem::exists(argv[3]))throw std::invalid_argument("Output exists");
    std::ifstream source(argv[2],std::ios::binary|std::ios::ate);
    if(!source||source.tellg()!=77*std::streamoff(sizeof(int32_t)))throw std::invalid_argument("Expected 77 INT32 tokens");
    source.seekg(0);std::vector<int32_t> tokens(77);source.read(reinterpret_cast<char*>(tokens.data()),77*sizeof(int32_t));
    if(!source)throw std::runtime_error("Token read failed");
    for(auto x:tokens)if(x<0||x>49407)throw std::invalid_argument("Token outside CLIP vocabulary");
    ainvr::BpuModel model(argv[1]);auto description=model.Describe();
    if(description.at("inputs").size()!=1)throw std::invalid_argument("Expected one token input");
    const auto& d=description.at("inputs").at(0);
    if(d.at("name")!="tokens"||d.at("shape")!=nlohmann::json::array({1,77})||
        d.at("dtype_id")!=HB_DNN_TENSOR_TYPE_S32||d.at("quantization")!=NONE||
        d.at("byte_strides").at(1)!=4||d.at("aligned_bytes").get<size_t>()<77*sizeof(int32_t))
      throw std::invalid_argument("Native token SDK contract mismatch");
    std::vector<unsigned char> packed(d.at("aligned_bytes").get<size_t>(),0);
    std::memcpy(packed.data(),tokens.data(),tokens.size()*sizeof(int32_t));
    auto result=model.Run({packed});
    if(result.size()!=1)throw std::invalid_argument("Expected one text embedding");
    auto values=ainvr::DecodeTensor(result[0],description.at("outputs").at(0));
    if(values.size()!=512)throw std::invalid_argument("Expected 512-dimensional embedding");
    for(float x:values)if(!std::isfinite(x))throw std::runtime_error("Non-finite embedding");
    std::ofstream out(argv[3],std::ios::binary);out.write(reinterpret_cast<char*>(values.data()),values.size()*sizeof(float));
    if(!out)throw std::runtime_error("Embedding write failed");
    std::cout<<nlohmann::json({{"native_text_hbm_executed",true},{"neural_backend","BPU"},
       {"input_shape",{1,77}},{"output_shape",{1,512}}}).dump()<<std::endl;return 0;
  } catch(const std::exception& e) {std::cerr<<e.what()<<std::endl;return 1;}
}
