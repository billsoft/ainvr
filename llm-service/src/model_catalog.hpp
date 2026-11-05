#pragma once
#include "model_shape.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <regex>
#include <string>

namespace ainvr::llm {
inline constexpr const char* kModelsRoot = "/home/sunrise/ainvr/ai-service/models/llm";
inline constexpr const char* kDefaultPackageId = "qwen3vl-2b-review-v1";
// A package id is also a directory name under the models root: no separators, no dots at the start.
inline bool ValidPackageId(const std::string& id) {
  return std::regex_match(id, std::regex("[a-z0-9][a-z0-9._-]{0,63}"));
}
// Light inventory of the packages installed under `root`. It reads manifests only: no hashing, no BPU, no model
// memory. `ready` means the manifest parses and its shape validates; full file verification happens at load time.
inline nlohmann::json InstalledModels(const std::string& root, const std::string& loaded_id) {
  auto list = nlohmann::json::array();
  std::error_code ec;
  std::vector<std::filesystem::path> dirs;
  for (const auto& entry : std::filesystem::directory_iterator(root, ec))
    if (entry.is_directory(ec)) dirs.push_back(entry.path());
  std::sort(dirs.begin(), dirs.end());
  for (const auto& dir : dirs) {
    const auto manifest_path = dir / "llm-package.ainvr.json";
    if (!std::filesystem::is_regular_file(manifest_path, ec)) continue;
    nlohmann::json item = {{"directory", dir.filename().string()}};
    try {
      std::ifstream file(manifest_path); nlohmann::json m; file >> m;
      const auto shape = ModelShape::FromManifest(m);
      const std::string id = m.at("id").get<std::string>();
      const std::string label = m.value("label", std::string());
      item.update({{"id", id}, {"object", "model"}, {"created", 0}, {"owned_by", "ainvr"},
        {"title", !label.empty() ? label : "图片复审模型 · " + std::to_string(shape.layers()) + " 层 · " + std::to_string(shape.hidden) + " 维"},
        {"adapter", m.at("adapter")}, {"capabilities", m.value("capabilities", nlohmann::json::array())},
        {"hidden", shape.hidden}, {"layers", shape.layers()}, {"context_tokens", shape.context},
        {"ion_bytes_measured", m.contains("resources") ? m.at("resources").value("ion_bytes_measured", 0ULL) : 0ULL},
        {"validation", m.contains("validation") ? m.at("validation") : nlohmann::json(nullptr)},
        {"ready", id == dir.filename().string()}, {"loaded", id == loaded_id}});
      if (id != dir.filename().string()) item["error"] = "package id does not match its directory";
    } catch (const std::exception& e) {
      item.update({{"id", dir.filename().string()}, {"object", "model"}, {"ready", false}, {"loaded", false}, {"error", e.what()}});
    }
    list.push_back(std::move(item));
  }
  return list;
}
} // namespace ainvr::llm
