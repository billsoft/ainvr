#pragma once
#include "model_package.hpp"
namespace ainvr::search {
// Small inventory only: no HBM hashing, allocation, execution or approval.
inline nlohmann::json ModelCatalog(const std::string& trusted_root) {
  using Json = nlohmann::json;
  Json items = Json::array();
  for (const auto& candidate : PackageSpecs()) {
    if (!PackageArtifactsPresent(trusted_root, candidate)) continue;
    std::string reason;
    try {
      const auto metadata = InspectPackageMetadata(trusted_root, candidate);
      reason = candidate.pruned ? "model_pruned_validation_pending" :
        metadata.at("production_approval_declared").get<bool>() ? "model_runtime_pending" : "model_validation_pending";
    } catch (...) { reason = "model_package_invalid"; }
    items.push_back({{"package_id", candidate.id}, {"display_name", candidate.title}, {"ready", false}, {"reason", reason},
      {"model_version", nullptr}, {"dimensions", candidate.dimensions}});
  }
  return {{"items", items}, {"service_ready", true}, {"reason", nullptr}};
}
}  // namespace ainvr::search
