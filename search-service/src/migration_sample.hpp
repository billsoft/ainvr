// Pure retained-image transformation. Authorization and durable writes remain
// in the existing PG lease / HistoryMongo authorities, never in this helper.
#pragma once
#include "sample_contract.hpp"
#include "model_package.hpp"
#include "model_pin.hpp"
#include "../../shared/cpp/search_reencode_contract.hpp"
namespace ainvr::search {
// Also used by the receipt path; never derive a second key from job/lease IDs.
std::string ReencodedSampleStorageUuid(const Sample& source,const std::string& target_model_version);
// Metadata lineage only. Callers independently establish current visibility,
// verified metadata anchors and raw-vector/JPEG integrity where needed. The
// report reads no vector/image; the published index validates actual vectors.
bool ReencodedMetadataMatches(const Sample& source,const Sample& target,
    const RuntimeModelPin& source_model,const RuntimeModelPin& target_model,const PackageSpec& target_spec,
    const std::string& source_jpeg_sha256,const std::string& target_jpeg_sha256,size_t target_dimensions);
Sample MakeReencodedSample(const Sample& source,const RuntimeModelPin& source_model,
    const RuntimeModelPin& target_model,const PackageSpec& target_spec,
    const std::vector<float>& embedding,const std::string& expected_source_fingerprint,
    const std::string& expected_jpeg_sha256,int64_t now_ms);
}  // namespace ainvr::search
