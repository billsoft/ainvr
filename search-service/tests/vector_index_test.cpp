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
  // Cursor maintenance visits every entry independently of time/source scope,
  // never returns vector payload, never repeats within a batch, and wraps.
  std::string cursor;
  auto refs = index.ScanReferences(cursor, 2);
  Check(refs.size() == 2 && refs[0].id == "b" && refs[1].id == "c" && cursor == "c");
  index.Remove("c");
  refs = index.ScanReferences(cursor, 2);
  Check(refs.size() == 2 && refs[0].id == "d" && refs[1].id == "e");
  refs = index.ScanReferences(cursor, 64);
  Check(refs.size() == 4 && refs[0].id == "f" && refs[1].id == "b" && cursor == "e");
  refs = mutable_index.ScanReferences(cursor, 1);
  Check(refs.size() == 1 && refs[0].fingerprint == replacement.fingerprint);
  Reject([&] { index.ScanReferences(cursor, 0); });
  Reject([&] { index.ScanReferences(cursor, 65); });
  VectorIndex bounded("paired-v1", 2, 100);
  for (int n = 0; n < 100; ++n) bounded.Upsert(Row(std::to_string(n), "outside-query", "s", std::to_string(n), {1, 0}));
  cursor.clear(); std::set<std::string> seen;
  for (int n = 0; n < 4; ++n) {
    refs = bounded.ScanReferences(cursor, 32); Check(refs.size() == 32);
    for (const auto& ref : refs) seen.insert(ref.id);
  }
  Check(seen.size() == 100);
  VectorIndex evidence_index("paired-v1",2,8);
  auto earliest=Row("early","allowed","same-session","same-person",{0,1});earliest.captured_ms=1000;earliest.fingerprint=std::string(64,'a');
  auto winner=earliest;winner.id="winner";winner.captured_ms=2000;winner.vector={1,0};winner.fingerprint=std::string(64,'b');
  auto latest=earliest;latest.id="late";latest.captured_ms=3000;latest.vector={.5f,.5f};latest.fingerprint=std::string(64,'c');
  evidence_index.Upsert(earliest);evidence_index.Upsert(winner);evidence_index.Upsert(latest);
  auto grouped=evidence_index.Query({1,0},{{"allowed"},0,4000,20});
  Check(grouped.size()==1&&grouped[0].id=="winner"&&grouped[0].evidence_refs.size()==3);
  Check(grouped[0].evidence_refs[0].id=="winner"&&grouped[0].evidence_refs[1].id=="early"&&grouped[0].evidence_refs[2].id=="late");
  auto scoped=evidence_index.Query({1,0},{{"allowed"},1500,2500,20});Check(scoped[0].evidence_refs.size()==1);
  auto separate=latest;separate.id="other-processor";separate.processor="other";evidence_index.Upsert(separate);
  separate.id="scene";separate.scene=true;evidence_index.Upsert(separate);
  grouped=evidence_index.Query({1,0},{{"allowed"},0,4000,20});Check(grouped.size()==3);
  for(const auto& hit:grouped)if(hit.id=="scene")Check(hit.evidence_refs.size()==1&&hit.evidence_refs[0].id=="scene");
  std::cout << "vector index: identity, scope, grouping, limits and validation passed\n";
}
