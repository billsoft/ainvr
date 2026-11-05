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
Json Description(const char* program, int64_t dimensions) {
  return {{"model", program}, {"provider", "bpu"}, {"format", "hbm"},
    {"inputs", Json::array({Tensor("input_ids", HB_DNN_TENSOR_TYPE_S64, 64, 8, 1024)})},
    {"outputs", Json::array({Tensor("text_embedding", HB_DNN_TENSOR_TYPE_F32, dimensions, 4, 8192)})}};
}
// One supported complete-vocabulary package: the same software contract must hold for each measured profile.
struct Profile { const char* id; const char* program; int64_t dimensions, rows; const char* sha256; uint64_t reservation, file_bytes; };
void RunProfile(const Profile& profile) {
  const auto& spec = FindPackageSpec(profile.id);
  auto description = Description(profile.program, profile.dimensions); ValidateBpuTextDescription(description, spec); ++cases;
  const int64_t other_dimensions = profile.dimensions == 768 ? 1152 : 768;
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
    [other_dimensions](auto& j) { j["outputs"][0]["shape"] = {1,other_dimensions}; },
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
  wrong = spec; wrong.embedding_vocab_size = profile.rows + 100;
  Reject([&] { ValidateBpuTextDescription(description, wrong); });
  wrong = spec; wrong.dimensions = other_dimensions;
  Reject([&] { ValidateBpuTextDescription(description, wrong); });
  wrong = spec; wrong.text.program = profile.dimensions == 768 ? "siglip_text" : "siglip2_base_text";
  Reject([&] { ValidateBpuTextDescription(description, wrong); });
  std::vector<int64_t> ids(64, 1); ids[0] = profile.rows - 1;
  const auto packed = ainvr::PackBpuTokenIds(ids, description["inputs"][0], profile.rows);
  Check(packed.size() == 1024, "aligned_pack_size");
  int64_t first = 0; std::memcpy(&first, packed.data(), sizeof(first)); Check(first == profile.rows - 1, "token_corrupted");
  for (size_t i = 64*8; i < packed.size(); ++i) Check(packed[i] == 0, "padding_not_zero");
  ++cases;
  ids[0] = profile.rows;
  Reject([&] { ainvr::PackBpuTokenIds(ids, description["inputs"][0], profile.rows); });
  std::vector<unsigned char> output(8192, 0);
  float x = 3, y = 4; std::memcpy(output.data(), &x, 4); std::memcpy(output.data()+4, &y, 4);
  const auto vector = DecodeBpuTextEmbedding(output, description["outputs"][0], spec);
  Check(int64_t(vector.size()) == profile.dimensions && std::abs(vector[0]-.6f)<1e-6 && std::abs(vector[1]-.8f)<1e-6, "decode_or_normalization"); ++cases;
  Reject([&] { DecodeBpuTextEmbedding(std::vector<unsigned char>(8191), description["outputs"][0], spec); });
  Reject([&] { DecodeBpuTextEmbedding(std::vector<unsigned char>(8192), description["outputs"][0], spec); });
  x = std::numeric_limits<float>::infinity(); std::memcpy(output.data(), &x, 4);
  Reject([&] { DecodeBpuTextEmbedding(output, description["outputs"][0], spec); });
  VerifiedPackage absent; Reject([&] { BpuTextReservationBytes(absent); });
  VerifiedPackage metadata; metadata.files_verified = true; metadata.spec = &spec;
  metadata.model_version = "search-v1-" + std::string(64, 'a');
  metadata.artifacts.push_back({"hbm/" + spec.text.file, profile.sha256, profile.file_bytes});
  Check(BpuTextReservationBytes(metadata) == profile.reservation, "wrong_measured_reservation"); ++cases;
  metadata.artifacts[0].sha256 = std::string(64, 'b'); Reject([&] { BpuTextReservationBytes(metadata); });
  // The other package's measured hash must not satisfy this package's profile.
  metadata.artifacts[0].sha256 = profile.dimensions == 768 ? kSo400mTextMeasuredSha256 : kSiglip2BaseTextMeasuredSha256;
  Reject([&] { BpuTextReservationBytes(metadata); });
  metadata.artifacts[0].sha256 = profile.sha256;
  metadata.artifacts.push_back(metadata.artifacts[0]); Reject([&] { BpuTextReservationBytes(metadata); });
}
}  // namespace
int main() {
  try {
    Check(std::string(DefaultPackageId()) == "siglip2-base-full-int8", "default_is_siglip2");
    RunProfile({"siglip2-base-full-int8", "siglip2_base_text", 768, ainvr::text::kSiglip2EmbeddingRows,
                kSiglip2BaseTextMeasuredSha256, kSiglip2BaseTextReservationBytes, 485359400});
    RunProfile({"siglip-so400m-i18n-full-int8", "siglip_text", 1152, ainvr::text::kSiglipEmbeddingRows,
                kSo400mTextMeasuredSha256, kSo400mTextReservationBytes, 1006129016});
    for (const char* pruned : {"siglip2-base-pruned-int8", "siglip-so400m-i18n-pruned-int8"}) {
      const auto& spec = FindPackageSpec(pruned);
      Reject([&] { ValidateBpuTextDescription(Description(spec.text.program.c_str(), int64_t(spec.dimensions)), spec); });
    }
    std::cout << Json{{"software_contract_cases", cases}, {"bpu_tasks", 0},
      {"note", "synthetic tensor layout only; no model inference"}} << '\n';
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
