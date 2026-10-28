#include "bpu_text_encoder.hpp"
#include "../../shared/cpp/siglip_text_contract.hpp"
#include "../../ai-service/src/platform/bpu_image_input.hpp"
#include <hobot/dnn/hb_dnn.h>
#include <cmath>
#include <cstring>
#include <functional>
#include <iostream>
#include <limits>

using namespace ainvr::search;
using Json = nlohmann::json;
namespace {
int cases = 0;
void Check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void Reject(const std::function<void()>& fn) {
  try { fn(); } catch (const std::exception&) { ++cases; return; }
  throw std::runtime_error("invalid_contract_accepted");
}
Json Tensor(const char* name, int type, int64_t width, int64_t element, int64_t bytes) {
  return {{"name", name}, {"shape", {1,width}}, {"dtype_id", type}, {"quantization", NONE},
    {"aligned_bytes", bytes}, {"byte_strides", {bytes,element}}, {"quantize_axis", -1},
    {"scales", Json::array()}, {"zero_points", Json::array()}};
}
Json Description() {
  return {{"model", "siglip_text"}, {"provider", "bpu"}, {"format", "hbm"},
    {"inputs", Json::array({Tensor("input_ids", HB_DNN_TENSOR_TYPE_S64, 64, 8, 1024)})},
    {"outputs", Json::array({Tensor("text_embedding", HB_DNN_TENSOR_TYPE_F32, 1152, 4, 8192)})}};
}
}  // namespace
int main() {
  try {
    const auto& spec = FindPackageSpec(DefaultPackageId());
    auto description = Description(); ValidateBpuTextDescription(description, spec); ++cases;
    const std::vector<std::function<void(Json&)>> changes{
      [](auto& j) { j["model"] = "last_hidden_state"; },
      [](auto& j) { j["provider"] = "cpu"; },
      [](auto& j) { j["inputs"].push_back(j["inputs"][0]); },
      [](auto& j) { j["outputs"] = Json::array(); },
      [](auto& j) { j["inputs"][0]["dtype_id"] = HB_DNN_TENSOR_TYPE_S32; },
      [](auto& j) { j["inputs"][0]["shape"] = {1,77}; },
      [](auto& j) { j["inputs"][0]["name"] = "tokens"; },
      [](auto& j) { j["inputs"][0]["byte_strides"] = {511,8}; },
      [](auto& j) { j["inputs"][0]["byte_strides"] = {1024,4}; },
      [](auto& j) { j["inputs"][0]["aligned_bytes"] = 65537; },
      [](auto& j) { j["inputs"][0]["quantization"] = SCALE; },
      [](auto& j) { j["inputs"][0]["aligned_bytes"] = 1024.5; },
      [](auto& j) { j["inputs"][0]["shape"] = {1.0,64}; },
      [](auto& j) { j["outputs"][0]["shape"] = {1,768}; },
      [](auto& j) { j["outputs"][0]["dtype_id"] = HB_DNN_TENSOR_TYPE_F16; },
      [](auto& j) { j["outputs"][0]["byte_strides"] = {8192,0}; },
      [](auto& j) { j["outputs"][0]["aligned_bytes"] = 1048577; },
      [](auto& j) { j["outputs"][0]["aligned_bytes"] = -1; },
      [](auto& j) { j["outputs"][0]["name"] = "image_embedding"; },
      [](auto& j) { j["outputs"][0].erase("byte_strides"); },
    };
    for (const auto& change : changes) {
      auto invalid = description; change(invalid);
      Reject([&] { ValidateBpuTextDescription(invalid, spec); });
    }
    auto wrong = spec; wrong.pruned = true; Reject([&] { ValidateBpuTextDescription(description, wrong); });
    wrong = spec; wrong.embedding_vocab_size = 250100;
    Reject([&] { ValidateBpuTextDescription(description, wrong); });
    std::vector<int64_t> ids(64, 1); ids[0] = 249999;
    const auto packed = ainvr::PackBpuTokenIds(ids, description["inputs"][0], ainvr::text::kSiglipEmbeddingRows);
    Check(packed.size() == 1024, "aligned_pack_size");
    int64_t first = 0; std::memcpy(&first, packed.data(), sizeof(first)); Check(first == 249999, "token_corrupted");
    for (size_t i = 64*8; i < packed.size(); ++i) Check(packed[i] == 0, "padding_not_zero");
    ++cases;
    ids[0] = 250000;
    Reject([&] { ainvr::PackBpuTokenIds(ids, description["inputs"][0], ainvr::text::kSiglipEmbeddingRows); });
    std::vector<unsigned char> output(8192, 0);
    float x = 3, y = 4; std::memcpy(output.data(), &x, 4); std::memcpy(output.data()+4, &y, 4);
    const auto vector = DecodeBpuTextEmbedding(output, description["outputs"][0], spec);
    Check(vector.size() == 1152 && std::abs(vector[0]-.6f)<1e-6 && std::abs(vector[1]-.8f)<1e-6, "decode_or_normalization"); ++cases;
    Reject([&] { DecodeBpuTextEmbedding(std::vector<unsigned char>(8191), description["outputs"][0], spec); });
    Reject([&] { DecodeBpuTextEmbedding(std::vector<unsigned char>(8192), description["outputs"][0], spec); });
    x = std::numeric_limits<float>::infinity(); std::memcpy(output.data(), &x, 4);
    Reject([&] { DecodeBpuTextEmbedding(output, description["outputs"][0], spec); });
    VerifiedPackage absent; Reject([&] { BpuTextReservationBytes(absent); });
    VerifiedPackage metadata; metadata.files_verified = true; metadata.spec = &spec;
    metadata.model_version = "search-v1-" + std::string(64, 'a');
    metadata.artifacts.push_back({"hbm/" + spec.text.file, kSo400mTextMeasuredSha256, 1006129016});
    Check(BpuTextReservationBytes(metadata) == 972ULL*1024*1024, "wrong_measured_reservation"); ++cases;
    metadata.artifacts[0].sha256 = std::string(64, 'b'); Reject([&] { BpuTextReservationBytes(metadata); });
    metadata.artifacts[0].sha256 = kSo400mTextMeasuredSha256;
    metadata.artifacts.push_back(metadata.artifacts[0]); Reject([&] { BpuTextReservationBytes(metadata); });
    std::cout << Json{{"software_contract_cases", cases}, {"bpu_tasks", 0},
      {"note", "synthetic tensor layout only; no model inference"}} << '\n';
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
