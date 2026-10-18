// Copyright AINVR. Native string helper -> BPU text -> BPU RepRTA verification.
#include "platform/bpu_prompt_engine.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
int main(int argc,char** argv) {
  try {
    if(argc!=8)throw std::invalid_argument("Expected text HBM, RepRTA HBM, Python, helper, assets, JSON groups, new output");
    if(std::filesystem::exists(argv[7]))throw std::invalid_argument("Output already exists");
    if(std::filesystem::file_size(argv[6])>32768)throw std::invalid_argument("Request file too large");
    std::ifstream request(argv[6]);auto config=nlohmann::json::parse(request); auto groups=config.at("groups"); const auto slots=config.value("prompt_slots",8);
    if(!groups.is_array()||groups.empty()||groups.size()>16)throw std::invalid_argument("Expected 1..16 prompt groups");
    ainvr::BpuPromptEngine engine({argv[1],argv[2],argv[3],argv[4],argv[5]});
    std::vector<float> outputs;
    for(const auto& group:groups){auto values=engine.Encode(group.get<std::vector<std::string>>(),slots);outputs.insert(outputs.end(),values.begin(),values.end());}
    std::ofstream out(argv[7],std::ios::binary);out.write(reinterpret_cast<const char*>(outputs.data()),outputs.size()*sizeof(float));
    if(!out)throw std::runtime_error("Prompt output write failed");
    std::cout<<nlohmann::json({{"native_prompt_groups",groups.size()},{"neural_backend","BPU"},
       {"cpu_backend","Strings, BPE, indices and byte layout only"}}).dump()<<std::endl;return 0;
  } catch(const std::exception& e){std::cerr<<e.what()<<std::endl;return 1;}
}
