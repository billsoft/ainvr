#pragma once
#include <string>
namespace ainvr::search {
// A stage that failed (a dependency briefly unavailable, for example while the
// backend restarts) left its state behind; before this the state changed again only
// on the next publication, so an idle board reported the fault for hours. A pass in
// which every stage succeeds clears such a transient fault.
inline const char* RecoveredIndexState(const std::string& current, bool every_stage_ok) {
  const bool transient = current == "dependency_unavailable" || current == "cache_unavailable" ||
                         current == "discovery_pending" || current == "cleanup_pending";
  return every_stage_ok && transient ? "working" : nullptr;
}
}  // namespace ainvr::search
