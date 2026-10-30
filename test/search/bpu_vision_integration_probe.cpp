// Explicitly invoked, bounded hardware interface probe. Never a service or CPU fallback.
#include "bpu_vision_encoder.hpp"
#include "platform/vpu_decoder.hpp"
#include "platform/bpu.hpp"
#include "platform/bpu_image_input.hpp"
#include "platform/tensor_decode.hpp"
#include "../../shared/cpp/bpu_coexist_reservation.hpp"
#include "../../shared/cpp/bpu_dma_buffer.hpp"
#include "../../shared/cpp/bpu_reserved_pool.hpp"
#include "vector_index.hpp"
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <fcntl.h>
#include <unistd.h>
using Json = nlohmann::json;
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
namespace {
const char* Usage() {
  return "Manual only: --run-hardware --input-nv12 FILE --width W --height H --matrix bt601|bt709 "
    "--range limited|full --frames 1..32 --report test/results/NEW.json [--reference-f32 FILE | --reference-input-f32 FILE] "
    "[--roi x,y,width,height] [--min-cosine 0.99]\n"
    "Software only: --help | --software-self-test\n"
    "Input is exactly ONE packed NV12 frame; the SAME frame is repeated for bounded reuse testing. "
    "Output reference is exactly 768 little-endian f32 values. Input reference is a TEST-ONLY CPU image oracle: "
    "3x256x256 little-endian RGB CHW f32, passed through the SAME HBM on BPU, not a floating-network reference.\n";
}
int Number(const std::string& value, int low, int high) {
  size_t end = 0; const auto n = std::stoll(value,&end);
  if (end != value.size() || n < low || n > high) throw std::runtime_error("invalid_probe_integer");
  return int(n);
}
std::vector<uint8_t> ReadExact(const std::string& path, size_t size) {
  std::ifstream file(path,std::ios::binary | std::ios::ate);
  if (!file || file.tellg() != std::streamoff(size)) throw std::runtime_error("probe_input_size_mismatch");
  file.seekg(0); std::vector<uint8_t> bytes(size);
  if (!file.read(reinterpret_cast<char*>(bytes.data()),size)) throw std::runtime_error("probe_input_read_failed");
  return bytes;
}
std::vector<float> ReadFloat(const std::string& path, size_t elements) {
  const auto bytes = ReadExact(path,elements*4); std::vector<float> out(elements);
  for (size_t n = 0; n < out.size(); ++n) {
    uint32_t bits = 0; for (size_t k = 0; k < 4; ++k) bits |= uint32_t(bytes[n*4+k]) << (8*k);
    std::memcpy(&out[n],&bits,4);
    if (!std::isfinite(out[n])) throw std::runtime_error("invalid_probe_reference");
  }
  return out;
}
std::vector<float> EncodeReferenceInput(const std::vector<float>& input, const std::string& expected_model) {
  // Manual test branch only. It reuses the existing BPU pack/run/decode stack;
  // production still uses BpuVisionEncoder and hardware image preprocessing.
  struct Custody {
    std::unique_ptr<ainvr::BpuCoexistReservation> reservation;
    ainvr::search::VerifiedPackage package;
    std::unique_ptr<ainvr::BpuModel> model;
  };
  auto held = std::make_unique<Custody>();
  try {
    held->package = ainvr::search::VerifyPackage("siglip2-base-full-int8");
    if (held->package.model_version != expected_model || !ainvr::BpuRuntimeHealthy())
      throw std::runtime_error("probe_reference_model_changed");
    ainvr::IonPolicy policy; policy.pool_bytes = ainvr::ReadBpuIonBudgetBytes();
    held->reservation = std::make_unique<ainvr::BpuCoexistReservation>("/run/ainvr","search-service",
      ainvr::search::BpuVisionReservationBytes(held->package),policy);
    if (!ainvr::search::VerifyStillCurrent(held->package)) throw std::runtime_error("probe_reference_model_changed");
    const auto& spec = *held->package.spec;
    held->model = std::make_unique<ainvr::BpuModel>("/proc/self/fd/" + std::to_string(
      held->package.BorrowedFileDescriptor("hbm/" + spec.vision.file)),spec.vision.program);
    const auto description = held->model->Describe();
    ainvr::search::ValidateBpuVisionDescription(description,spec);
    { ainvr::BpuDmaBuffer headroom(policy.min_free); }
    held->reservation->Loaded();
    const auto outputs = held->model->Run(ainvr::PackBpuFloatInputs(input,description.at("inputs"),spec.vision.input.name,{}));
    std::vector<std::vector<float>> decoded;
    for (size_t n = 0; n < outputs.size(); ++n) decoded.push_back(ainvr::DecodeTensor(outputs[n],description.at("outputs").at(n)));
    if (!ainvr::search::VerifyStillCurrent(held->package)) throw std::runtime_error("probe_reference_model_changed");
    return ainvr::search::NormalizeBpuVisionEmbedding(decoded,spec);
  } catch (...) {
    if (held->model && !ainvr::BpuRuntimeHealthy()) {
      held->model.reset(); // Unknown task/DMA remain quarantined by BpuModel.
      (void)held.release(); // Preserve real FD and reservation custody until process exit.
    }
    throw;
  }
}
void ReportPath(const std::string& path) {
  const auto parent = fs::canonical(fs::path(path).parent_path());
  const auto allowed = fs::canonical(AINVR_SEARCH_PROBE_RESULTS_ROOT);
  const auto relative = parent.lexically_relative(allowed);
  if (relative.empty() || relative.is_absolute() || (!relative.empty() && *relative.begin() == "..") ||
      fs::exists(path) || fs::path(path).filename().empty()) throw std::runtime_error("probe_report_must_be_new_under_test_results");
}
void WriteNew(const std::string& path, const Json& report) {
  const int fd = open(path.c_str(),O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,0600);
  if (fd < 0) throw std::runtime_error("probe_report_create_failed");
  const auto text = report.dump(2) + "\n"; size_t done = 0;
  while (done < text.size()) {
    const auto n = write(fd,text.data()+done,text.size()-done);
    if (n <= 0) { close(fd); throw std::runtime_error("probe_report_write_failed"); } done += size_t(n);
  }
  const bool ok = fsync(fd) == 0; close(fd); if (!ok) throw std::runtime_error("probe_report_sync_failed");
}
}  // namespace
int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--help") { std::cout << Usage(); return 0; }
    if (argc == 2 && std::string(argv[1]) == "--software-self-test") {
      const auto& spec = ainvr::search::FindPackageSpec("siglip2-base-full-int8");
      ai_service::config::SnapshotConfig config; config.enabled = true; config.padding_ratio = 0; config.max_crop_dimension = 1920;
      auto plan = ainvr::PlanSnapshot({0,0,1920,1080},1920,1080,config,false);
      if (!plan || plan->source_rectangle != std::array<double,4>{0,0,1920,1080}) throw std::runtime_error("probe_snapshot_plan_changed");
      const auto transform = ainvr::search::BpuVisionTransform(*plan,spec,false,false);
      if (transform.width != 256 || transform.height != 256 || transform.interpolation != ainvr::ImageInterpolation::Area ||
          transform.letterbox || transform.bgr || transform.divisor[0] != 127.5f) throw std::runtime_error("probe_transform_changed");
      std::cout << "software-only probe checks passed; no file, SDK, EGL or HBM access\n"; return 0;
    }
    if (argc < 2 || std::string(argv[1]) != "--run-hardware") { std::cerr << Usage(); return 64; }
    std::map<std::string,std::string> args;
    for (int n = 2; n < argc; n += 2) {
      if (n+1 >= argc || !args.emplace(argv[n],argv[n+1]).second) throw std::runtime_error("invalid_probe_arguments");
    }
    for (const auto& [key,value] : args) {
      (void)value;
      if (key != "--input-nv12" && key != "--width" && key != "--height" && key != "--matrix" && key != "--range" &&
          key != "--frames" && key != "--report" && key != "--reference-f32" && key != "--reference-input-f32" &&
          key != "--roi" && key != "--min-cosine")
        throw std::runtime_error("unknown_probe_argument");
    }
    for (const auto* key : {"--input-nv12","--width","--height","--matrix","--range","--frames","--report"})
      if (!args.count(key)) throw std::runtime_error("missing_probe_argument");
    const int width = Number(args.at("--width"),2,8192), height = Number(args.at("--height"),2,8192);
    const int count = Number(args.at("--frames"),1,32);
    if (width%2 || height%2 || (args.at("--matrix") != "bt601" && args.at("--matrix") != "bt709") ||
        (args.at("--range") != "limited" && args.at("--range") != "full")) throw std::runtime_error("invalid_probe_image_contract");
    ReportPath(args.at("--report"));
    double threshold = .99;
    if (args.count("--min-cosine")) { size_t end = 0; threshold = std::stod(args.at("--min-cosine"),&end);
      if (end != args.at("--min-cosine").size() || !std::isfinite(threshold) || threshold < 0 || threshold > 1)
        throw std::runtime_error("invalid_probe_threshold"); }
    std::optional<std::vector<float>> reference;
    if (args.count("--reference-f32") && args.count("--reference-input-f32")) throw std::runtime_error("ambiguous_probe_reference");
    if (args.count("--reference-f32")) reference = ainvr::search::NormalizeVector(ReadFloat(args.at("--reference-f32"),768),768);
    std::optional<std::vector<float>> reference_input;
    if (args.count("--reference-input-f32")) {
      if (args.at("--matrix") != "bt601" || args.at("--range") != "limited")
        throw std::runtime_error("probe_cpu_oracle_only_bt601_limited");
      reference_input = ReadFloat(args.at("--reference-input-f32"),3*256*256);
      for (float value : *reference_input) if (value < -1 || value > 1) throw std::runtime_error("invalid_probe_reference_input");
    }
    ainvr::Nv12Frame frame; frame.width = width; frame.height = height;
    frame.pixels = ReadExact(args.at("--input-nv12"),size_t(width)*height*3/2);
    ai_service::config::SnapshotConfig config; config.enabled = true; config.padding_ratio = 0; config.max_crop_dimension = 8192;
    std::array<double,4> roi{0,0,double(width),double(height)};
    if (args.count("--roi")) {
      if (args.at("--roi").empty() || args.at("--roi").back() == ',') throw std::runtime_error("invalid_probe_roi");
      std::stringstream stream(args.at("--roi")); std::string part;
      for (size_t n = 0; n < 4; ++n) { if (!std::getline(stream,part,',')) throw std::runtime_error("invalid_probe_roi");
        roi[n] = Number(part,n < 2 ? 0 : 1,n%2 == 0 ? width : height); }
      if (std::getline(stream,part,',') || roi[0]+roi[2] > width || roi[1]+roi[3] > height)
        throw std::runtime_error("invalid_probe_roi");
    }
    const auto plan = ainvr::PlanSnapshot(roi,width,height,config,false);
    if (!plan) throw std::runtime_error("probe_plan_unavailable");
    const auto start = Clock::now(), deadline = start + std::chrono::seconds(90);
    auto encoder = ainvr::search::BpuVisionEncoder::Load(ainvr::search::VerifyPackage("siglip2-base-full-int8"));
    const std::string model_version = encoder->ModelVersion(), input_spec_version = encoder->InputSpecVersion();
    Json frames = Json::array(); std::vector<std::vector<float>> embeddings; bool numeric = true;
    for (int n = 0; n < count; ++n) {
      if (Clock::now() > deadline) throw std::runtime_error("probe_deadline_exceeded");
      frame.pts = uint64_t(n); const auto began = Clock::now();
      const auto result = encoder->Encode(frame,*plan,args.at("--matrix") == "bt709",args.at("--range") == "full");
      if (reference_input) embeddings.push_back(result.embedding);
      Json cosine = nullptr; double norm = 0; for (float v : result.embedding) norm += v*v;
      if (reference) { double dot = 0; for (size_t k = 0; k < result.embedding.size(); ++k) dot += result.embedding[k]*(*reference)[k];
        cosine = dot; numeric = numeric && dot >= threshold; }
      frames.push_back({{"index",n},{"elements",result.embedding.size()},{"l2_squared",norm},{"image_backend",result.image_backend},
        {"preprocess_ms",result.preprocess_ms},{"inference_ms",result.inference_ms},{"output_decode_ms",result.output_decode_ms},
        {"total_ms",std::chrono::duration<double,std::milli>(Clock::now()-began).count()},{"reference_cosine",cosine}});
    }
    encoder.reset(); // Release production GPU/model before loading the test reference HBM.
    if (reference_input) {
      if (Clock::now() > deadline) throw std::runtime_error("probe_deadline_exceeded");
      reference = EncodeReferenceInput(*reference_input,model_version);
      for (size_t n = 0; n < embeddings.size(); ++n) {
        double dot = 0; for (size_t k = 0; k < embeddings[n].size(); ++k) dot += embeddings[n][k]*(*reference)[k];
        frames[n]["reference_cosine"] = dot; numeric = numeric && dot >= threshold;
      }
    }
    Json report = {{"interface_passed",true},{"numeric_reference_passed",reference ? Json(numeric) : Json(nullptr)},
      {"production_accuracy_verified",false},{"model_version",model_version},{"input_spec_version",input_spec_version},
      {"source_rectangle",plan->source_rectangle},{"minimum_cosine",threshold},
      {"reference_cpu_image_processing",bool(reference_input)},{"floating_network_reference",reference_input ? Json(false) : Json(nullptr)},
      {"reference_kind",reference_input ? "cpu-image-oracle-same-bpu-hbm" : (reference ? "external-vector" : "none")},
      {"width",width},{"height",height},{"matrix",args.at("--matrix")},{"range",args.at("--range")},
      {"frames",frames},{"same_input_repeated",true},{"cpu_inference",false},{"cpu_image_processing",false},
      {"elapsed_ms",std::chrono::duration<double,std::milli>(Clock::now()-start).count()}};
    WriteNew(args.at("--report"),report);
    std::cout << report.dump(2) << '\n'; return reference && !numeric ? 1 : 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
