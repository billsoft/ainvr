// Pure checks of the manifest-driven model shape, the layout helpers and the installed-package inventory.
// No model load, SDK link or BPU run.
#include "layout.hpp"
#include "model_catalog.hpp"
#include <cassert>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <unistd.h>

using namespace ainvr::llm;
using Json = nlohmann::json;

static void Rejected(const std::function<void()>& run) {
  bool rejected = false;
  try { run(); } catch (const std::exception&) { rejected = true; }
  assert(rejected);
}
static Json Manifest2B() {
  return {{"schema", "ainvr.llm_package.v1"}, {"id", "qwen3vl-2b-review-v1"}, {"adapter", "qwen3vl_grouped"},
          {"context_tokens", 1024}, {"prefill", 256},
          {"model", {{"hidden", 2048}, {"head_dim", 128}, {"kv_heads", 8}, {"text_group_layers", {7, 7, 7, 7}}}}};
}
static std::vector<int> Prompt(int length, const ModelShape& s) {
  std::vector<int> ids(length, 2);
  ids[0] = 1;
  for (int i = 0; i < s.image_tokens; ++i) ids[1 + i] = s.image_token_id;
  return ids;
}

int main() {
  // A v1 manifest (no "model" section) keeps the 4B values the engine used to hard-code.
  const auto v1 = ModelShape::FromManifest({{"context_tokens", 1024}, {"prefill", 256}});
  assert(v1.hidden == 2560 && v1.head_dim == 128 && v1.kv_heads == 8 && v1.layers() == 36 && v1.group_layers.size() == 4);
  assert(v1.deepstack == 3 && v1.image_tokens == 392 && v1.image_grid_w == 28 && v1.mrope_hw[0] == 20 && v1.mrope_hw[1] == 20);

  // The 2B package: 2048 wide, 28 layers in four groups of seven.
  const auto two = ModelShape::FromManifest(Manifest2B());
  assert(two.hidden == 2048 && two.layers() == 28 && two.group_layers == std::vector<int>({7, 7, 7, 7}));
  auto custom = Manifest2B();
  custom["model"]["mrope_section"] = {24, 20, 20};
  custom["model"]["deepstack"] = 3;
  assert(ModelShape::FromManifest(custom).mrope_hw[0] == 20);

  // Broken shapes are rejected instead of being clamped.
  for (const char* key : {"hidden", "head_dim", "kv_heads", "text_group_layers"}) {
    auto m = Manifest2B(); m["model"].erase(key);
    Rejected([&] { ModelShape::FromManifest(m); });
  }
  auto bad = Manifest2B(); bad["model"]["hidden"] = 0;                     Rejected([&] { ModelShape::FromManifest(bad); });
  bad = Manifest2B(); bad["model"]["head_dim"] = 127;                      Rejected([&] { ModelShape::FromManifest(bad); });
  bad = Manifest2B(); bad["model"]["text_group_layers"] = Json::array();   Rejected([&] { ModelShape::FromManifest(bad); });
  bad = Manifest2B(); bad["model"]["text_group_layers"] = {0, 7};         Rejected([&] { ModelShape::FromManifest(bad); });
  bad = Manifest2B(); bad["model"]["text_group_layers"] = {2, 26};         Rejected([&] { ModelShape::FromManifest(bad); });   // DeepStack (3) must fit in group 0
  bad = Manifest2B(); bad["model"]["mrope_section"] = {24, 30, 20};       Rejected([&] { ModelShape::FromManifest(bad); });   // 3*30 > 64 pairs
  bad = Manifest2B(); bad["model"]["mrope_section"] = {24, 20};           Rejected([&] { ModelShape::FromManifest(bad); });
  bad = Manifest2B(); bad["prefill"] = 2048;                               Rejected([&] { ModelShape::FromManifest(bad); });
  bad = Manifest2B(); bad["model"]["mask_min"] = 0.0;                      Rejected([&] { ModelShape::FromManifest(bad); });

  // Layout: the default shape reproduces the former constants, and the 2B shape (same image geometry) lays tokens out identically.
  for (int length : {393, 466, 512, 513, 769, 1024}) {
    const auto ids = Prompt(length, v1);
    const auto a = Positions(ids), b = Positions(ids, two);
    assert(a == b);
    const auto pa = PrefillPlan(length), pb = PrefillPlan(length, two);
    assert(pa.size() == pb.size());
    for (size_t i = 0; i < pa.size(); ++i) assert(pa[i].start == pb[i].start && pa[i].rows == pb[i].rows && pa[i].profile == pb[i].profile);
    for (size_t i = 0; i < pa.size(); ++i) {
      std::vector<float> ma(pa[i].profile * 1024), mb(ma.size());
      FillMask(pa[i], ma.data()); FillMask(pb[i], mb.data(), two);
      assert(ma == mb);
    }
  }
  // Text resumes after the larger grid side: image at tokens 1..392 starts at position 1, 14x28 grid -> text at 1+28.
  { const auto p = Positions(Prompt(400, v1));
    assert(p[1][0] == 1 && p[1][1] == 1 && p[1][2] == 1);          // first image token: t=h=w=start
    assert(p[28][1] == 1 && p[28][2] == 1 + 27);                   // end of the first grid row
    assert(p[29][1] == 1 + 1 && p[29][2] == 1);                    // second row starts again at column 0
    assert(p[393][0] == 1 + 28 && p[393][1] == 1 + 28); }          // text resumes after the larger grid side
  // The interleaved MRoPE axis rule: t, h, w cycle every three pairs, h/w stop at their section length, the rest is t.
  { std::vector<std::array<int, 3>> positions(300, {5, 6, 7});
    std::vector<float> table(1024 * 64);
    for (int p = 0; p < 1024; ++p) for (int i = 0; i < 64; ++i) table[p * 64 + i] = float(p * 1000 + i);
    std::vector<float> cos(256 * 128), sin(256 * 128);
    Chunk chunk{0, 256, 256};
    FillRope(positions, chunk, table.data(), table.data(), cos.data(), sin.data(), two);
    for (int col = 0; col < 128; ++col) {
      const int i = col % 64, axis = (i < 60 && i % 3 != 0) ? i % 3 : 0;   // the original hard-coded rule
      assert(cos[col] == float(positions[0][axis] * 1000 + i));
    }
  }
  Rejected([&] { PrefillPlan(1025); });
  Rejected([&] { Positions(std::vector<int>(500, 1)); });

  // Package ids double as directory names.
  assert(ValidPackageId("qwen3vl-4b-review-v3") && ValidPackageId("qwen3vl-2b-review-v1") && ValidPackageId("a"));
  for (const char* id : {"", "../x", "a/b", ".hidden", "UPPER", "a b", "-lead"}) assert(!ValidPackageId(id));

  // Installed-package inventory: manifests only.
  const auto root = std::filesystem::temp_directory_path() / ("ainvr-model-catalog-" + std::to_string(::getpid()));
  std::filesystem::remove_all(root);
  auto put = [&](const std::string& dir, const Json& manifest) {
    std::filesystem::create_directories(root / dir);
    std::ofstream(root / dir / "llm-package.ainvr.json") << manifest.dump();
  };
  auto four = Json{{"schema", "ainvr.llm_package.v1"}, {"id", "qwen3vl-4b-review-v3"}, {"adapter", "qwen3vl_grouped"},
                   {"context_tokens", 1024}, {"prefill", 256}, {"capabilities", {"task:alarm-review-zh-v1"}},
                   {"resources", {{"ion_bytes_measured", 5500000000ULL}}}};
  put("qwen3vl-4b-review-v3", four);
  put("qwen3vl-2b-review-v1", Manifest2B());
  put("renamed-dir", four);                                  // id disagrees with its directory
  put("broken", Json{{"id", "broken"}});                     // no schema fields
  std::filesystem::create_directories(root / "not-a-package");
  const auto list = InstalledModels(root.string(), "qwen3vl-2b-review-v1");
  assert(list.size() == 4);
  std::map<std::string, Json> by;
  for (const auto& item : list) by[item.at("directory")] = item;
  assert(by.at("qwen3vl-4b-review-v3").at("ready") == true && by.at("qwen3vl-4b-review-v3").at("loaded") == false);
  assert(by.at("qwen3vl-4b-review-v3").at("hidden") == 2560 && by.at("qwen3vl-4b-review-v3").at("ion_bytes_measured") == 5500000000ULL);
  assert(by.at("qwen3vl-2b-review-v1").at("hidden") == 2048 && by.at("qwen3vl-2b-review-v1").at("layers") == 28);
  assert(by.at("qwen3vl-2b-review-v1").at("loaded") == true);
  assert(by.at("qwen3vl-4b-review-v3").at("title") == "图片复审模型 · 36 层 · 2560 维");
  assert(by.at("qwen3vl-2b-review-v1").at("title") == "图片复审模型 · 28 层 · 2048 维");
  assert(by.at("renamed-dir").at("ready") == false && by.at("renamed-dir").contains("error"));
  assert(by.at("broken").at("ready") == false && by.at("broken").contains("error"));
  assert(InstalledModels((root / "missing").string(), "").empty());
  std::filesystem::remove_all(root);
  std::cout << "model shape and catalog checks passed\n";
  return 0;
}
