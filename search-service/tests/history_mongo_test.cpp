#include "history_mongo.hpp"
#include "index_projection.hpp"
#include <mongoc/mongoc.h>
#include <atomic>
#include <cstdlib>
#include <chrono>
#include <functional>
#include <iostream>
#include <thread>
using namespace ainvr::search;
using Json = nlohmann::json;
int64_t Now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
void Check(bool good) { if (!good) throw std::runtime_error("history_test_failed"); }
void Reject(const std::function<void()>& f) { bool rejected = false; try { f(); } catch (const std::exception&) { rejected = true; } Check(rejected); }
const std::string channel = "00000000-0000-4000-8000-000000000001";
std::string Id(int n) { const auto tail = std::to_string(100000000000LL + n); return "00000000-0000-4000-8000-" + tail; }
Sample Make(int n, int64_t at) {
  return {{Id(n), channel, "processor", "session", "track" + std::to_string(n), "pair-v1", at, false, {0.5f, 0.25f}},
    {{"role", "match"}, {"input_path", "/live/input"}, {"output_path", "/live/output"}, {"source_input_id", channel}, {"output_channel_id", channel}, {"recording_channel_id", channel},
     {"schema_version", "1.0"}, {"stream_session_id", "session"}, {"source_pts_ns", std::to_string(at * 1000000LL)},
     {"source_frame_index", std::to_string(n)}, {"frame_id", Id(n)}, {"frame_width", 1920}, {"frame_height", 1080}},
    {255, 216, 255, 217}, at + 60000};
}
void Command(mongoc_client_t* client, const std::string& database, const nlohmann::ordered_json& json) {
  const auto text = json.dump(); bson_error_t error{};
  bson_t* input = bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()), text.size(), &error);
  Check(input != nullptr); bson_t reply;
  const bool ok = mongoc_client_command_simple(client, database.c_str(), input, nullptr, &reply, &error);
  bson_destroy(input); bson_destroy(&reply); Check(ok);
}
void TrackSlots(const std::string& uri, const std::string& database, int64_t at, mongoc_client_t* client) {
  HistoryBudget budget; budget.max_samples = 8; budget.max_bytes = 1024 * 1024;
  auto history = std::make_unique<HistoryMongo>(uri, database, budget); history->Initialize();
  auto sample = Make(100, at); sample.record.track = "bounded-object"; sample.record.vector = {1, 0};
  const auto make = [&](int frame, int64_t time) {
    auto value = sample;
    value.record.captured_ms = time; value.expires_ms = at + 60000;
    value.evidence["frame_id"] = Id(frame);
    value.evidence["source_frame_index"] = std::to_string(frame);
    value.evidence["source_pts_ns"] = std::to_string(time * 1000000LL);
    return value;
  };
  auto first = make(100, at);
  auto fingerprint = history->ReplaceTrackSlot(first, 0, "", "first");
  Check(fingerprint.size() == 64 && history->ReplaceTrackSlot(first, 0, "", "first") == fingerprint);
  Check(history->Get(first.record.id)->track_slot == 0 && history->Get(first.record.id)->record.fingerprint == fingerprint);
  for (size_t slot = 1; slot < 8; ++slot) {
    auto value = make(100 + slot, at + slot); value.record.id = Id(100 + slot); value.record.vector = {-1, 0};
    history->ReplaceTrackSlot(value, slot, "", "fill-" + std::to_string(slot));
  }
  Check(history->Usage().at("samples") == 8);
  auto ninth = make(109, at + 9); ninth.record.id = Id(109);
  Reject([&] { history->ReplaceTrackSlot(ninth, 8, "", "ninth"); });
  Reject([&] { history->ReplaceTrackSlot(ninth, 0, "", "duplicate-slot"); });
  Reject([&] { history->Put(ninth); }); // Ordinary Put cannot bypass the per-track bound.
  auto bad = make(110, at + 10);
  Reject([&] { history->ReplaceTrackSlot(bad, 0, "", "unexpected-create"); });
  Reject([&] { history->ReplaceTrackSlot(bad, 0, std::string(64, '0'), "stale"); });
  Reject([&] { history->ReplaceTrackSlot(bad, 0, fingerprint, "first"); }); // Same token, changed body.
  Reject([&] { history->Put(bad); }); // Existing Put stays immutable.
  bad = make(100, at + 10);
  Reject([&] { history->ReplaceTrackSlot(bad, 0, fingerprint, "same-frame"); });
  bad = make(110, at);
  Reject([&] { history->ReplaceTrackSlot(bad, 0, fingerprint, "same-pts"); });
  bad = make(110, at + 10); bad.evidence["source_frame_index"] = "99";
  Reject([&] { history->ReplaceTrackSlot(bad, 0, fingerprint, "old-index"); });
  for (const auto* field : {"processor", "session", "track", "model", "channel"}) {
    bad = make(110, at + 10);
    if (std::string(field) == "processor") bad.record.processor = "another";
    if (std::string(field) == "session") { bad.record.session = "another"; bad.evidence["stream_session_id"] = "another"; }
    if (std::string(field) == "track") bad.record.track = "another";
    if (std::string(field) == "model") bad.record.model = "another";
    if (std::string(field) == "channel") bad.record.channel = Id(999);
    Reject([&] { history->ReplaceTrackSlot(bad, 0, fingerprint, "identity"); });
  }
  for (const auto* field : {"source_input_id", "output_channel_id", "recording_channel_id", "input_path", "output_path"}) {
    bad = make(110, at + 10); bad.evidence[field] = Id(999);
    Reject([&] { history->ReplaceTrackSlot(bad, 0, fingerprint, "source-identity"); });
  }
  Scope scope{{channel}, at - 1, at + 2000, 20};
  const auto checkpoint = history->Scan("pair-v1", scope, 0, 20).checkpoint;
  auto last = first; std::string token;
  for (int n = 0; n < 128; ++n) {
    last = make(1000 + n, at + 10 + n); token = "replace-" + std::to_string(n);
    const auto expected = fingerprint;
    fingerprint = history->ReplaceTrackSlot(last, 0, expected, token);
    Check(history->ReplaceTrackSlot(last, 0, expected, token) == fingerprint);
  }
  Check(history->Usage().at("samples") == 8);
  // Distinct HistoryMongo instances still use a Mongo compare-and-swap, rather
  // than depending on the caller's mutex for competing generation updates.
  HistoryMongo second_writer(uri, database, budget); second_writer.Initialize();
  auto race_a = make(1500, at + 200), race_b = make(1501, at + 201);
  const auto race_expected = fingerprint; std::string race_results[2];
  std::thread race_first([&] { try { race_results[0] = history->ReplaceTrackSlot(race_a, 0, race_expected, "race-a"); } catch (...) {} });
  std::thread race_second([&] { try { race_results[1] = second_writer.ReplaceTrackSlot(race_b, 0, race_expected, "race-b"); } catch (...) {} });
  race_first.join(); race_second.join();
  Check((race_results[0].empty() ? 0 : 1) + (race_results[1].empty() ? 0 : 1) == 1);
  last = *history->Get(sample.record.id); fingerprint = last.fingerprint;
  token = race_results[0].empty() ? "race-b" : "race-a";
  Check(history->Usage().at("samples") == 8);
  auto delta = history->Scan("pair-v1", scope, checkpoint, 20);
  Check(delta.samples.size() == 1 && delta.samples[0].record.id == sample.record.id && delta.samples[0].fingerprint == fingerprint);
  history.reset(); history = std::make_unique<HistoryMongo>(uri, database, budget); history->Initialize();
  Check(history->ReplaceTrackSlot(last, 0, fingerprint, token) == fingerprint); // Retry survives process restart.
  Reject([&] { history->ReplaceTrackSlot(first, 0, "", "first"); });
  IndexProjection projection(*history, "pair-v1", 2, 8); projection.Rebuild(scope);
  const auto ranked = projection.Query({1, 0}, scope);
  Check(ranked.items.size() == 1 && ranked.items[0].sample.record.id == sample.record.id && ranked.items[0].score == 1);
  SearchSessionRequest request{Id(3000), "slot-operator", "person", "pair-v1", scope, false, Now() + 60000};
  const auto version = history->BeginSearch(request);
  history->PublishSearch(request.id, request.actor, version, {{sample.record.id, 1, fingerprint}}, "sampled");
  auto next = make(2000, at + 1000); next.record.vector = {0, 1};
  const auto next_fingerprint = history->ReplaceTrackSlot(next, 0, fingerprint, "crash-after-mongo");
  // Simulate a crash between the Mongo commit and projection update.
  const auto stale = projection.Query({1, 0}, scope);
  Check(stale.partial);
  for (const auto& row : stale.items) Check(row.sample.record.id != sample.record.id);
  const auto frozen = history->ReadSearch(request.id, request.actor);
  Check(frozen && frozen->coverage == "partial" && frozen->items.empty());
  Check(!history->SearchImage(request.id, request.actor, sample.record.id, last.evidence.at("frame_id")));
  Check(!history->SearchFeedback(request.id, request.actor, sample.record.id, true));
  request.id = Id(3001); const auto raced_version = history->BeginSearch(request);
  history->PublishSearch(request.id, request.actor, raced_version, {{sample.record.id, 1, fingerprint}}, "sampled");
  Check(history->ReadSearch(request.id, request.actor)->coverage == "partial" && history->ReadSearch(request.id, request.actor)->items.empty());
  request.id = Id(3002); const auto unbound_version = history->BeginSearch(request);
  history->PublishSearch(request.id, request.actor, unbound_version, {{sample.record.id, 1}}, "sampled");
  Check(history->ReadSearch(request.id, request.actor)->coverage == "partial" && history->ReadSearch(request.id, request.actor)->items.empty());
  projection.Rebuild(scope);
  Check(projection.Query({1, 0}, scope).items[0].score == 0);
  next = make(2001, at + 1001);
  fingerprint = projection.ReplaceTrackSlot(next, 0, next_fingerprint, "projection-replace");
  const auto updated = projection.Query({1, 0}, scope);
  Check(!updated.partial && updated.items[0].score == 1 && updated.items[0].sample.fingerprint == fingerprint);
  history->DeleteRange(channel, at + 1001, at + 1002);
  Reject([&] { history->ReplaceTrackSlot(next, 0, next_fingerprint, "projection-replace"); });
  auto replay = make(2002, at + 1002);
  Reject([&] { history->ReplaceTrackSlot(replay, 0, fingerprint, "deleted-generation"); });
  Check(!history->Get(sample.record.id));
  // Uniqueness is enforced by Mongo itself before all eight slots fill.
  HistoryMongo unique(uri, database + "_unique", budget); unique.Initialize();
  auto other = make(4000, at + 1100); other.record.id = Id(4000); other.record.track = "other-object";
  unique.ReplaceTrackSlot(other, 0, "", "other-first");
  other.record.id = Id(4001);
  Reject([&] { unique.ReplaceTrackSlot(other, 0, "", "other-duplicate"); });
  Check(unique.Usage().at("samples") == 1);
  const auto before_intent = unique.Get(Id(4000));
  Command(client, database + "_unique", {{"insert", "search_deletions"}, {"documents", Json::array({
    {{"_id", "slot-intent-before-crash"}, {"channel", channel}, {"from", at + 1100}, {"to", at + 1101},
      {"expires_at", {{"$date", {{"$numberLong", std::to_string(at + 30LL * 86400000)}}}}}}
  })}});
  auto resurrect = make(5000, at + 1200); resurrect.record.id = Id(4000); resurrect.record.track = "other-object";
  Reject([&] { unique.ReplaceTrackSlot(resurrect, 0, before_intent->fingerprint, "resurrect-deleted-slot"); });
  Check(!unique.Get(Id(4000)));
  // Expired evidence must not gain a fresh lease by replaying its old CAS.
  auto expiring = make(6000, at + 1300); expiring.record.id = Id(6000); expiring.record.track = "expiring-object";
  expiring.expires_ms = Now() + 100;
  const auto expiring_fingerprint = unique.ReplaceTrackSlot(expiring, 0, "", "expiring");
  std::this_thread::sleep_for(std::chrono::milliseconds(120));
  auto expired_next = make(6001, at + 1301); expired_next.record.id = Id(6000); expired_next.record.track = "expiring-object";
  Reject([&] { unique.ReplaceTrackSlot(expired_next, 0, expiring_fingerprint, "expired-replacement"); });
  Check(!unique.Get(Id(6000)));

}
int main() {
  if (!std::getenv("AINVR_SEARCH_TEST_MONGO")) { std::cout << "SKIP: isolated Mongo fixture not requested\n"; return 77; }
  const std::string uri = "mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=2000";
  const std::string database = "ainvr_search_test_" + std::to_string(Now());
  mongoc_init();
  std::unique_ptr<mongoc_client_t, decltype(&mongoc_client_destroy)> client(mongoc_client_new(uri.c_str()), mongoc_client_destroy);
  std::vector<std::string> databases = {database, database + "_quota", database + "_capped", database + "_slots", database + "_slots_unique", database + "-long"};
  const auto cleanup = [&] { for (const auto& name : databases) Command(client.get(), name, {{"dropDatabase", 1}}); };
  try {
    auto history = std::make_unique<HistoryMongo>(uri, database); history->Initialize();
    const auto at = Now() - 1000; const auto first = Make(9, at);
    HistoryBudget longest; longest.retention_ms = 365LL * 86400000;
    HistoryMongo annual(uri, database + "-long", longest); annual.Initialize();
    auto annual_sample = Make(8000, at); annual_sample.expires_ms = at + longest.retention_ms;
    annual.Put(annual_sample);
    Check(annual.Get(annual_sample.record.id)->expires_ms == annual_sample.expires_ms);
    longest.retention_ms = 366LL * 86400000;
    Reject([&] { HistoryMongo invalid(uri, database, longest); });
    for (const auto* invalid_name : {"", "bad.db", "bad$db", "bad db"})
      Reject([&] { HistoryMongo invalid(uri, invalid_name); });
    history->Put(first);
    std::atomic<bool> failed{false}; std::vector<std::thread> retries;
    for (int i = 0; i < 4; ++i) retries.emplace_back([&] { try { history->Put(first); } catch (...) { failed = true; } });
    for (auto& thread : retries) thread.join();
    Check(!failed && history->Usage().at("samples") == 1);
    const auto saved = history->Get(first.record.id);
    Check(saved && saved->jpeg == first.jpeg && saved->record.vector == first.record.vector && saved->evidence == first.evidence);
    auto changed = first; changed.record.vector[0] = 0.1f; Reject([&] { history->Put(changed); });
    auto bad = Make(3, at); bad.record.vector = {0, 0}; Reject([&] { history->Put(bad); });
    bad = Make(3, at); bad.evidence.erase("source_input_id"); Reject([&] { history->Put(bad); });
    bad = Make(3, at); bad.evidence["frame_width"] = 1920.5; Reject([&] { history->Put(bad); });
    bad = Make(3, at); bad.evidence["stream_session_id"] = "other-session"; Reject([&] { history->Put(bad); });
    bad = Make(3, at); bad.evidence["source_pts_ns"] = "18446744073709551615"; Reject([&] { history->Put(bad); });
    bad = Make(3, at); bad.evidence.erase("recording_channel_id"); Reject([&] { history->Put(bad); });
    bad = Make(3, at); bad.jpeg = {1, 2, 3, 4}; Reject([&] { history->Put(bad); });
    bad = Make(3, at); bad.expires_ms = Now() - 1; Reject([&] { history->Put(bad); });
    bad = Make(3, Now() + 30000); bad.expires_ms = bad.record.captured_ms - 1;
    Reject([&] { history->Put(bad); }); // Clock skew cannot make retention end before capture.
    history->Put(Make(1, at)); // Lexically earlier ID, but a later append ordinal.
    Scope scope{{channel}, at - 1, at + 1, 20};
    auto one = history->Scan("pair-v1", scope, 0, 1);
    Check(one.samples.size() == 1 && one.samples[0].record.id == first.record.id && one.samples[0].jpeg.empty());
    auto two = history->Scan("pair-v1", scope, one.checkpoint, 1);
    Check(two.samples.size() == 1 && two.samples[0].record.id == Id(1));
    Check(history->Scan("another-model", scope, 0, 10).samples.empty());
    Scope denied{{Id(999)}, at - 1, at + 1, 20}; Check(history->Scan("pair-v1", denied, 0, 10).samples.empty());
    history.reset(); history = std::make_unique<HistoryMongo>(uri, database); history->Initialize();
    VectorIndex rebuilt("pair-v1", 2, 8);
    for (const auto& row : history->Scan("pair-v1", scope, 0, 10).samples) rebuilt.Upsert(row.record);
    Check(rebuilt.Query({1, 0}, scope).size() == 2);
    IndexProjection projection(*history, "pair-v1", 2, 8);
    Reject([&] { projection.Query({1, 0}, scope); });
    projection.Rebuild(scope);
    Check(projection.Query({1, 0}, scope).items.size() == 2);
    Check(projection.Query({1, 0}, scope).items[0].sample.jpeg.empty());
    Check(std::abs(projection.Query({1, 0}, scope).items[0].score - 0.89442719) < 1e-6);
    Scope invalid = scope; invalid.limit = 0; Reject([&] { projection.Query({1, 0}, invalid); });
    IndexProjection small(*history, "pair-v1", 2, 1);
    small.Rebuild(denied);
    Reject([&] { small.Rebuild(scope); });
    Check(small.Query({1, 0}, denied).items.empty()); // Failed rebuild kept prior usable state.
    Scope wider = scope; wider.from_ms -= 100;
    Check(projection.Query({1, 0}, wider).partial);
    history->PutCoverage(Id(40), "pair-v1", channel, at - 1, at + 1, false, "pending", at + 60000);
    history->PutCoverage(Id(40), "pair-v1", channel, at - 1, at + 1, false, "sampled", at + 60000);
    history->PutCoverage(Id(40), "pair-v1", channel, at - 1, at + 1, false, "pending", at + 60000);
    Check(history->Coverage("pair-v1", scope)[0].at("state") == "sampled");
    Reject([&] { history->PutCoverage(Id(40), "pair-v1", channel, at - 2, at + 1, false, "gap", at + 60000); });
    Command(client.get(), database, {{"update", "search_samples"}, {"updates", Json::array({
      {{"q", {{"_id", Id(1)}}}, {"u", {{"$set", {{"jpeg_sha", "corrupt"}}}}}}
    })}});
    Reject([&] { history->Get(Id(1)); });
    // Simulate a crash after the deletion intent commits but before cleanup.
    Command(client.get(), database, {{"insert", "search_deletions"}, {"documents", Json::array({
      {{"_id", "intent-before-crash"}, {"channel", channel}, {"from", at - 1}, {"to", at + 1},
       {"expires_at", {{"$date", {{"$numberLong", std::to_string(at + 30LL * 86400000)}}}}}}
    })}});
    Check(!history->Get(first.record.id));
    Check(history->Scan("pair-v1", scope, 0, 10).samples.empty());
    Check(history->Coverage("pair-v1", scope).empty());
    history->DeleteRange(channel, at - 1, at + 1);
    Check(!history->Get(first.record.id) && history->Scan("pair-v1", scope, 0, 10).samples.empty());
    Check(history->Coverage("pair-v1", scope).empty());
    Check(projection.Query({1, 0}, scope).items.empty());
    Reject([&] { history->PutCoverage(Id(41), "pair-v1", channel, at - 1, at + 1, false, "sampled", at + 60000); });
    Reject([&] { history->Put(first); });
    history.reset(); history = std::make_unique<HistoryMongo>(uri, database); history->Initialize();
    Reject([&] { history->Put(first); });
    auto later = Make(20, at + 10); history->Put(later);
    Check(history->Usage().at("samples") == 1);
    Command(client.get(), database, {{"update", "search_samples"}, {"updates", Json::array({
      {{"q", {{"_id", later.record.id}}}, {"u", {{"$set", {{"expires_at", {{"$date", {{"$numberLong", std::to_string(at - 100)}}}}}}}}}}
    })}});
    Check(!history->Get(later.record.id)); history->Put(Make(21, at + 10)); Check(history->Usage().at("samples") == 1);
    HistoryBudget budget; budget.max_samples = 1; budget.max_bytes = 8192; budget.max_coverage = 1;
    HistoryMongo limited(uri, database + "_quota", budget); limited.Initialize(); limited.Put(Make(1, at));
    Reject([&] { limited.Put(Make(2, at)); });
    limited.PutCoverage(Id(1), "pair-v1", channel, at - 1, at + 1, false, "gap", at + 60000);
    Reject([&] { limited.PutCoverage(Id(2), "pair-v1", channel, at - 1, at + 1, true, "pending", at + 60000); });
    Command(client.get(), database + "_capped", {{"create", "search_samples"}, {"capped", true}, {"size", 4096}});
    HistoryMongo capped(uri, database + "_capped"); Reject([&] { capped.Initialize(); });
    TrackSlots(uri, database + "_slots", at, client.get());
    cleanup(); std::cout << "history: durability, replay, scope, integrity, deletion, coverage and quotas passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; try { cleanup(); } catch (...) {} return 1;
  }
}
