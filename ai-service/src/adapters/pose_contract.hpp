// Copyright AINVR. Normalize only the explicitly supported pose17 contract.
// Pure metadata validation; never allocates an SDK model or changes the sidecar.
#pragma once
#include "config/config.hpp"
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace ai_service::adapters {
inline constexpr const char* kPoseAdapter = "yolo26_pose_bpu";
inline constexpr const char* kPoseOutputContract = "end2end_xyxy_score_class_pose17";
inline constexpr const char* kInstalledPoseOutputContract =
    "[1,300,57]: x1,y1,x2,y2,score,class then 17x(x,y,vis); coords in 640 letterbox space";

inline nlohmann::json NormalizePosePort(const nlohmann::json& ports,
    const char* name, const std::vector<int>& shape) {
  using nlohmann::json;
  if ((!ports.is_object() && !ports.is_array()) || ports.size()!=1)
    throw std::invalid_argument("Pose contract requires exactly one input/output port");
  auto port = ports.is_object() ? ports.at(name) : ports.at(0);
  if (!port.is_object() || (port.contains("name") && port.at("name")!=name))
    throw std::invalid_argument("Pose contract port name mismatch");
  if (ports.is_array() && !port.contains("name"))
    throw std::invalid_argument("Pose array port requires an explicit name");
  const auto& dimensions=port.at("shape");
  if (!dimensions.is_array() || dimensions!=json(shape))
    throw std::invalid_argument("Pose contract tensor shape mismatch");
  for (const auto& d:dimensions) if (!d.is_number_integer())
    throw std::invalid_argument("Pose tensor dimensions must be integers");
  // dtype_id 7 is F32 in the installed sidecar schema. Runtime SDK types are
  // checked separately against HB_DNN_TENSOR_TYPE_F32 after shared acquisition.
  if ((!port.contains("dtype") && !port.contains("dtype_id")) ||
      (port.contains("dtype") && port.at("dtype")!="hbDNNDataType.F32") ||
      (port.contains("dtype_id") && port.at("dtype_id")!=7) ||
      (port.contains("quantization") && port.at("quantization")!=0))
    throw std::invalid_argument("Pose tensor boundary must be unquantized F32");
  port["name"]=name;
  return port;
}

inline nlohmann::json NormalizePoseContract(const config::ModelConfig& cfg,
                                           const nlohmann::json& source) {
  using nlohmann::json;
  if (cfg.adapter!=kPoseAdapter || cfg.input_size!=std::vector<int>{640,640} ||
      (cfg.class_names && *cfg.class_names!=std::vector<std::string>{"person"}) ||
      source.at("schema_version")!=1 || source.at("target")!="rdk_s100p" ||
      source.at("task")!="pose" || source.at("class_names")!=json::array({"person"}))
    throw std::invalid_argument("Pose model task, classes or input dimensions mismatch");
  // A null adapter is NOT a blanket bypass: only this named planned adapter and
  // its complete, strict interface below may be promoted in memory.
  if (source.at("adapter").is_null()) {
    if (source.at("adapter_planned")!=kPoseAdapter)
      throw std::invalid_argument("Pose planned adapter mismatch");
  } else if (source.at("adapter")!=kPoseAdapter) {
    throw std::invalid_argument("Pose adapter mismatch");
  }
  if (source.at("input_contract")!="float_nchw_rgb" ||
      source.at("output_contract")!=kInstalledPoseOutputContract ||
      source.at("keypoints").at("count")!=17 ||
      source.at("keypoints").at("layout")!="COCO order, each (x, y, visibility score)" ||
      (source.contains("input_size") && source.at("input_size")!=json::array({640,640})))
    throw std::invalid_argument("Pose17 coordinate or output contract mismatch");
  const auto& p=source.at("preprocess");
  if (p.at("rgb_order")!=true || p.at("normalize")!="/255" ||
      p.at("letterbox")!=json({{"size",640},{"fill",114},{"center",true}}) ||
      (p.contains("mean") && p.at("mean")!=json::array({0,0,0})) ||
      (p.contains("std") && p.at("std")!=json::array({255,255,255})))
    throw std::invalid_argument("Pose requires centered RGB letterbox, fill114 and /255");
  auto normalized=source;
  normalized["inputs"]=json::array({NormalizePosePort(source.at("inputs"),"images",{1,3,640,640})});
  normalized["outputs"]=json::array({NormalizePosePort(source.at("outputs"),"output0",{1,300,57})});
  normalized["adapter"]=kPoseAdapter;
  normalized["input_size"]=json::array({640,640});
  normalized["input_contract"]="float_nchw";
  normalized["output_contract"]=kPoseOutputContract;
  normalized["preprocess"]={{"rgb_order",true},{"normalize",true},
      {"mean",{0,0,0}},{"std",{255,255,255}}};
  return normalized;
}

inline void ValidatePosePreprocess(const pipeline::PreprocessConfig& p) {
  if (!p.letterbox || !p.normalize || !p.rgb_order ||
      p.padding_color!=std::array<int,3>{114,114,114} ||
      p.mean!=std::array<double,3>{0,0,0} || p.std!=std::array<double,3>{255,255,255})
    throw std::invalid_argument("Pose channel preprocessing violates the compiled RGB /255 letterbox contract");
}
} // namespace ai_service::adapters
