// Copyright AINVR. Normalize the installed named-map detector contract in memory.
#pragma once
#include "config/config.hpp"
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace ai_service::adapters {
inline nlohmann::json NormalizeFloatContractPort(const nlohmann::json& ports,
    const char* name,const std::vector<int>& shape) {
  using nlohmann::json;
  if((!ports.is_object()&&!ports.is_array())||ports.size()!=1)
    throw std::invalid_argument("Contract requires exactly one named input/output port");
  auto port=ports.is_object()?ports.at(name):ports.at(0);
  if(!port.is_object()||(port.contains("name")&&port.at("name")!=name)||
      (ports.is_array()&&!port.contains("name")))
    throw std::invalid_argument("Contract port name mismatch");
  const auto& dimensions=port.at("shape");
  if(!dimensions.is_array()||dimensions!=json(shape))
    throw std::invalid_argument("Contract tensor shape mismatch");
  for(const auto& d:dimensions)if(!d.is_number_integer())
    throw std::invalid_argument("Contract tensor dimensions must be integers");
  if((!port.contains("dtype")&&!port.contains("dtype_id"))||
      (port.contains("dtype")&&port.at("dtype")!="hbDNNDataType.F32")||
      (port.contains("dtype_id")&&(!port.at("dtype_id").is_number_integer()||port.at("dtype_id")!=7))||
      (port.contains("quantization")&&(!port.at("quantization").is_number_integer()||port.at("quantization")!=0)))
    throw std::invalid_argument("Contract boundary must be unquantized F32");
  port["name"]=name;port["dtype_id"]=7;port["quantization"]=0;return port;
}

inline nlohmann::json NormalizeDetectorPortMaps(const config::ModelConfig& cfg,
                                               const nlohmann::json& source) {
  // Legacy array manifests retain their representation and task-specific validation.
  if(!source.at("outputs").is_object()&&
      (!source.contains("inputs")||!source.at("inputs").is_object()))return source;
  if(cfg.adapter!="yolo26_bpu"||cfg.input_size!=std::vector<int>{640,640}||
      source.at("input_contract")!="float_nchw"||
      source.at("output_contract")!="end2end_xyxy_score_class"||
      !source.at("inputs").is_object()||!source.at("outputs").is_object())
    throw std::invalid_argument("Unsupported named-map BPU detector contract");
  auto result=source;
  result["inputs"]=nlohmann::json::array({NormalizeFloatContractPort(source.at("inputs"),"images",{1,3,640,640})});
  result["outputs"]=nlohmann::json::array({NormalizeFloatContractPort(source.at("outputs"),"output0",{1,300,6})});
  return result;
}

inline void ValidateDeclaredSdkPort(const nlohmann::json& expected,const nlohmann::json& actual) {
  if(expected.at("name")!=actual.at("name")||expected.at("shape")!=actual.at("shape")||
      (expected.contains("dtype_id")&&expected.at("dtype_id")!=actual.at("dtype_id"))||
      (expected.contains("quantization")&&expected.at("quantization")!=actual.at("quantization")))
    throw std::runtime_error("HBM port name/shape/type/quantization differs from compilation contract");
}
}
