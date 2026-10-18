// Copyright AINVR. User-visible semantic outputs use the production decoder.
#include "adapters/detection_decode.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
int main(int argc,char** argv) {
  try {
    if(argc!=3 && argc!=4)throw std::invalid_argument("Expected raw output, active classes JSON and optional slots");
    const int slots=argc==4?std::stoi(argv[3]):8;
    if(slots!=8 && slots!=32)throw std::invalid_argument("Expected 8 or 32 slots");
    std::ifstream input(argv[1],std::ios::binary|std::ios::ate);
    if(!input||input.tellg()!=std::streamoff((4+slots)*8400*sizeof(float)))throw std::invalid_argument("Raw output size mismatch");
    input.seekg(0);std::vector<float> values((4+slots)*8400);input.read(reinterpret_cast<char*>(values.data()),values.size()*sizeof(float));
    std::ifstream labels(argv[2]);auto classes=nlohmann::json::parse(labels).get<std::vector<std::string>>();
    auto result=ainvr::DecodeYoloeRaw({"boxes_scores",{1,4+slots,8400},values},ai_service::pipeline::compute_scale(640,640,640,640),classes);
    auto out=nlohmann::json::array();for(const auto& item:result)out.push_back({{"class_id",item.class_id},{"class_name",item.class_name},{"confidence",item.confidence},{"bbox",item.bbox}});
    std::cout<<out.dump()<<std::endl;return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<std::endl;return 1;}
}
