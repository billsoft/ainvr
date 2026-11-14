#include "index_warm_policy.hpp"
#include <cstring>
#include <iostream>
#include <stdexcept>
using namespace ainvr::search;
int checks = 0;
void Check(bool ok) { ++checks; if (!ok) throw std::runtime_error("index_warm_policy_failed"); }
int main() { try {
  {   // .190 holds ~41.7k four-view vectors while Mongo keeps up to 100k samples: the projection fills.
    ShardWarmRecord record;
    Check(record.NeedsLoad("a", "m1", 5, false));                 // never read
    record.Loaded("a", "m1", 5, false);
    Check(!record.NeedsLoad("a", "m1", 5, false));                // complete and unchanged
    Check(record.NeedsLoad("a", "m2", 5, false));                 // republished
    Check(record.NeedsLoad("a", "m1", 6, false));                 // a row of its day was dropped for room
    record.Loaded("b", "m1", 1, true);                            // read cut off: the projection filled up
    Check(!record.NeedsLoad("b", "m1", 1, true));                 // still full: reading would add nothing
    Check(record.NeedsLoad("b", "m1", 1, false));                 // room appeared: read again for what is missing
    Check(!record.NeedsLoad("never-read", "m1", 1, true));        // a full projection reads no file at all
    record.Loaded("b", "m1", 1, false);
    Check(!record.NeedsLoad("b", "m1", 1, false));
    Check(record.NeedsLoad("c", "m1", std::nullopt, false));      // unparsable day: no epoch, always read
    record.Loaded("c", "m1", std::nullopt, false);
    Check(record.Size() == 2);
  }
  {   // bounded
    ShardWarmRecord record(2);
    record.Loaded("a", "m", 1, false); record.Loaded("b", "m", 1, false); record.Loaded("a", "m", 2, false);
    Check(record.Size() == 2);
    record.Loaded("c", "m", 1, false);
    Check(record.Size() == 1 && !record.NeedsLoad("c", "m", 1, false) && record.NeedsLoad("a", "m", 2, false));
  }
  {   // .189 reported dependency_unavailable for hours after one backend restart.
    Check(std::strcmp(RecoveredIndexState("dependency_unavailable", true), "working") == 0);
    Check(std::strcmp(RecoveredIndexState("cache_unavailable", true), "working") == 0);
    Check(std::strcmp(RecoveredIndexState("discovery_pending", true), "working") == 0);
    Check(RecoveredIndexState("dependency_unavailable", false) == nullptr);   // still failing
    Check(RecoveredIndexState("publication_unconfirmed", true) == nullptr);   // cleared only by reconciliation
    Check(RecoveredIndexState("capacity_limited", true) == nullptr);
    Check(RecoveredIndexState("artifact_invalid", true) == nullptr);
    Check(RecoveredIndexState("working", true) == nullptr);
  }
  std::cout << checks << " index warm policy checks passed\n";
} catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; } }
