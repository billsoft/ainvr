#include "rank_refine.hpp"
#include "vector_index.hpp"
#include <cmath>
#include <cstdio>
#include <memory>
#include <string>
using namespace ainvr::search;
namespace {
struct Sample { Record record; };
struct Item { Sample sample; double score; std::shared_ptr<const Item> context{}; };
Item Make(const char* channel, const char* track, int64_t ms, bool scene, double score) {
  Item item; item.sample.record.id = std::string(channel) + "/" + track + "/" + std::to_string(ms); item.sample.record.channel = channel; item.sample.record.track = track; item.sample.record.captured_ms = ms;
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
  {   // scene samples and detector crops: ranked apart, fused by rank, a crop absorbs the nearest scene sample as context
    const std::vector<Item> scenes{Make("cam1", "", 10000, true, 0.14), Make("cam2", "", 50000, true, 0.13), Make("cam1", "", 90000, true, 0.12)};
    const std::vector<Item> crops{Make("cam1", "p1", 11000, false, 0.30), Make("cam3", "p2", 0, false, 0.20)};
    SceneObjectFusion fusion;
    auto fused = FuseSceneAndObjects(scenes, crops, fusion, 60);
    Check(fused.size() == 4, "one crop merged with its scene sample, the rest stand alone");
    Check(fused[0].sample.record.track == "p1" && fused[0].context && fused[0].context->sample.record.captured_ms == 10000,
          "the crop is the evidence, the scene sample 1 s away its context");
    Check(std::abs(fused[0].score - 1.0) < 1e-9, "first in both rankings scores 1");
    Check(!fused[1].context && fused[1].sample.record.track == "p2", "a crop without a nearby scene sample keeps its own rank share");
    for (const auto& item : fused) Check(!(item.sample.record.scene && item.sample.record.captured_ms == 10000), "a merged scene sample is not listed twice");
    fusion.merge_ms = 500;
    Check(FuseSceneAndObjects(scenes, crops, fusion, 60).size() == 5, "outside the merge window nothing merges");
    Check(FuseSceneAndObjects(scenes, std::vector<Item>{}, SceneObjectFusion{}, 2).size() == 2 &&
          FuseSceneAndObjects(std::vector<Item>{}, crops, SceneObjectFusion{}, 60).size() == 2, "one kind alone and the limit");
    const std::vector<Item> twice{Make("cam1", "p1", 11000, false, 0.30), Make("cam1", "p3", 10500, false, 0.25)};
    const auto nearest = FuseSceneAndObjects(std::vector<Item>{scenes[0]}, twice, SceneObjectFusion{}, 60);
    Check(nearest.size() == 2 && ((nearest[0].context != nullptr) + (nearest[1].context != nullptr)) == 1, "a scene sample gives context once");
    for (const auto& item : nearest) if (item.context) Check(item.sample.record.track == "p3", "the nearest crop in time takes the context");
  }
  {   // empty input and ties keep insertion order
    std::vector<Item> none; RefineRanking(none, RankRefineOptionsFor(2048)); Check(none.empty(), "empty input");
    std::vector<Item> ties{Make("a", "1", 0, false, 0.4), Make("b", "2", 0, false, 0.4)};
    RefineRanking(ties, plain); Check(ties.size() == 2 && ties[0].sample.record.channel == "a", "stable ties");
  }
  {   // picture and description rankings are fused by rank, not by raw score scales
    const std::vector<Item> picture{Make("a", "1", 0, false, 0.91), Make("b", "2", 0, false, 0.90), Make("c", "3", 0, false, 0.70)};
    const std::vector<Item> text{Make("c", "3", 0, false, 0.12), Make("d", "4", 0, false, 0.11)};
    auto balanced = FuseRankings(picture, text, 0.5, 60);
    Check(balanced.size() == 4, "union of both rankings");
    Check(balanced[0].sample.record.channel == "c", "a hit in both lists outranks a first place in one");
    Check(balanced[0].score > 0.5 && balanced[0].score <= 1.0, "fused score is scaled into (0, 1]");
    const std::vector<Item> other{Make("d", "4", 0, false, 0.12), Make("e", "5", 0, false, 0.11)};
    auto pictures = FuseRankings(picture, other, 0.8, 60);
    Check(pictures[0].sample.record.channel == "a" && pictures[1].sample.record.channel == "b", "a heavy picture share puts picture-only hits ahead");
    auto described = FuseRankings(picture, other, 0.2, 60);
    Check(described[0].sample.record.channel == "d", "a heavy description share puts description-only hits ahead");
    auto words = FuseRankings(picture, text, 0.2, 60);
    Check(words[0].sample.record.channel == "c" && words[1].sample.record.channel == "d", "a heavy description share follows the description");
    Check(FuseRankings(picture, text, 0.5, 2).size() == 2, "limit applies after fusion");
    const auto both = FuseRankings(std::vector<Item>{Make("a", "1", 0, false, 0.9)}, std::vector<Item>{Make("a", "1", 0, false, 0.1)}, 0.5, 60);
    Check(both.size() == 1 && both[0].score > 0.999 && both[0].score < 1.001, "first in both lists scores 1");
  }
  {
    auto picture = Make("c", "t", 1000, false, .99);
    auto text = Make("c", "t", 2000, false, .98);
    auto other = Make("c", "other", 1000, false, .70);
    auto result = FuseRankings(std::vector<Item>{picture, other}, std::vector<Item>{text, other}, .5, 60);
    Check(result.size() == 2 && result.front().sample.record.track == "t" && result.front().score == 1,
          "different best frames of one track receive combined support, without duplicate candidates");
    Check(result.front().sample.record.id == picture.sample.record.id, "representative frame remains stable");
    auto new_session = text; new_session.sample.record.session = "new-session";
    auto new_processor = text; new_processor.sample.record.processor = "new-processor";
    result = FuseRankings(std::vector<Item>{picture}, std::vector<Item>{new_session, new_processor}, .5, 60);
    Check(result.size() == 3, "same track number in different sessions/processors never fuses");
    std::vector<Item> separate{picture, new_session, new_processor};
    RefineRanking(separate, plain);
    Check(separate.size() == 3, "refinement also preserves session and processor boundaries");
    result = FuseRankings(std::vector<Item>{picture, text}, std::vector<Item>{text}, .5, 60);
    Check(result.size() == 1 && result.front().score == 1, "one contribution per modality even for repeated track samples");
    auto scene_a = Make("c", "", 1000, true, .99), scene_b = Make("c", "", 2000, true, .98);
    result = FuseRankings(std::vector<Item>{scene_a}, std::vector<Item>{scene_b}, .5, 60);
    Check(result.size() == 1 && result.front().score == 1, "nearby scene evidence also combines across modalities");
    scene_b.sample.record.captured_ms = 6001;
    Check(FuseRankings(std::vector<Item>{scene_a}, std::vector<Item>{scene_b}, .5, 60).size() == 2,
          "scene evidence outside the existing five-second window stays distinct");
  }
  if (!failures) std::puts("rank_refine ok");
  return failures ? 1 : 0;
}
