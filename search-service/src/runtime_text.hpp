#pragma once
#include "runtime_config.hpp"
#include "model_package.hpp"
#include <algorithm>
#include <functional>

namespace ainvr::search {
inline void RequireRuntimeModelAuthority(const EffectiveRuntime& runtime,const RuntimeModelPin& candidate,
                                         const std::function<bool(const std::string&)>& history_compatible) {
  // Validate constructed candidates as strictly as the authenticated envelope.
  const auto verified=ReadRuntimeModelPin(RuntimeModelPinJson(candidate));
  if(verified.package_id!=runtime.package_id)throw std::runtime_error("search_encoder_identity_invalid");
  if(runtime.active_model_pin&&*runtime.active_model_pin==verified)return;
  if(runtime.approved_model_transition) {
    const auto& transition=*runtime.approved_model_transition;
    if(transition.target==verified&&(!runtime.active_model_pin||transition.source==*runtime.active_model_pin))return;
    throw std::runtime_error("model_migration_required");
  }
  if(runtime.active_model_pin||!history_compatible||!history_compatible(verified.model_version))
    throw std::runtime_error("model_migration_required");
}
// The pin's first successful ACK changes the authoritative revision. Never
// open this generation using the stale pre-pin revision, even briefly.
inline bool RuntimeAckStillCurrent(const EffectiveRuntime& applied,const EffectiveRuntime& current) {
  return applied.version==current.version&&applied.revision==current.revision;
}
inline std::unique_ptr<TextEncoder> LoadAuthorizedRuntimeTextEncoder(const EffectiveRuntime& runtime,
    const RuntimeModelPin& candidate,const std::function<bool(const std::string&)>& history_compatible,
    const std::function<std::unique_ptr<TextEncoder>()>& construct) {
  RequireRuntimeModelAuthority(runtime,candidate,history_compatible);
  if(!construct)throw std::runtime_error("search_encoder_identity_invalid");
  auto encoder=construct();
  if(!encoder||encoder->ModelVersion()!=candidate.model_version||!encoder->Healthy())
    throw std::runtime_error("search_encoder_identity_invalid");
  RequireRuntimeModelAuthority(runtime,candidate,history_compatible);
  return encoder;
}
// The factory is supplied by the executable's compile-time BPU option. An empty
// factory means unavailable, never a synthetic encoder or another model.
using RuntimeTextLoader = std::function<std::unique_ptr<TextEncoder>(const std::string&)>;
inline std::unique_ptr<TextEncoder> LoadConfiguredTextEncoder(const EffectiveRuntime& runtime,
                                                            const RuntimeTextLoader& loader) {
  if (!runtime.access.enabled || !runtime.access.unavailable_reason.empty() ||
      !runtime.history_ready || runtime.package_id.empty() || !loader) return nullptr;
  const auto& spec = FindPackageSpec(runtime.package_id);
  if (spec.pruned) throw std::runtime_error("search_model_pending");
  auto encoder = loader(runtime.package_id);
  if (!encoder || encoder->Dimensions() != spec.dimensions ||
      !std::regex_match(encoder->ModelVersion(), std::regex("search-v1-[a-f0-9]{64}")))
    throw std::runtime_error("search_encoder_identity_invalid");
  return encoder;
}
inline size_t RuntimeProjectionCapacity(const EffectiveRuntime& runtime, size_t dimensions) {
  if (!dimensions || dimensions > 4096 || runtime.budget.max_samples < 1)
    throw std::invalid_argument("invalid_index_budget");
  // Match the existing exact projection's 64M-float ceiling. max_samples is
  // history retention capacity, not a promise to hold every vector in RAM.
  return std::min(size_t(runtime.budget.max_samples), size_t(64000000) / dimensions);
}
inline Scope RuntimeProjectionWindow(const EffectiveRuntime& runtime, int64_t now) {
  if (now <= 0 || runtime.access.sources.empty() || runtime.access.sources.size() > 1024)
    throw std::runtime_error("search_projection_scope_pending");
  Scope scope;
  for (const auto& source : runtime.access.sources) scope.channels.insert(source.first);
  scope.to_ms = now;
  scope.from_ms = std::max(int64_t(0), now - std::min(runtime.budget.retention_ms, int64_t(31) * 86400000));
  return scope;
}
}  // namespace ainvr::search
