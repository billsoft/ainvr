// Scene view layout and multi-view scoring. Pure software: no model, SDK, Mongo or hardware.
#include "vector_index.hpp"
#include <cmath>
#include <functional>
#include <iostream>
using namespace ainvr::search;
static void Check(bool good, const char* what) { if (!good) { std::cerr << "FAILED: " << what << "\n"; throw std::runtime_error("test_failed"); } }
static void Reject(const std::function<void()>& fn, const char* what) {
  bool rejected = false; try { fn(); } catch (const std::exception&) { rejected = true; }
  Check(rejected, what);
}
static bool Near(double a, double b) { return std::fabs(a - b) < 1e-6; }
static Record Scene(const std::string& id, std::vector<float> v) {
  return {id, "channel", "", "", "", "views-v1", 1000, true, std::move(v)};
}

int main() {
  // ---- geometry: landscape 16:9, 2:1, portrait, square
  { const auto v = PlanSceneViews(1920, 1080);
    Check(v[0].x == 0 && v[0].y == 0 && v[0].w == 1920 && v[0].h == 1080, "whole frame is view 0");
    Check(v[1].x == 0 && v[2].x == 420 && v[3].x == 840, "16:9 tiles start left, middle, right");
    for (int k = 1; k <= 3; ++k) Check(v[k].w == 1080 && v[k].h == 1080 && v[k].y == 0, "tile side is the short edge"); }
  { const auto v = PlanSceneViews(896, 448);
    Check(v[1].x == 0 && v[2].x == 224 && v[3].x == 448 && v[3].w == 448, "2:1 tiles"); }
  { const auto v = PlanSceneViews(1080, 1920);
    Check(v[1].y == 0 && v[2].y == 420 && v[3].y == 840 && v[1].x == 0 && v[1].w == 1080 && v[1].h == 1080, "portrait tiles are top, middle, bottom"); }
  { const auto v = PlanSceneViews(1000, 1000);
    for (int k = 1; k <= 3; ++k) Check(v[k].x == 0 && v[k].y == 0 && v[k].w == 1000, "a square frame has no travel"); }
  for (const auto& [w, h] : {std::pair{7680, 3840}, std::pair{4000, 3000}, std::pair{1281, 721}, std::pair{2, 9}}) {
    const auto v = PlanSceneViews(w, h);
    for (const auto& r : v) Check(r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h && r.w > 0 && r.h > 0, "every view lies inside the frame");
  }
  Reject([] { PlanSceneViews(0, 1080); }, "zero width");
  Reject([] { PlanSceneViews(1920, 1); }, "degenerate height");
  Reject([] { PlanSceneViews(70000, 1080); }, "oversized");

  // ---- scoring: a record is its best view; each block normalised on its own
  VectorIndex index("views-v1", 8, 10, 4);                       // 4 views of 2 floats
  index.Upsert(Scene("s1", {3, 0,   0, 5,   0, 0.5f,   0, 7}));  // whole=(1,0), tiles all (0,1) after normalising
  index.Upsert(Scene("s2", {0.6f, 0.8f,   1, 0,   1, 0,   1, 0}));
  const Scope scope{{"channel"}, 0, 5000, 20};
  auto hits = index.Query({0, 1}, scope);
  Check(hits.size() == 2 && hits[0].id == "s1" && Near(hits[0].score, 1.0) && hits[0].view == 1, "tile match wins, blocks normalised separately");
  hits = index.Query({1, 0}, scope);
  Check(hits.size() == 2 && hits[0].id == "s1" && hits[0].view == 0 && Near(hits[0].score, 1.0), "whole-frame view can win (tie broken by id)");
  Check(hits[1].id == "s2" && hits[1].view == 1 && Near(hits[1].score, 1.0), "the other sample matches through a tile");
  hits = index.Query({0.6f, 0.8f}, scope);
  Check(hits[0].id == "s2" && Near(hits[0].score, 1.0) && hits[0].view == 0, "exact whole-frame match is view 0");
  Check(hits[1].id == "s1" && Near(hits[1].score, 0.8) && hits[1].view == 1, "other sample scores its best tile (cos 0.8)");
  Reject([&] { index.Query({1, 0, 0, 0}, scope); }, "a query is one view block, not a record");
  Reject([&] { index.Upsert(Scene("short", {1, 0})); }, "a record must carry every view");
  Reject([&] { index.Upsert(Scene("zero", {0, 0, 1, 0, 1, 0, 1, 0})); }, "a zero block is invalid");
  index.Upsert(Scene("s1", {3, 0, 0, 5, 0, 0.5f, 0, 7}));       // idempotent re-upsert of identical content
  Check(index.Size() == 2, "re-upsert is idempotent");

  // ---- single view behaves exactly as before
  VectorIndex single("views-v1", 2, 4);
  single.Upsert(Scene("a", {1, 0})); single.Upsert(Scene("b", {0, 1}));
  hits = single.Query({1, 0}, scope);
  Check(hits[0].id == "a" && hits[0].view == 0 && Near(hits[0].score, 1.0), "views=1 unchanged");

  // ---- capacity: the float ceiling is per stored float, so four views cut the sample count by four
  Reject([] { VectorIndex bad("views-v1", 3072, 100000, 4); }, "100k samples of 3072 floats exceed the ceiling");
  VectorIndex fits("views-v1", 3072, 41000, 4); (void)fits;
  Reject([] { VectorIndex bad("views-v1", 770, 10, 4); }, "dimensions must divide into views");
  Reject([] { VectorIndex bad("views-v1", 3072, 10, 0); }, "zero views");
  std::cout << "scene views: layout, per-block normalisation, best-view scoring and capacity checks passed\n";
  return 0;
}
