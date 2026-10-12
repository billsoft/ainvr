// Copyright AINVR. Native runner for real SDK-aligned tensor files.
#include "bpu.hpp"
#include "tensor_decode.hpp"
#include <fstream>
#include <iostream>
#include <iterator>
#include <filesystem>
int main(int argc,char** argv){
  try{
    if(argc<4)throw std::invalid_argument("Usage: ainvr_infer model.hbm output.json input0.bin [input1.bin ...]; input order/storage from ainvr_bpu_probe");
    if(std::filesystem::exists(argv[2]))throw std::runtime_error("Output already exists");
    ainvr::BpuModel model(argv[1]);auto description=model.Describe();
    if(size_t(argc-3)!=description["inputs"].size())throw std::invalid_argument("Wrong number of tensor files");
    std::vector<std::vector<unsigned char>> inputs;
    for(int k=3;k<argc;++k){
      auto required=description["inputs"][k-3]["aligned_bytes"].get<uintmax_t>();
      if(std::filesystem::file_size(argv[k])!=required)throw std::runtime_error("Input file size does not match SDK aligned bytes");
      std::ifstream file(argv[k],std::ios::binary);if(!file)throw std::runtime_error("Cannot read input file");
      inputs.emplace_back(std::istreambuf_iterator<char>(file),std::istreambuf_iterator<char>());
    }
    auto outputs=model.Run(inputs);nlohmann::json result={{"model",description["model"]},{"provider","bpu"},{"outputs",nlohmann::json::array()}};
    for(size_t i=0;i<outputs.size();++i){auto metadata=description["outputs"][i];metadata["values"]=ainvr::DecodeTensor(outputs[i],metadata);result["outputs"].push_back(std::move(metadata));}
    std::ofstream file(argv[2]);if(!file)throw std::runtime_error("Cannot create output file");
    file<<result.dump();file.close();if(!file)throw std::runtime_error("Write output failed");
    std::cout<<"HBM inference completed; output contains dense dequantized tensors, not model-specific detections\n";return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
