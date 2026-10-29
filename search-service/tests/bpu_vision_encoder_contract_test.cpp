// Software contract tests only. Never call Load/Encode, SDK or EGL.
#include "bpu_vision_encoder.hpp"
#include <hobot/dnn/hb_dnn.h>
#include <cmath>
#include <functional>
#include <iostream>
#include <limits>
using namespace ainvr::search;
using Json = nlohmann::json;
size_t checks = 0;
void Check(bool ok, const char* message) { ++checks; if (!ok) throw std::runtime_error(message); }
void Reject(const std::function<void()>& fn) { bool bad = false; try { fn(); } catch (...) { bad = true; } Check(bad,"invalid contract accepted"); }
Json Description() {
  return {{"model","siglip2_base_vision"},{"provider","bpu"},{"format","hbm"},
    {"inputs",Json::array({{{"name","pixel_values"},{"shape",{1,3,256,256}},{"dtype_id",HB_DNN_TENSOR_TYPE_F32},
      {"byte_strides",{786432,262144,1024,4}},{"aligned_bytes",786432},{"quantization",NONE}}})},
    {"outputs",Json::array({{{"name","image_embedding"},{"shape",{1,768}},{"dtype_id",HB_DNN_TENSOR_TYPE_F32},
      {"byte_strides",{3072,4}},{"aligned_bytes",3072},{"quantization",NONE}}})}};
}
int main() {
  try {
    const auto& spec = FindPackageSpec("siglip2-base-full-int8");
    ValidateBpuVisionDescription(Description(),spec); ++checks;
    for (const auto* field : {"model","provider","format"}) { auto bad = Description(); bad[field] = "wrong";
      Reject([&] { ValidateBpuVisionDescription(bad,spec); }); }
    for (const auto* group : {"inputs","outputs"}) {
      for (const auto* field : {"name","shape","dtype_id","quantization","byte_strides","aligned_bytes"}) {
        auto bad = Description(); auto& tensor = bad[group][0];
        if (std::string(field) == "name") tensor[field] = "last_hidden_state";
        else if (std::string(field) == "shape") tensor[field] = {1,1152};
        else if (std::string(field) == "dtype_id") tensor[field] = HB_DNN_TENSOR_TYPE_S16;
        else if (std::string(field) == "quantization") tensor[field] = SCALE;
        else if (std::string(field) == "byte_strides") tensor[field] = {1,1};
        else tensor[field] = 1;
        Reject([&] { ValidateBpuVisionDescription(bad,spec); });
      }
      auto bad = Description(); bad[group].push_back(bad[group][0]); Reject([&] { ValidateBpuVisionDescription(bad,spec); });
      bad = Description(); bad[group][0]["aligned_bytes"] = 18446744073709551615ULL;
      Reject([&] { ValidateBpuVisionDescription(bad,spec); });
    }
    auto padded = Description(); padded["outputs"][0]["byte_strides"] = {4096,4}; padded["outputs"][0]["aligned_bytes"] = 4096;
    ValidateBpuVisionDescription(padded,spec); ++checks;
    for (const auto* package : {"siglip-so400m-i18n-full-int8","siglip2-base-pruned-int8"})
      Reject([&] { ValidateBpuVisionDescription(Description(),FindPackageSpec(package)); });
    auto altered = spec; altered.input_spec_version = "image-bilinear";
    Reject([&] { ValidateBpuVisionDescription(Description(),altered); });
    VerifiedPackage package; package.files_verified = true; package.spec = &spec;
    package.model_version = "search-v1-" + std::string(64,'a');
    package.artifacts.push_back({"hbm/" + spec.vision.file,kSiglip2BaseVisionMeasuredSha256,102985880});
    Check(BpuVisionReservationBytes(package) == 103ULL*1024*1024,"reservation used file bytes instead of measured ION");
    package.artifacts[0].sha256[0] = '0'; Reject([&] { BpuVisionReservationBytes(package); });
    package.artifacts[0].sha256 = kSiglip2BaseVisionMeasuredSha256; package.artifacts.push_back(package.artifacts[0]);
    Reject([&] { BpuVisionReservationBytes(package); }); package.artifacts.pop_back();
    package.files_verified = false; Reject([&] { BpuVisionReservationBytes(package); }); package.files_verified = true;
    package.spec = &altered; Reject([&] { BpuVisionReservationBytes(package); }); package.spec = &spec;
    package.model_version = "unverified"; Reject([&] { BpuVisionReservationBytes(package); });
    ValidateBpuVisionLoadOptions({}); ++checks;
    BpuVisionLoadOptions options; options.headroom_bytes = 63ULL<<20; Reject([&] { ValidateBpuVisionLoadOptions(options); });
    options = {}; options.total_bytes = 7681ULL<<20; Reject([&] { ValidateBpuVisionLoadOptions(options); });
    options = {}; options.total_bytes = 0; Reject([&] { ValidateBpuVisionLoadOptions(options); });
    for (const auto& directory : {std::string("relative"),std::string("/run/\nsecret"),std::string("/run/\0secret",12)}) {
      options = {}; options.reservation_directory = directory; Reject([&] { ValidateBpuVisionLoadOptions(options); });
    }
    ainvr::SnapshotPlan plan; plan.width = 1200; plan.height = 700; plan.source_rectangle = {32.5,24.5,1200,700};
    for (bool bt709 : {false,true}) for (bool range : {false,true}) {
      const auto transform = BpuVisionTransform(plan,spec,bt709,range);
      Check(transform.width == 256 && transform.height == 256 && !transform.letterbox && !transform.bgr && !transform.nearest,
        "vision is not RGB squash256");
      Check(transform.interpolation == ainvr::ImageInterpolation::Area && transform.mean == std::array<float,3>{127.5,127.5,127.5} &&
        transform.divisor == transform.mean,"bench preprocessing changed");
      Check(transform.yuv_bt709 == bt709 && transform.yuv_full_range == range && transform.source_region &&
        *transform.source_region == std::array<float,4>{32.5,24.5,1200,700},"source plan or YUV metadata changed");
    }
    auto invalid = plan; invalid.perspective = true; Reject([&] { BpuVisionTransform(invalid,spec,true,false); });
    for (double bad : {0.,-1.,std::numeric_limits<double>::infinity(),std::numeric_limits<double>::quiet_NaN()}) {
      invalid = plan; invalid.source_rectangle[2] = bad; Reject([&] { BpuVisionTransform(invalid,spec,true,false); });
    }
    std::vector<std::vector<float>> outputs(1,std::vector<float>(768)); outputs[0][0] = 3; outputs[0][1] = -4;
    const auto vector = NormalizeBpuVisionEmbedding(outputs,spec);
    Check(vector.size() == 768 && std::abs(vector[0]-.6f) < 1e-6 && std::abs(vector[1]+.8f) < 1e-6,"pooled vector not L2 normalized");
    double norm = 0; for (float value : vector) norm += value*value; Check(std::abs(norm-1)<1e-6,"embedding not unit norm");
    outputs[0].resize(767); Reject([&] { NormalizeBpuVisionEmbedding(outputs,spec); }); outputs[0].resize(768);
    outputs.push_back(outputs[0]); Reject([&] { NormalizeBpuVisionEmbedding(outputs,spec); }); outputs.pop_back();
    for (float bad : {std::numeric_limits<float>::infinity(),std::numeric_limits<float>::quiet_NaN()}) {
      outputs[0][0] = bad; Reject([&] { NormalizeBpuVisionEmbedding(outputs,spec); }); }
    outputs[0].assign(768,0); Reject([&] { NormalizeBpuVisionEmbedding(outputs,spec); });
    std::cout << "BPU vision software contract: " << checks << " checks passed; no SDK/EGL/model loading executed\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
