#include "vector_index.hpp"
#include <iostream>
#include <limits>
#include <functional>
using namespace ainvr::search;
void Check(bool good) { if (!good) throw std::runtime_error("test_failed"); }
void Reject(const std::function<void()>& fn) {
  bool rejected = false; try { fn(); } catch (const std::exception&) { rejected = true; }
  Check(rejected);
}
Record Row(std::string id, std::string channel, std::string session, std::string track, std::vector<float> v) {
  return {id, channel, "processor", session, track, "paired-v1", 1000, false, v};
}
int main() {
  VectorIndex index("paired-v1", 2, 6);
  auto a = Row("a", "allowed", "session1", "track1", {1, 0});
  index.Upsert(a); index.Upsert(a); Check(index.Size() == 1);
  index.Upsert(Row("b", "allowed", "session1", "track1", {0.8f, 0.2f}));
  index.Upsert(Row("c", "denied", "session1", "track1", {1, 0}));
  index.Upsert(Row("d", "allowed", "session2", "track1", {0.9f, 0.1f}));
  index.Upsert(Row("e", "allowed", "session1", "other-person", {1, 0}));
  auto last = Row("f", "allowed", "session3", "track1", {1, 0}); last.captured_ms = 2000; index.Upsert(last);
  auto hits = index.Query({1, 0}, {{"allowed"}, 1000, 2000, 20});
  Check(hits.size() == 3 && hits[0].id == "a" && hits[1].id == "e" && hits[2].id == "d");
  Reject([&]{ index.Upsert(Row("overflow", "allowed", "s", "t", {1, 0})); });
  Reject([&]{ auto r=a; r.channel="changed"; index.Upsert(r); });
  Reject([&]{ auto r=a; r.model="other-model"; index.Upsert(r); });
  Reject([&]{ index.Query({0, 0}, {{"allowed"}, 0, 2000, 20}); });
  Reject([&]{ index.Query({std::numeric_limits<float>::quiet_NaN(), 0}, {{"allowed"}, 0, 2000, 20}); });
  Reject([&]{ index.Query({1, 0}, {{}, 0, 2000, 20}); });
  index.Remove("a"); Check(index.Size() == 5);
  Check(index.Query({1, 0}, {{"allowed"}, 1000, 2000, 1})[0].id == "e");
  VectorIndex mutable_index("paired-v1", 2, 1);
  auto slot = a; slot.fingerprint = std::string(64, 'a');
  mutable_index.ReplaceTrackSlot(slot, "");
  auto replacement = slot; replacement.vector = {0, 1}; replacement.captured_ms = 1001;
  replacement.fingerprint = std::string(64, 'b');
  Reject([&] { mutable_index.Upsert(replacement); });
  Reject([&] { mutable_index.ReplaceTrackSlot(replacement, ""); });
  Reject([&] { mutable_index.ReplaceTrackSlot(replacement, std::string(64, 'c')); });
  auto wrong = replacement; wrong.session = "other-session";
  Reject([&] { mutable_index.ReplaceTrackSlot(wrong, slot.fingerprint); });
  wrong = replacement; wrong.scene = true;
  Reject([&] { mutable_index.ReplaceTrackSlot(wrong, slot.fingerprint); });
  Check(mutable_index.Query({1, 0}, {{"allowed"}, 1000, 2000, 20})[0].fingerprint == slot.fingerprint);
  mutable_index.ReplaceTrackSlot(replacement, slot.fingerprint);
  const auto replaced = mutable_index.Query({1, 0}, {{"allowed"}, 1000, 2000, 20});
  Check(mutable_index.Size() == 1 && replaced[0].score == 0 && replaced[0].fingerprint == replacement.fingerprint);
  Reject([&] { mutable_index.ReplaceTrackSlot(slot, slot.fingerprint); });
  Check(mutable_index.Fingerprint(slot.id) == replacement.fingerprint);
  std::cout << "vector index: identity, scope, grouping, limits and validation passed\n";
}
