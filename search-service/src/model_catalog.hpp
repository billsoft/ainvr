#pragma once
#include "model_package.hpp"
#include <stdexcept>
namespace ainvr::search {
// Explicit administrator operation, unlike the cheap inventory below. The
// caller supplies a first-party fixed trusted root, never an HTTP path. This
// proves file/contracts identity only; no model is loaded or declared accurate.
inline nlohmann::json VerifyModelProfile(const std::string& trusted_root,const std::string& package_id) {
  auto verified=VerifyPackageAtTrustedRoot(trusted_root,package_id);
  if(!verified.files_verified||!verified.spec||!VerifyStillCurrent(verified)||
      verified.model_version.size()!=74||verified.model_version.rfind("search-v1-",0)!=0)
    throw std::runtime_error("search_model_pending");
  const auto& spec=*verified.spec;
  return {{"package_id",spec.id},{"package_sha256",verified.model_version.substr(10)},
    {"model_version",verified.model_version},{"dimensions",spec.dimensions},{"input_spec_version",spec.input_spec_version},
    {"files_verified",true},{"production_approval_declared",verified.production_approval_declared},
    {"pruned",spec.pruned},{"runtime_ready",false}};
}
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
