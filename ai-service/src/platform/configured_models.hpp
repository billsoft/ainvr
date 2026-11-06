#pragma once
#include "config/config.hpp"
#include "configured_residency.hpp"
#include <filesystem>
#include <fstream>
#include <nlohmann/json.hpp>

namespace ainvr {
struct ConfiguredModels {
  ConfiguredResidency<int>::Demand demand;
  std::set<std::string> enhancement_paths;
  size_t invalid_dependencies = 0;
};
inline ConfiguredModels CollectConfiguredModels(
    const ai_service::config::AppConfig& config, const std::filesystem::path& root) {
  ConfiguredModels result;
  auto resolve = [&](std::filesystem::path path) {
    if (path.is_relative()) path = root / path;
    return std::filesystem::weakly_canonical(path).string();
  };
  for (const auto& channel : config.channels) {
    if (!channel.enabled || channel.deletion_pending) continue;
    const auto path = resolve(channel.model.path);
    const auto owner = "channel:" + channel.id;
    result.demand[path + ":"].insert(owner + "/detection");
    if (channel.model.adapter == "yoloe_bpu") {
      try {
      const auto sidecar = path + ".ainvr.json";
      if (std::filesystem::is_regular_file(sidecar) && std::filesystem::file_size(sidecar) <= 1024 * 1024) {
        std::ifstream file(sidecar);
        const auto manifest = nlohmann::json::parse(file);
        const auto& text = manifest.at("dynamic_text");
        for (const auto* name : {"text_hbm", "reprta_hbm"}) {
          std::filesystem::path dependency = text.at(name).get<std::string>();
          if (dependency.is_relative()) dependency = std::filesystem::path(path).parent_path() / dependency;
          result.demand[resolve(dependency) + ":"].insert(owner + "/" + name);
        }
      } else ++result.invalid_dependencies;
      } catch (const std::exception&) { ++result.invalid_dependencies; }
    }
    const auto& snapshot = channel.snapshot;
    if (snapshot.enabled && snapshot.face_enhance_model != "none") {
      const auto enhance = resolve(snapshot.face_enhance_model == "gpen"
          ? config.snapshot_store.face_enhance_engine : config.snapshot_store.face_enhance_codeformer_engine);
      result.demand[enhance + ":"].insert(owner + "/enhancement");
      result.enhancement_paths.insert(enhance);
    }
  }
  return result;
}
}
