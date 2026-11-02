// Offline checks for the Qwen3-VL-Embedding runtime (hardware modes need the S100P BPU).
//   qwen3vl_embed_cli ROOT tokens GOLDEN.jsonl           tokenizer golden test (no hardware)
//   qwen3vl_embed_cli ROOT embed  ITEMS.jsonl OUT.f32 [limit]
// ITEMS lines: {"id","input_ids":[..],"rgb":"x.rgb"?} | {"id","text":".."} | {"id","rgb":"x.rgb"} | {"id","chw":"x.f32"} (document image).
#include "embedding/qwen3vl_embedder.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstring>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <thread>
#include <sstream>

using nlohmann::json;
using namespace ainvr::embedding;

static std::string ReadAll(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) throw std::runtime_error("cannot read " + path);
  std::ostringstream s; s << f.rdbuf(); return s.str();
}

int main(int argc, char** argv) {
  if (argc < 4) { std::fprintf(stderr, "usage: see source header\n"); return 2; }
  const std::string root = argv[1], mode = argv[2];
  if (mode == "tokens") {
    QwenTokenizer tokenizer(ReadAll(root + "/" + kVocabJson), ReadAll(root + "/" + kMergesTxt));
    std::ifstream in(argv[3]);
    std::string line; int total = 0, bad = 0;
    while (std::getline(in, line)) {
      if (line.empty()) continue;
      const auto item = json::parse(line);
      const auto expected = item.at("ids").get<std::vector<int32_t>>();
      std::vector<int32_t> got;
      try {
        got = item.contains("image") ? BuildImageIds(tokenizer, kImageTokens) : BuildQueryIds(tokenizer, item.at("text").get<std::string>(), 100000);
      } catch (const std::exception& e) { std::printf("ERR  %s: %s\n", item.dump().substr(0, 80).c_str(), e.what()); ++bad; ++total; continue; }
      ++total;
      if (got != expected) { ++bad; std::printf("DIFF text=%s\n  want:", item.value("text", "<image>").c_str()); for (auto v : expected) std::printf(" %d", v); std::printf("\n  got: "); for (auto v : got) std::printf(" %d", v); std::printf("\n"); }
    }
    std::printf("tokens: %d cases, %d mismatches\n", total, bad);
    return bad ? 1 : 0;
  }
  if (mode == "embed") {
    if (argc < 5) return 2;
    EmbeddingFiles files;
    files.path = [&](const std::string& rel) { return root + "/" + rel; };
    files.read = [&](const std::string& rel) { return ReadAll(root + "/" + rel); };
    const auto t0 = std::chrono::steady_clock::now();
    auto embedder = Qwen3VlEmbedder::Load(files);
    std::printf("loaded %.1f s\n", std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
    std::ifstream in(argv[3]);
    std::ofstream out(argv[4], std::ios::binary);
    const int limit = argc > 5 ? std::atoi(argv[5]) : 1 << 30;
    std::string line; int n = 0;
    while (n < limit && std::getline(in, line)) {
      if (line.empty()) continue;
      const auto item = json::parse(line);
      std::vector<uint8_t> rgb;
      std::vector<float> chw;
      if (item.contains("chw")) {   // already normalised planar float32 3x448x896 (GPU preprocessing output or a reference of it)
        const auto bytes = ReadAll(item.at("chw").get<std::string>());
        if (bytes.size() != size_t(3) * kImageHeight * kImageWidth * sizeof(float)) throw std::runtime_error("chw size");
        chw.resize(bytes.size() / sizeof(float));
        std::memcpy(chw.data(), bytes.data(), bytes.size());
      } else if (item.contains("rgb")) {
        const auto bytes = ReadAll(item.at("rgb").get<std::string>());
        rgb.assign(bytes.begin(), bytes.end());
        if (rgb.size() != size_t(kImageWidth) * kImageHeight * 3) throw std::runtime_error("rgb size");
      }
      EmbeddingStats stats;
      std::vector<float> v;
      if (!chw.empty()) v = embedder->EmbedImageChw(chw.data(), &stats);
      else if (item.contains("input_ids")) v = embedder->EmbedIds(item.at("input_ids").get<std::vector<int32_t>>(), rgb.empty() ? nullptr : rgb.data(), !rgb.empty() ? false : true, &stats);
      else if (item.contains("text")) v = embedder->EmbedQuery(item.at("text").get<std::string>(), &stats);
      else v = embedder->EmbedImage(rgb.data(), &stats);
      out.write(reinterpret_cast<const char*>(v.data()), v.size() * sizeof(float));
      std::printf("%s vision=%.0f text=%.0f total=%.0f ms | calls=%d build=%.0f set=%.0f run=%.0f get=%.0f\n", item.value("id", "?").c_str(), stats.vision_ms, stats.text_ms, stats.total_ms, stats.calls, stats.build_ms, stats.set_ms, stats.run_ms, stats.get_ms);
      ++n;
    }
    return 0;
  }
  return 2;
}
