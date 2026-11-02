// AINVR. Search hardware session for the Qwen3-VL-Embedding model package (single weight owner).
#pragma once
#include "output/search_hardware_owner.hpp"

namespace ai_service::output {

struct SearchHardwareNativeOptions;
// Verifies and loads the nine HBM packages under the shared ION reservation, starts the local text-query
// channel and returns a session whose Prepare() embeds the same crop plan that produced the evidence JPEG.
// All calls on the owner (GLES-affine) thread, like the SigLIP session.
std::unique_ptr<SearchHardwareSession> MakeQwenSearchSession(const std::string& package_id,
    const SearchHardwareNativeOptions& options, const std::optional<ainvr::search::RuntimeModelPin>& expected,
    const SearchSamplingCurrent& current);

}  // namespace ai_service::output
