// Query over published shards plus the Mongo tail, against a fake authority and real
// v2 shard files. No Mongo, no BPU.
#include "index_projection.hpp"
#include <sys/stat.h>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <random>

using namespace ainvr::search;
namespace fs = std::filesystem;
namespace {
int checks = 0;
void Check(bool ok, const char* what) { ++checks; if (!ok) throw std::runtime_error(what); }
constexpr int64_t kDay = 86400000;
const std::string kChannel = "22222222-2222-4222-8222-222222222222", kModel = "search-v1-" + std::string(64, 'a');
std::string Id(int n) { char b[37]; std::snprintf(b, sizeof b, "%08x-0000-4000-8000-%012x", n, n); return b; }
std::string Fp(int n) { std::string s(64, '0'); const auto t = std::to_string(n); s.replace(64 - t.size(), t.size(), t); return s; }
Sample Make(int n, int64_t at, std::vector<float> v, const std::string& track = "") {
  Sample s; s.record = {Id(n), kChannel, "processor", "session", track.empty() ? "track-" + std::to_string(n) : track, kModel, at, false, std::move(v), Fp(n)};
  s.fingerprint = s.record.fingerprint; return s;
}
// Ordinal-ordered authority with the Scan/ReadVisibleSamples contract of HistoryMongo.
struct FakeAuthority final : IndexAuthority {
  struct Row { Sample sample; int64_t ordinal; bool visible = true; };
  std::vector<Row> rows; int64_t next = 1; int scans = 0; std::set<std::pair<std::string, int64_t>> scanned_days;
  void Put(const Sample& s) override { rows.push_back({s, next++}); }
  std::string ReplaceTrackSlot(const Sample& s, size_t, const std::string&, const std::string&) override {
    for (auto& r : rows) if (r.sample.record.id == s.record.id) r.visible = false;
    rows.push_back({s, next++}); return s.fingerprint;
  }
  HistoryBatch Scan(const std::string& model, const Scope& scope, int64_t after, size_t limit) override {
    ++scans; scanned_days.insert({*scope.channels.begin(), IndexProjection::UtcDay(scope.from_ms)});
    HistoryBatch out; out.checkpoint = after; size_t visited = 0;
    for (const auto& r : rows) {
      if (r.ordinal <= after || !r.visible || r.sample.record.model != model || !scope.channels.count(r.sample.record.channel) ||
          r.sample.record.captured_ms < scope.from_ms || r.sample.record.captured_ms >= scope.to_ms) continue;
      if (visited == limit) return out;
      out.samples.push_back(r.sample); out.checkpoint = r.ordinal; ++visited;
    }
    out.exhausted = true; return out;
  }
  int visible_reads = 0;
  std::map<std::string, Sample> ReadVisibleSamples(const std::string& model, const Scope&, const std::vector<std::string>& ids) override {
    ++visible_reads; std::map<std::string, Sample> out;
    for (const auto& r : rows) if (r.visible && r.sample.record.model == model && std::count(ids.begin(), ids.end(), r.sample.record.id))
      out[r.sample.record.id] = r.sample;
    return out;
  }
  void Delete(const std::string& id) { for (auto& r : rows) if (r.sample.record.id == id) r.visible = false; }
  int64_t Checkpoint() const { return next - 1; }
};
struct Temp {
  fs::path base, root;
  Temp() { char name[] = "/tmp/ainvr-projection-XXXXXX"; base = mkdtemp(name); root = base / "index"; mkdir(root.c_str(), 0700); }
  ~Temp() { std::error_code e; fs::remove_all(base, e); }
};
std::vector<float> Unit(std::mt19937& rng, size_t n) {
  std::normal_distribution<float> d; std::vector<float> v(n); double s = 0;
  for (auto& x : v) { x = d(rng); s += double(x) * x; }
  for (auto& x : v) x = float(x / std::sqrt(s));
  return v;
}
// Publish `samples` as the shard of (kChannel, day) with `checkpoint`, and open it.
std::shared_ptr<const ShardView> Shard(IndexShardFiles& files, int64_t day, int64_t checkpoint, const std::vector<Sample>& samples,
                                       size_t dims, size_t views, uint64_t revision = 1) {
  char name[11]; const time_t t = time_t(day * 86400); std::strftime(name, sizeof name, "%Y-%m-%d", gmtime(&t));
  IndexShardIdentity id{"11111111-1111-4111-8111-" + std::string(12, char('0' + day % 10)), revision, kChannel, kModel, name, dims, checkpoint,
                        files.StorageGeneration(), views};
  std::vector<Record> records; for (const auto& s : samples) records.push_back(s.record);
  const auto publication = files.Publish(id, records);
  return files.Open(id, publication);
}
}  // namespace

