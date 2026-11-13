#pragma once
#include <nlohmann/json.hpp>

namespace ainvr::search {
inline constexpr const char* kHistoryScanChannelIndex = "search_scan_channel_v1";

// An ordinal page must not first fetch/sort every JPEG-bearing document in a
// time range. Keep the scope/expiry predicates in the index, before FETCH.
// Scan's existing <=100-channel contract allows ordered index-stream merging;
// regression tests cover the maximum legal scope as well as one/three channels.
// Do not widen that contract without rechecking the plan's scan-explosion bound.
inline nlohmann::ordered_json HistoryScanIndexes() {
  using Json = nlohmann::ordered_json;
  return Json::array({
    {{"key", {{"model", 1}, {"channel", 1}, {"ordinal", 1},
              {"captured_ms", 1}, {"expires_at", 1}}}, {"name", kHistoryScanChannelIndex}}
  });
}
} // namespace ainvr::search
