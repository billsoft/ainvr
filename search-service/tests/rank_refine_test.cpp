#include "rank_refine.hpp"
#include "vector_index.hpp"
#include <cstdio>
#include <string>
using namespace ainvr::search;
namespace {
struct Sample { Record record; };
struct Item { Sample sample; double score; };
Item Make(const char* channel, const char* track, int64_t ms, bool scene, double score) {
  Item item; item.sample.record.channel = channel; item.sample.record.track = track; item.sample.record.captured_ms = ms;
  item.sample.record.scene = scene; item.score = score; return item;
}
int failures = 0;
void Check(bool ok, const char* what) { if (!ok) { std::fprintf(stderr, "FAIL: %s\n", what); ++failures; } }
}  // namespace
int main() {
  RankRefineOptions plain; plain.relative_window = 0;
  {   // order is by score; near-duplicates of the same track collapse into the best one
    std::vector<Item> items{Make("c", "t1", 1000, false, 0.30), Make("c", "t1", 3000, false, 0.50), Make("c", "t1", 20000, false, 0.40)};
    RefineRanking(items, plain);
    Check(items.size() == 2 && items[0].score == 0.50 && items[1].score == 0.40, "same-track duplicates collapse, best kept, sorted");
  }
  {   // different track, different channel and scene-vs-object are not duplicates; scenes ignore the track id
    std::vector<Item> items{Make("c", "t1", 1000, false, 0.5), Make("c", "t2", 1000, false, 0.4), Make("d", "t1", 1000, false, 0.3),
                            Make("c", "", 1000, true, 0.2), Make("c", "x", 2000, true, 0.1)};
    RefineRanking(items, plain);
    Check(items.size() == 4, "distinct tracks/channels/kinds survive, the two scenes collapse");
  }
  {   // exactly at the duplicate distance still collapses, one millisecond more does not
    std::vector<Item> items{Make("c", "t", 0, false, 0.5), Make("c", "t", 5000, false, 0.4), Make("c", "t", 10001, false, 0.3)};
    RefineRanking(items, plain);
    Check(items.size() == 2, "5000 ms collapses, 5001 ms from the kept hit does not");
  }
  {   // relative window drops the weak tail only when enabled
    std::vector<Item> items{Make("a", "1", 0, false, 0.40), Make("b", "2", 0, false, 0.35), Make("c", "3", 0, false, 0.20)};
    auto windowed = items; RefineRanking(windowed, RankRefineOptionsFor(2048));
    Check(windowed.size() == 2, "2048-d keeps hits within 0.08 of the best");
    RefineRanking(items, RankRefineOptionsFor(768));
    Check(items.size() == 3, "768-d has no window");
  }
  {   // empty input and ties keep insertion order
    std::vector<Item> none; RefineRanking(none, RankRefineOptionsFor(2048)); Check(none.empty(), "empty input");
    std::vector<Item> ties{Make("a", "1", 0, false, 0.4), Make("b", "2", 0, false, 0.4)};
    RefineRanking(ties, plain); Check(ties.size() == 2 && ties[0].sample.record.channel == "a", "stable ties");
  }
  if (!failures) std::puts("rank_refine ok");
  return failures ? 1 : 0;
}
