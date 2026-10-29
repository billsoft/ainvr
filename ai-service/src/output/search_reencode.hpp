// Retained JPEG migration shares the live affine hardware owner. No HTTP or
// model authority is introduced here; the authenticated caller owns Current.
#pragma once
#include "output/search_sampling_owner.hpp"
#include "../../../shared/cpp/search_reencode_contract.hpp"
namespace ai_service::output {
inline constexpr const char* kSearchReencodePreprocessing =
    ainvr::search::kRetainedJpegPreprocessingVersion;
inline constexpr size_t kSearchReencodeMaxJpegBytes = 8U * 1024 * 1024;
inline constexpr size_t kSearchReencodeMaxPixels = 8U * 1024 * 1024;
struct SearchReencodeResult {
  enum class Status { Ready, Busy, Stale, Unsupported, Failed };
  Status status = Status::Failed;
  SearchEmbeddingSpace space;
  std::vector<float> embedding;
  int image_width = 0, image_height = 0;
};
}  // namespace ai_service::output