int main() { try {
  std::mt19937 rng(11);
  const int64_t now = 20000 * kDay + 12 * 3600000, today = 20000, old_day = today - 5;
  const auto clock = [&] { return now; };
  {   // int8 quantization: coarse scores stay within 0.01 of exact cosine.
    std::vector<float> rec; for (int v = 0; v < 4; ++v) { auto u = Unit(rng, 768); rec.insert(rec.end(), u.begin(), u.end()); }
    std::vector<int8_t> q(rec.size()); float scales[4]; QuantizeViews(rec, 4, q.data(), scales);
    double worst = 0;
    for (int i = 0; i < 50; ++i) {
      const auto query = Unit(rng, 768); size_t a = 0, b = 0;
      const double exact = ExactBestView(rec, 4, query, &a), coarse = CoarseBestView(q.data(), scales, 4, 768, query.data(), &b);
      worst = std::max(worst, std::abs(exact - coarse));
    }
    Check(worst < 0.01, "int8 coarse score drifted from exact");
    auto a = Make(1, 0, {1, 0}), b = Make(2, 1, {0, 1}, "track-1"); a.record.track = "track-1";
    Check(RecordGroup(a.record) == RecordGroup(b.record), "one track is one group");
    b.record.scene = true; Check(RecordGroup(a.record) != RecordGroup(b.record), "a scene sample is its own group");
  }
  Temp tmp; auto files = IndexShardFiles::OpenForTesting(tmp.root);
  const size_t dims = 8, views = 2;
  // Two views of four dimensions. Every view must be non-zero (each is unit-normalized):
  // an empty view gets a component on axis 3, which no query below uses.
  const auto vec = [&](float x0, float x1, float y0, float y1) {
    std::vector<float> v(dims, 0.0f); v[0] = x0; v[1] = x1; v[4] = y0; v[5] = y1;
    if (x0 == 0 && x1 == 0) v[3] = 1;
    if (y0 == 0 && y1 == 0) v[7] = 1;
    return v; };
  {   // An old day: the shard answers, Mongo is not scanned, the score is exact after rescoring.
    FakeAuthority mongo; std::vector<Sample> rows;
    for (int n = 0; n < 30; ++n) { auto s = Make(100 + n, old_day * kDay + n * 1000, vec(std::cos(n * 0.1f), std::sin(n * 0.1f), 0, 1)); mongo.Put(s); rows.push_back(s); }
    IndexProjection projection(mongo, kModel, dims, views, clock);
    projection.Start({{kChannel}, 0, 1, 20});
    projection.Attach(Shard(*files, old_day, mongo.Checkpoint(), rows, dims, views));
    const Scope scope{{kChannel}, old_day * kDay, (old_day + 1) * kDay, 5};
    projection.MarkCatalogComplete();
    const auto result = projection.Query({1, 0, 0, 0}, scope);
    Check(!result.partial && result.items.size() == 5 && result.items[0].sample.record.id == Id(100), "shard query order");
    Check(std::abs(result.items[0].score - 1.0) < 1e-9 && std::abs(result.items[1].score - std::cos(0.1)) < 1e-6, "rescored exactly");
    Check(mongo.scans == 0, "an old day with a shard reads no Mongo tail");
    Check(result.items[0].sample.jpeg.empty() && result.items[0].evidence_refs[0].fingerprint == Fp(100), "evidence of the verified row");
    // A row deleted after the build never surfaces; the rest still fill the page.
    mongo.Delete(Id(100));
    const auto after_delete = projection.Query({1, 0, 0, 0}, scope);
    Check(after_delete.items.size() == 5 && after_delete.items[0].sample.record.id == Id(101) && !after_delete.partial, "deleted row hidden");
    // Mongo evicts old samples by its byte budget (.190: 700 of a day's 4029 left a
    // day later) without any new ordinal, so nothing rebuilds the shard. A row found
    // gone is skipped from then on, and the shard is offered for a rebuild once.
    Check(projection.TakeRebuildRequests().size() == 1, "evicted rows request a shard rebuild");
    Check(projection.TakeRebuildRequests().empty(), "one request per shard until it is rebuilt");
    for (int n = 1; n < 25; ++n) mongo.Delete(Id(100 + n));
    const auto evicted = projection.Query({1, 0, 0, 0}, scope);
    Check(evicted.items.size() == 5 && evicted.items[0].sample.record.id == Id(125) && !evicted.partial, "evicted rows dropped");
    const auto reads_before = mongo.visible_reads;
    const auto again = projection.Query({1, 0, 0, 0}, scope);
    Check(again.items.size() == 5 && mongo.visible_reads - reads_before <= 1 && projection.Status().at("dead_rows") == 25,
          "rows known to be gone are skipped, not re-read");
    // Detached (retired) shard: the catalog is complete, so the day comes from Mongo.
    projection.Detach(projection.Attached().begin()->first);
    const auto from_mongo = projection.Query({1, 0, 0, 0}, scope);
    Check(mongo.scans > 0 && from_mongo.items[0].sample.record.id == Id(125) && !from_mongo.partial &&
          projection.Status().at("dead_rows") == 0, "detached day read from Mongo");
  }
  {   // Startup: before the catalog was read, a day without a shard is unknown, not empty,
      // and is never read whole from Mongo per query.
    FakeAuthority mongo; mongo.Put(Make(200, old_day * kDay + 5, vec(1, 0, 0, 0)));
    IndexProjection projection(mongo, kModel, dims, views, clock); projection.Start({{kChannel}, 0, 1, 20});
    const auto unknown = projection.Query({1, 0, 0, 0}, {{kChannel}, old_day * kDay, (old_day + 1) * kDay, 20});
    Check(unknown.partial && unknown.items.empty() && mongo.scans == 0, "unknown day is partial and unread");
    IndexProjection never_started(mongo, kModel, dims, views, clock);
    bool rejected = false; try { never_started.Query({1, 0, 0, 0}, {{kChannel}, 0, kDay, 20}); } catch (const std::exception&) { rejected = true; }
    Check(rejected, "query before start");
    rejected = false; try { projection.Query({1, 0, 0, 0}, {{kChannel}, kDay, kDay, 20}); } catch (const std::exception&) { rejected = true; }
    Check(rejected, "invalid scope");
  }
  {   // Today: rows newer than the shard come from Mongo; a replaced slot shows its new
      // version at once, the shard's old row for that id is ignored, and one track stays
      // one group whose evidence spans both sides.
    FakeAuthority mongo; std::vector<Sample> built;
    auto slot = Make(300, today * kDay + 1000, vec(1, 0, 0, 0), "walker"); mongo.Put(slot); built.push_back(slot);
    auto other = Make(301, today * kDay + 2000, vec(0, 1, 0, 0)); mongo.Put(other); built.push_back(other);
    IndexProjection projection(mongo, kModel, dims, views, clock); projection.Rebuild({{kChannel}, 0, 1, 20});
    projection.Attach(Shard(*files, today, mongo.Checkpoint(), built, dims, views));
    auto replaced = slot; replaced.record.vector = vec(0, 0, 1, 0); replaced.record.captured_ms = today * kDay + 5000;
    replaced.record.fingerprint = replaced.fingerprint = Fp(9300);
    projection.ReplaceTrackSlot(replaced, 0, slot.fingerprint, "token");
    auto later = Make(302, today * kDay + 9000, vec(0, 0, 0.8f, 0.6f), "walker"); projection.Put(later);
    const Scope scope{{kChannel}, today * kDay, (today + 1) * kDay, 10};
    // The old slot row (view 0 = [1,0,0,0]) would score 1 if it were not overridden; the
    // replacement scores 1 on its second view, the later track member 0.8.
    const auto result = projection.Query({1, 0, 0, 0}, scope);
    Check(!result.partial && result.items.size() == 2, "track grouped across shard and tail");
    const auto& top = result.items[0];
    Check(top.sample.record.id == Id(300) && top.sample.fingerprint == Fp(9300) && std::abs(top.score - 1.0) < 1e-9 && top.view == 1,
          "replaced slot visible at once, old shard row ignored");
    Check(top.evidence_refs.size() == 2 && top.evidence_refs[1].id == Id(302), "group evidence spans shard and tail");
    Check(mongo.scanned_days.count({kChannel, today}) == 1, "today reads its tail");
  }
  {   // A day without a shard after the catalog was read is read from Mongo, capped.
    FakeAuthority mongo;
    for (int n = 0; n < int(IndexProjection::kTailBudget) + 100; ++n) mongo.Put(Make(1000 + n, old_day * kDay + n, vec(1, 0, 0, 0)));
    IndexProjection projection(mongo, kModel, dims, views, clock); projection.Rebuild({{kChannel}, 0, 1, 20});
    const auto capped = projection.Query({1, 0, 0, 0}, {{kChannel}, old_day * kDay, (old_day + 1) * kDay, 20});
    Check(capped.partial && capped.items.size() == 20, "capped Mongo tail is partial");
    FakeAuthority small; for (int n = 0; n < 65; ++n) small.Put(Make(5000 + n, old_day * kDay + n, vec(1, 0, 0, 0)));
    IndexProjection complete(small, kModel, dims, views, clock); complete.Rebuild({{kChannel}, 0, 1, 20});
    const auto all = complete.Query({1, 0, 0, 0}, {{kChannel}, old_day * kDay, (old_day + 1) * kDay, 100});
    Check(!all.partial && all.items.size() == 65, "a day without a shard read completely");
  }
  {   // Attach validates the shard against this space; status reports attached shards.
    FakeAuthority mongo; IndexProjection projection(mongo, kModel, dims, views, clock);
    bool rejected = false; try { projection.Attach(Shard(*files, old_day - 1, 0, {Make(7000, (old_day - 1) * kDay, std::vector<float>(4, 0.5f))}, 4, 1)); }
    catch (const std::exception&) { rejected = true; }
    Check(rejected, "shard of another space rejected");
    projection.Attach(Shard(*files, old_day - 2, 0, {Make(7001, (old_day - 2) * kDay, vec(1, 0, 0, 0))}, dims, views));
    Check(projection.Status().at("attached_shards") == 1 && projection.Status().at("attached_records") == 1, "status");
  }
  std::cout << checks << " index projection checks passed\n";
} catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; } }
