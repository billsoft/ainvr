#include "index_runtime_policy.hpp"
#include <cstring>
#include <iostream>
#include <stdexcept>
using namespace ainvr::search;
int checks = 0;
void Check(bool ok) { ++checks; if (!ok) throw std::runtime_error("index_runtime_policy_failed"); }
int main() { try {
  // .189 reported dependency_unavailable for hours after one backend restart.
  Check(std::strcmp(RecoveredIndexState("dependency_unavailable", true), "working") == 0);
  Check(std::strcmp(RecoveredIndexState("cache_unavailable", true), "working") == 0);
  Check(std::strcmp(RecoveredIndexState("discovery_pending", true), "working") == 0);
  Check(std::strcmp(RecoveredIndexState("cleanup_pending", true), "working") == 0);
  Check(RecoveredIndexState("dependency_unavailable", false) == nullptr);   // still failing
  Check(RecoveredIndexState("publication_unconfirmed", true) == nullptr);   // cleared only by reconciliation
  Check(RecoveredIndexState("capacity_limited", true) == nullptr);
  Check(RecoveredIndexState("artifact_invalid", true) == nullptr);
  Check(RecoveredIndexState("working", true) == nullptr);
  std::cout << checks << " index runtime policy checks passed\n";
} catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; } }
