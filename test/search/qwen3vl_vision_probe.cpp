// Hardware probe for the Qwen3-VL-Embedding image path as the sampler runs it: JPU decode -> NV12 -> GLES
// (region crop, bicubic, stretch/letterbox) -> CHW float -> the nine-HBM embedder. Run ONLY with the production
// AI service paused (board_guard_eval_v2.sh): it opens the BPU, JPU and GLES itself.
//   qwen3vl_vision_probe MODELS_ROOT OUT.f32 [--dump-chw DIR] FILE.jpg[:x,y,w,h] ...
// FILE.jpg alone = full-frame (scene) plan; with :x,y,w,h = object plan around that raw box (25% padding).
#include "analytics/jpeg_dimensions.hpp"
#include "embedding/qwen3vl_embedder.hpp"
#include "output/search_hardware_plan.hpp"
#include "output/search_qwen_transform.hpp"
#include "platform/image_preprocessor.hpp"
#include "platform/vpu_decoder.hpp"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>

using namespace ai_service::output;

static std::string ReadAll(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) throw std::runtime_error("cannot read " + path);
  std::ostringstream s; s << f.rdbuf(); return s.str();
}

int main(int argc, char** argv) {
  if (argc < 4) { std::fprintf(stderr, "usage: see source header\n"); return 2; }
  const std::string root = argv[1];
  std::ofstream out(argv[2], std::ios::binary);
  int first = 3;
  std::string dump;
  if (std::string(argv[first]) == "--dump-chw" && first + 1 < argc) { dump = argv[first + 1]; first += 2; }
  ainvr::embedding::EmbeddingFiles files;
  files.path = [&](const std::string& rel) { return root + "/" + rel; };
  files.read = [&](const std::string& rel) { return ReadAll(root + "/" + rel); };
  auto embedder = ainvr::embedding::Qwen3VlEmbedder::Load(files);
  ainvr::ImagePreprocessor preprocessor({true, true, false});
  for (int i = first; i < argc; ++i) {
    std::string spec = argv[i], path = spec;
    std::array<double, 4> box{};
    bool object = false;
    if (const auto colon = spec.find(':'); colon != std::string::npos) {
      path = spec.substr(0, colon);
      if (std::sscanf(spec.c_str() + colon + 1, "%lf,%lf,%lf,%lf", &box[0], &box[1], &box[2], &box[3]) != 4) { std::fprintf(stderr, "bad box %s\n", spec.c_str()); return 2; }
      object = true;
    }
    const auto bytes = ReadAll(path);
    const std::vector<uint8_t> jpeg(bytes.begin(), bytes.end());
    const auto [width, height] = ai_service::analytics::JpegDimensions(jpeg);
    ainvr::VpuDecoder decoder(ainvr::Codec::Jpeg, width, height);
    while (!decoder.Submit(jpeg, 0, 50)) {}
    std::optional<ainvr::Nv12Frame> frame;
    while (!frame) frame = decoder.Receive(50);
    const auto t0 = std::chrono::steady_clock::now();
    auto plan = SearchHardwarePlan(object ? box : std::array<double, 4>{}, width, height, !object,
                                   object ? 768 : std::min(4096, std::max(width, height)), object ? 0.25 : 0.0);
    auto transform = QwenVisionTransform(plan, false, true);
    if (const char* mode = std::getenv("QWEN_INTERP"); mode && std::string(mode) == "area") transform.interpolation = ainvr::ImageInterpolation::Area;   // experiment
    auto prepared = preprocessor.RunNv12(*frame, transform);
    const auto t1 = std::chrono::steady_clock::now();
    if (!dump.empty()) {
      std::ofstream d(dump + "/" + std::to_string(i - first) + ".chw", std::ios::binary);
      d.write(reinterpret_cast<const char*>(prepared.chw.data()), prepared.chw.size() * sizeof(float));
    }
    ainvr::embedding::EmbeddingStats stats;
    const auto vector = embedder->EmbedImageChw(prepared.chw.data(), &stats);
    out.write(reinterpret_cast<const char*>(vector.data()), vector.size() * sizeof(float));
    std::printf("%s %dx%d %s letterbox=%d backend=%s gles=%.0f ms embed=%.0f ms\n", path.c_str(), width, height, object ? "object" : "scene",
                transform.letterbox ? 1 : 0, prepared.backend.c_str(), std::chrono::duration<double, std::milli>(t1 - t0).count(), stats.total_ms);
  }
  return 0;
}
