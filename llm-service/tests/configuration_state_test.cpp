#include "configuration_state.hpp"
#include <cassert>
using ainvr::llm::ConfigurationState;
int main() {
  ConfigurationState state;
  state.Begin(4);
  assert(state.Report().at("status") == "pending");
  assert(!state.Report().contains("appliedVersion"));
  state.Fail(4, "load failed");
  assert(state.Report().at("status") == "failed");
  assert(state.committed() == 0);
  state.Begin(5);
  assert(state.Commit(5));
  state.Begin(6);
  assert(!state.Commit(5));
  state.Fail(5, "stale failure");
  assert(state.Report().at("status") == "pending");
  state.Fail(6, "memory unavailable");
  assert(state.committed() == 5);
  assert(state.Report().at("status") == "failed");
  state.Begin(3); // Explicit rollback versions need not be monotonic.
  assert(state.Commit(3));
  assert(state.Report().at("status") == "applied");
  assert(state.Report().at("errorMessage") == "");
}
