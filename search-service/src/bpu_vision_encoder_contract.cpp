#include "bpu_vision_encoder.hpp"
#include "vector_index.hpp"
#include <hobot/dnn/hb_dnn.h>
#include <algorithm>
#include <cmath>
#include <regex>
namespace ainvr::search {
namespace {
[[noreturn]] void Invalid() { throw std::runtime_error("search_vision_model_contract_invalid"); }
void Spec(const PackageSpec& spec) {
  if (spec.id != "siglip2-base-full-int8" || spec.pruned || spec.family != "siglip2-base-patch16-256" ||
      spec.dimensions != 768 || spec.vision.file != "siglip2-base-patch16-256-vision-o2.hbm" ||
      spec.vision.program != "siglip2_base_vision" || spec.vision.input.name != "pixel_values" ||
      spec.vision.input.dtype != "F32" || spec.vision.input.shape != std::vector<int64_t>{1,3,256,256} ||
      spec.vision.output.name != "image_embedding" || spec.vision.output.dtype != "F32" ||
      spec.vision.output.shape != std::vector<int64_t>{1,768} ||
      spec.input_spec_version.rfind("image-area-rgb-u8-round-before-normalize-mean127.5-div127.5-squash256-l2-v1;",0) != 0)
    Invalid();
}
void Tensor(const nlohmann::json& tensor, const TensorSpec& spec, size_t maximum) {
  for (const auto* field : {"dtype_id","quantization","aligned_bytes"}) if (!tensor.at(field).is_number_integer()) Invalid();
  for (const auto* field : {"shape","byte_strides"}) {
    if (!tensor.at(field).is_array()) Invalid();
    for (const auto& value : tensor.at(field)) if (!value.is_number_integer()) Invalid();
  }
  const auto strides = tensor.at("byte_strides").get<std::vector<int64_t>>();
  const auto bytes = tensor.at("aligned_bytes").get<int64_t>();
  if (tensor.at("name") != spec.name || tensor.at("shape") != nlohmann::json(spec.shape) ||
      tensor.at("dtype_id") != HB_DNN_TENSOR_TYPE_F32 || tensor.at("quantization") != NONE ||
      strides.size() != spec.shape.size() || strides.back() != 4 || bytes <= 0 || uint64_t(bytes) > maximum) Invalid();
  uint64_t minimum = 4;
  for (size_t n = spec.shape.size(); n-- > 0;) {
    if (strides[n] < 0 || uint64_t(strides[n]) < minimum || uint64_t(strides[n]) > maximum ||
        uint64_t(spec.shape[n]) > maximum / uint64_t(strides[n])) Invalid();
    minimum = uint64_t(strides[n]) * uint64_t(spec.shape[n]);
  }
  if (uint64_t(bytes) < minimum) Invalid();
}
}  // namespace
void ValidateBpuVisionLoadOptions(const BpuVisionLoadOptions& options) {
  if (options.headroom_bytes < 64ULL*1024*1024 ||
      options.total_bytes < options.headroom_bytes || options.reservation_directory.empty() ||
      options.reservation_directory.front() != '/' || options.reservation_directory.size() > 4096 ||
      options.reservation_directory.find_first_of("\r\n\0",0,3) != std::string::npos)
    throw std::runtime_error("invalid_search_vision_resource_policy");
}
uint64_t BpuVisionReservationBytes(const VerifiedPackage& package) {
  if (!package.files_verified || !package.spec || package.spec != &FindPackageSpec("siglip2-base-full-int8") ||
      !std::regex_match(package.model_version,std::regex("search-v1-[a-f0-9]{64}")))
    throw std::runtime_error("search_vision_package_unverified");
  Spec(*package.spec);
  size_t matches = 0;
  for (const auto& artifact : package.artifacts) if (artifact.relative_path == "hbm/" + package.spec->vision.file) {
    if (artifact.sha256 != kSiglip2BaseVisionMeasuredSha256) throw std::runtime_error("search_vision_resource_profile_unverified");
    ++matches;
  }
  if (matches != 1) throw std::runtime_error("search_vision_resource_profile_unverified");
  return kSiglip2BaseVisionReservationBytes;
}
void ValidateBpuVisionDescription(const nlohmann::json& description, const PackageSpec& spec) {
  try {
    Spec(spec);
    if (description.at("model") != spec.vision.program || description.at("provider") != "bpu" ||
        description.at("format") != "hbm" || !description.at("inputs").is_array() ||
        !description.at("outputs").is_array() || description.at("inputs").size() != 1 || description.at("outputs").size() != 1) Invalid();
    Tensor(description.at("inputs").at(0),spec.vision.input,4*1024*1024);
    Tensor(description.at("outputs").at(0),spec.vision.output,1024*1024);
  } catch (const nlohmann::json::exception&) { Invalid(); }
}
ainvr::ImageTransform BpuVisionTransform(const ainvr::SnapshotPlan& plan, const PackageSpec& spec, bool bt709, bool full_range) {
  Spec(spec);
  if (plan.perspective) throw std::runtime_error("search_vision_panorama_unverified");
  if (plan.width <= 0 || plan.height <= 0 || plan.width > 16384 || plan.height > 16384 ||
      !std::all_of(plan.source_rectangle.begin(),plan.source_rectangle.end(),[](double v) { return std::isfinite(v) && std::abs(v) <= 131072; }) ||
      plan.source_rectangle[2] <= 0 || plan.source_rectangle[3] <= 0)
    throw std::runtime_error("search_vision_crop_invalid");
  auto transform = ainvr::SnapshotTransform(plan,bt709,full_range);
  transform.width = transform.height = 256; transform.letterbox = false; transform.bgr = false;
  transform.mean = transform.divisor = {127.5f,127.5f,127.5f};
  transform.interpolation = ainvr::ImageInterpolation::Area;
  // Existing ImagePreprocessor/ValidateInterpolation owns support limits.
  // Never substitute PYM bilinear or a CPU resize when this Area path rejects.
  return transform;
}
std::vector<float> NormalizeBpuVisionEmbedding(const std::vector<std::vector<float>>& outputs, const PackageSpec& spec) {
  try {
    Spec(spec); if (outputs.size() != 1) throw std::runtime_error("output_count");
    return NormalizeVector(outputs.front(),spec.dimensions);
  } catch (...) { throw std::runtime_error("search_vision_output_invalid"); }
}
}  // namespace ainvr::search
