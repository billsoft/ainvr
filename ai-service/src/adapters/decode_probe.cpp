// Copyright AINVR. Offline native output decoder for ONNX/HBM parity tests.
#include "detection_decode.hpp"
#include <fstream>
#include <iostream>
int main(int argc,char** argv){
  if(argc!=2)return 2;
  try{
    std::ifstream file(argv[1]);if(!file)throw std::runtime_error("Cannot open tensor fixture");
    nlohmann::json data;file>>data;std::vector<ainvr::DenseTensor> outputs;
    for(const auto& t:data.at("outputs"))outputs.push_back({t.at("name"),t.at("shape").get<std::vector<int64_t>>(),t.at("values").get<std::vector<float>>()});
    auto scale=ai_service::pipeline::compute_scale(data.at("source_width"),data.at("source_height"),data.at("input_width"),data.at("input_height"));
    ainvr::DetectionOptions options{data.value("confidence",.25),data.value("iou",.45),data.value("maximum",300)};
    std::vector<ai_service::Detection> result;
    if(data.at("decoder")=="scrfd")result=ainvr::DecodeScrfd(outputs,scale,options);
    else if(data.at("decoder")=="end2end"&&outputs.size()==1)result=ainvr::DecodeEndToEnd(outputs[0],scale,data.at("classes").get<std::vector<std::string>>(),options);
    else throw std::runtime_error("Unknown decoder contract");
    nlohmann::json rows=nlohmann::json::array();
    for(const auto& d:result){nlohmann::json row={{"class_id",d.class_id},{"class_name",d.class_name},{"confidence",d.confidence},{"bbox",d.bbox}};row["landmarks"]=d.landmarks?nlohmann::json(*d.landmarks):nlohmann::json(nullptr);rows.push_back(row);}
    std::cout<<rows.dump(2)<<"\n";return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}
}
