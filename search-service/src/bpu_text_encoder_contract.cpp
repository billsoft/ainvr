#include "bpu_text_encoder.hpp"
#include "../../shared/cpp/siglip_text_contract.hpp"
#include "../../ai-service/src/platform/tensor_decode.hpp"
#include <hobot/dnn/hb_dnn.h>
#include <regex>

namespace ainvr::search {
namespace {
[[noreturn]] void Invalid() { throw std::runtime_error("search_text_model_contract_invalid"); }
void Spec(const PackageSpec& spec) {
  if (spec.id != DefaultPackageId() || spec.pruned || spec.dimensions != 1152 ||
      spec.embedding_vocab_size != ainvr::text::kSiglipEmbeddingRows ||
      spec.pad_id != ainvr::text::kSiglipPadId || spec.eos_id != ainvr::text::kSiglipEosId ||
      spec.text.program != "siglip_text" || spec.text.input.name != "input_ids" ||
      spec.text.input.dtype != "S64" || spec.text.input.shape != std::vector<int64_t>{1,int64_t(ainvr::text::kSiglipSequenceLength)} ||
      spec.text.output.name != "text_embedding" || spec.text.output.dtype != "F32" ||
      spec.text.output.shape != std::vector<int64_t>{1,1152} ||
      spec.input_spec_version.find(ainvr::text::kSiglipNormalizationSpec) == std::string::npos)
    Invalid();
}
void Tensor(const nlohmann::json& tensor, const TensorSpec& expected, int type, int64_t element_bytes,
            size_t maximum_bytes) {
  for (const auto* name : {"dtype_id", "quantization", "aligned_bytes"})
    if (!tensor.at(name).is_number_integer()) Invalid();
  for (const auto* name : {"shape", "byte_strides"}) {
    if (!tensor.at(name).is_array()) Invalid();
    for (const auto& value : tensor.at(name)) if (!value.is_number_integer()) Invalid();
  }
  const auto stride = tensor.at("byte_strides").get<std::vector<int64_t>>();
  const auto bytes = tensor.at("aligned_bytes").get<int64_t>();
  if (tensor.at("name") != expected.name || tensor.at("shape") != nlohmann::json(expected.shape) ||
      tensor.at("dtype_id") != type || tensor.at("quantization") != NONE ||
      stride.size() != 2 || stride[1] != element_bytes ||
      stride[0] < expected.shape[1] * element_bytes || bytes < stride[0] ||
      bytes <= 0 || uint64_t(bytes) > maximum_bytes)
    Invalid();
}
}  // namespace
uint64_t BpuTextReservationBytes(const VerifiedPackage& package) {
  if (!package.files_verified || package.spec != &FindPackageSpec(DefaultPackageId()) ||
      !std::regex_match(package.model_version, std::regex("search-v1-[a-f0-9]{64}")))
    throw std::runtime_error("search_text_package_unverified");
  Spec(*package.spec);
  const auto path = "hbm/" + package.spec->text.file;
  size_t matches = 0;
  for (const auto& artifact : package.artifacts) if (artifact.relative_path == path) {
    if (artifact.sha256 != kSo400mTextMeasuredSha256)
      throw std::runtime_error("search_text_resource_profile_unverified");
    ++matches;
  }
  if (matches != 1) throw std::runtime_error("search_text_resource_profile_unverified");
  return kSo400mTextReservationBytes;
}
void ValidateBpuTextDescription(const nlohmann::json& description, const PackageSpec& spec) {
  try {
    Spec(spec);
    if (description.at("model") != spec.text.program || description.at("provider") != "bpu" ||
        description.at("format") != "hbm" || !description.at("inputs").is_array() ||
        !description.at("outputs").is_array() || description.at("inputs").size() != 1 ||
        description.at("outputs").size() != 1)
      Invalid();
    Tensor(description.at("inputs").at(0), spec.text.input, HB_DNN_TENSOR_TYPE_S64, 8, 65536);
    Tensor(description.at("outputs").at(0), spec.text.output, HB_DNN_TENSOR_TYPE_F32, 4, 1024*1024);
  } catch (const nlohmann::json::exception&) { Invalid(); }
}
std::vector<float> DecodeBpuTextEmbedding(const std::vector<unsigned char>& bytes,
                                        const nlohmann::json& descriptor, const PackageSpec& spec) {
  try {
    Spec(spec);
    Tensor(descriptor, spec.text.output, HB_DNN_TENSOR_TYPE_F32, 4, 1024*1024);
    return NormalizeVector(ainvr::DecodeTensor(bytes, descriptor), spec.dimensions);
  } catch (const std::exception&) { throw std::runtime_error("search_text_output_invalid"); }
}
}  // namespace ainvr::search
