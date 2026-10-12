#include "user_facing_error.hpp"

#include <array>
#include <string_view>

namespace ai_service::utils {

std::string UserFacingError(const std::string& raw) {
  if (raw.find("模型文件不存在") != std::string::npos ||
      (raw.find("engine 不存在") != std::string::npos)) {
    return "模型文件缺失,请重新安装模型包";
  }
  static constexpr std::array<std::string_view, 16> kInternals = {
      "TensorRT", "engine",       "ONNX",     "onnx",     "createInfer", "createExecutionContext",
      "enqueue",  "setTensor",    "setInputShape", "cuda", "CUDA",       "YOLO",
      "NVMM",     "NvBuf",        "output_shape_", "PostprocessMulti"};
  for (auto k : kInternals) {
    if (raw.find(k) != std::string::npos) return "模型加载或推理失败(详细原因已记录在服务日志)";
  }
  return raw;
}

}  // namespace ai_service::utils
