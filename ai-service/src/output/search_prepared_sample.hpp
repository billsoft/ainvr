// AINVR. Frozen search payload from a single original frame; no transport.
#pragma once
#include "output/search_sampling_owner.hpp"
#include "../../../search-service/src/sample_contract.hpp"
#include "output/snapshot_plan.hpp"
namespace ai_service::output {
struct SearchHardwareProduct {
  ainvr::SnapshotPlan plan;
  std::vector<uint8_t> jpeg;
  std::vector<float> embedding;
  std::string render_backend, encoder_backend, vision_backend;
};
struct SearchPreparedSample {
  std::shared_ptr<const ainvr::search::Sample> sample;
  config::SearchProducerSource source;
  SearchEmbeddingSpace space;
  SearchSamplingPolicy::Candidate candidate;
};
// Pure metadata/geometry/byte ownership. Does not decode, resize, infer or write.
// Native image operations have already completed on the affine owner.
std::shared_ptr<const SearchPreparedSample> BuildSearchPreparedSample(const FrozenSearchFrame&,
    const SearchEmbeddingSpace&, const config::SearchProducerLease&, SearchHardwareProduct,
    std::optional<SearchAppearanceAudit> appearance={});
}  // namespace ai_service::output
