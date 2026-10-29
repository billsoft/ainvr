// Process-wide metadata ceiling, independent of the existing 1..4 physical
// frame/encoder/HTTP work tickets. Unknown receipts never retain raw pixels.
#pragma once
#include <cstddef>
namespace ai_service::output {
inline constexpr size_t kSearchSamplingMetadataPendingLimit=64;
} // namespace ai_service::output
