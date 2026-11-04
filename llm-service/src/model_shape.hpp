#pragma once
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <numeric>
#include <stdexcept>
#include <vector>

namespace ainvr::llm {
// Everything the grouped Qwen3-VL adapter once hard-coded for the 4B package, now read from the package manifest.
// A manifest without a "model" section is a v1 package (Qwen3-VL-4B: 2560 wide, four text groups of nine layers)
// and keeps exactly those values. The input image geometry (896x448 -> 392 merged tokens) is NOT configurable here:
// the GPU preprocessing and the compiled vision programs are built for it, so the engine rejects other geometries.
struct ModelShape {
  int hidden = 2560, head_dim = 128, kv_heads = 8, context = 1024, prefill = 256;
  int image_tokens = 392, image_grid_w = 28, image_token_id = 151655, deepstack = 3;
  std::array<int, 2> mrope_hw = {20, 20};      // interleaved MRoPE sections of the h and w axes (t takes the rest)
  float mask_min = -96.f;                       // masked-score value the programs were calibrated with
  std::vector<int> group_layers = {9, 9, 9, 9}; // decoder layers per compiled text group, in execution order
  int rope_pairs() const { return head_dim / 2; }
  int layers() const { return std::accumulate(group_layers.begin(), group_layers.end(), 0); }

  static ModelShape FromManifest(const nlohmann::json& manifest) {
    ModelShape s;
    if (manifest.contains("context_tokens")) s.context = manifest.at("context_tokens").get<int>();
    if (manifest.contains("prefill")) s.prefill = manifest.at("prefill").get<int>();
    if (manifest.contains("model")) {
      const auto& m = manifest.at("model");
      s.hidden = m.at("hidden").get<int>();
      s.head_dim = m.at("head_dim").get<int>();
      s.kv_heads = m.at("kv_heads").get<int>();
      s.group_layers = m.at("text_group_layers").get<std::vector<int>>();
      s.deepstack = m.value("deepstack", 3);
      s.image_token_id = m.value("image_token_id", 151655);
      s.mask_min = m.value("mask_min", -96.f);
      const auto section = m.value("mrope_section", std::vector<int>{24, 20, 20});
      if (section.size() != 3) throw std::runtime_error("model.mrope_section must have 3 entries");
      s.mrope_hw = {section[1], section[2]};
    }
    s.Validate();
    return s;
  }
  void Validate() const {
    auto bad = [](const char* what) { throw std::runtime_error(std::string("invalid model shape: ") + what); };
    if (hidden < 64 || hidden > 16384) bad("hidden");
    if (head_dim < 16 || head_dim > 256 || head_dim % 2) bad("head_dim");
    if (kv_heads < 1 || kv_heads > 64) bad("kv_heads");
    if (context < 2 || context > 8192) bad("context");
    if (prefill < 2 || prefill > context) bad("prefill");
    if (image_tokens < 1 || image_grid_w < 1 || image_tokens % image_grid_w || image_tokens + 1 > context) bad("image geometry");
    if (image_token_id < 0) bad("image_token_id");
    if (group_layers.empty() || group_layers.size() > 16) bad("text group count");
    for (int n : group_layers) if (n < 1 || n > 64) bad("layers per group");
    if (deepstack < 0 || deepstack > group_layers.front()) bad("deepstack must fit in the first text group");
    for (int n : mrope_hw) if (n < 0 || 3 * n > rope_pairs()) bad("mrope_section");
    if (!(mask_min < 0.f)) bad("mask_min");
  }
};
} // namespace ainvr::llm
