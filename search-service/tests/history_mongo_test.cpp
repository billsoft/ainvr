#include "history_mongo.hpp"
#include "index_projection.hpp"
#include "display_bbox.hpp"
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
void Check(bool good, int line = __builtin_LINE()) { if (!good) throw std::runtime_error("history_test_failed_at_" + std::to_string(line)); }
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
TrackSlotReceipt Receipt(HistoryMongo& history, Sample sample, size_t slot,
    const std::string& token, const std::string& fingerprint) {
  sample.record.vector.clear(); sample.jpeg.clear();
  return history.ReadTrackSlotReceipt(sample, slot, token, fingerprint);
}
void Command(mongoc_client_t* client, const std::string& database, const nlohmann::ordered_json& json) {
  const auto text = json.dump(); bson_error_t error{};
  bson_t* input = bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()), text.size(), &error);
  Check(input != nullptr); bson_t reply;
  const bool ok = mongoc_client_command_simple(client, database.c_str(), input, nullptr, &reply, &error);
  bson_destroy(input); bson_destroy(&reply); Check(ok);
}
void TrackSlots(const std::string& uri, const std::string& database, int64_t at, mongoc_client_t* client) {
  // Independent Python hashlib/json/struct('<2f') oracle; extraction must not
  // change fingerprints of existing stored generations.
  Check(ComputeSampleContractDigest(Make(42, 1790000000000LL)).fingerprint ==
    "464e6dc6586e627ca0439178ea6a9474c636cd437df0a6f00e52b64809744ff7");
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
  using RS = TrackSlotReceiptState;
  Check(ComputeSampleContractDigest(first).fingerprint == fingerprint);
  Check(Receipt(*history, first, 0, "first", fingerprint).state == RS::Committed);
  Check(Receipt(*history, first, 0, "first", fingerprint).fingerprint == fingerprint);
  const auto without_binary = Receipt(*history, first, 1, "first", fingerprint);
  Check(without_binary.state == RS::ScopeMismatch && without_binary.fingerprint.empty());
  auto different = first; different.record.processor = "other-processor";
  Check(Receipt(*history, different, 0, "first", fingerprint).state == RS::ScopeMismatch);
  for (const auto* field : {"source_input_id", "recording_channel_id", "input_path", "output_path"}) {
    different = first; different.evidence[field] = std::string(field).find("path") != std::string::npos ? "/live/other" : Id(9999);
    const auto receipt = Receipt(*history, different, 0, "first", fingerprint);
    Check(receipt.state == RS::ScopeMismatch && receipt.fingerprint.empty());
  }
  different = first; different.evidence["frame_id"] = Id(9999);
  Check(Receipt(*history, different, 0, "first", fingerprint).state == RS::WriteMismatch);
  Check(Receipt(*history, first, 0, "first", std::string(64,'0')).state == RS::WriteMismatch);
  Check(Receipt(*history, first, 0, "other-write", fingerprint).state == RS::Replaced);
  different = first; different.jpeg.insert(different.jpeg.begin() + 2, 0);
  Check(ComputeSampleContractDigest(different).fingerprint != fingerprint);
  different = first; different.record.vector[0] = .75f;
  Check(ComputeSampleContractDigest(different).fingerprint != fingerprint);
  different = first; different.evidence["input_spec_version"] = "changed";
  Check(ComputeSampleContractDigest(different).fingerprint != fingerprint);
  Reject([&] { Receipt(*history, first, 0, "first", "bad-digest"); });
  different = first; different.record.id = Id(9999);
  Check(Receipt(*history, different, 0, "first", fingerprint).state == RS::NotFound);
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
  const auto replaced_receipt = Receipt(*history, last, 0, token, fingerprint);
  Check(replaced_receipt.state == RS::Replaced && replaced_receipt.fingerprint.empty());
  Check(Receipt(*history, next, 0, "crash-after-mongo", next_fingerprint).state == RS::Committed);
  // Simulate a crash between the Mongo commit and projection update.
  const auto stale = projection.Query({1, 0}, scope);
  // The bounded recovery scan sees the authority replacement ordinal and
  // certifies this fully loaded small scope, without pairing an old score.
  Check(!stale.partial);
  for (const auto& row : stale.items)
    if (row.sample.record.id == sample.record.id) Check(row.sample.fingerprint == next_fingerprint && row.score == 0);
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
  Check(Receipt(*history, next, 0, "projection-replace", fingerprint).state == RS::Deleted);
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
  Check(Receipt(unique, *before_intent, 0, "other-first", before_intent->fingerprint).state == RS::Deleted);
  // Expired evidence must not gain a fresh lease by replaying its old CAS.
  auto expiring = make(6000, at + 1300); expiring.record.id = Id(6000); expiring.record.track = "expiring-object";
  expiring.expires_ms = Now() + 100;
  const auto expiring_fingerprint = unique.ReplaceTrackSlot(expiring, 0, "", "expiring");
  std::this_thread::sleep_for(std::chrono::milliseconds(120));
  auto expired_next = make(6001, at + 1301); expired_next.record.id = Id(6000); expired_next.record.track = "expiring-object";
  Reject([&] { unique.ReplaceTrackSlot(expired_next, 0, expiring_fingerprint, "expired-replacement"); });
  Check(!unique.Get(Id(6000)));
  const auto expired_receipt = Receipt(unique, expiring, 0, "expiring", expiring_fingerprint);
  Check(expired_receipt.state == RS::Expired && expired_receipt.fingerprint.empty());
  Command(client, database + "_unique", {{"delete", "search_samples"}, {"deletes", Json::array({{{"q", {{"_id", Id(6000)}}}, {"limit", 1}}})}});
  Check(Receipt(unique, expiring, 0, "expiring", expiring_fingerprint).state == RS::Expired);

}
void SceneReceipts(const std::string& uri, const std::string& database, int64_t at) {
  using RS = TrackSlotReceiptState;
  HistoryMongo history(uri, database); history.Initialize();
  auto scene = Make(7000, at); scene.record.scene = true; scene.record.track.clear();
  scene.evidence["input_spec_version"] = "siglip2-squash-area";
  const auto fingerprint = ComputeSampleContractDigest(scene).fingerprint;
  history.Put(scene);
  auto metadata = scene; metadata.jpeg.clear(); metadata.record.vector.clear();
  Check(history.ReadSceneReceipt(metadata, fingerprint).state == RS::Committed);
  Check(history.ReadSceneReceipt(metadata, fingerprint).fingerprint == fingerprint);
  auto wrong = metadata; wrong.record.id = Id(7001);
  Check(history.ReadSceneReceipt(wrong, fingerprint).state == RS::NotFound);
  wrong = metadata; wrong.record.processor = "other";
  const auto mismatch = history.ReadSceneReceipt(wrong, fingerprint);
  Check(mismatch.state == RS::ScopeMismatch && mismatch.fingerprint.empty());
  wrong = metadata; wrong.evidence["input_spec_version"] = "wrong";
  Check(history.ReadSceneReceipt(wrong, fingerprint).state == RS::WriteMismatch);
  wrong = metadata; wrong.evidence["frame_id"] = Id(7999);
  Check(history.ReadSceneReceipt(wrong, fingerprint).state == RS::WriteMismatch);
  Check(history.ReadSceneReceipt(metadata, std::string(64, '0')).state == RS::WriteMismatch);
  Reject([&] { history.ReadSceneReceipt(scene, fingerprint); }); // never accept binary receipt bodies
  wrong = metadata; wrong.record.vector = {1, 0};
  Reject([&] { history.ReadSceneReceipt(wrong, fingerprint); });
  wrong = metadata; wrong.record.scene = false;
  Reject([&] { history.ReadSceneReceipt(wrong, fingerprint); });
  wrong = metadata; wrong.track_slot = 0;
  Reject([&] { history.ReadSceneReceipt(wrong, fingerprint); });
  history.DeleteRange(channel, at-1, at+1);
  Check(history.ReadSceneReceipt(metadata, fingerprint).state == RS::Deleted);
  wrong = metadata; wrong.record.id = Id(7002); wrong.record.captured_ms = at-10000;
  wrong.expires_ms = at-9000;
  Check(history.ReadSceneReceipt(wrong, fingerprint).state == RS::Expired);
  Reject([&] { history.Put(scene); }); // receipt never revives a deleted generation
}
void ProjectionMaintenance(const std::string& uri, const std::string& database, int64_t at, mongoc_client_t* client) {
  HistoryBudget budget; budget.max_samples = 128;
  HistoryMongo history(uri, database, budget); history.Initialize();
  history.Put(Make(9001, at)); history.Put(Make(9002, at));
  IndexProjection projection(history, "pair-v1", 2, 2);
  projection.Rebuild({{channel}, at - 1, at + 1, 20});
  auto next = Make(9003, at + 1000);
  projection.Put(next); // Mongo succeeds although the cache still has 2 live rows.
  Check(bool(history.Get(next.record.id)) && history.Usage().at("samples") == 3);
  projection.Put(next); // A replay stays idempotent; cache pressure is not failure.
  Check(history.Usage().at("samples") == 3);
  Scope current{{channel}, at + 999, at + 1001, 20};
  const auto limited = projection.Query({1, 0}, current);
  Check(!limited.partial && limited.items.size() == 1 && limited.items[0].sample.record.id == next.record.id);
  // Even valid old rows cannot pin the whole cache against a new scope.
  // Alternating scopes changes only the bounded working set, not Mongo facts.
  for (int n = 0; n < 4; ++n) {
    auto old = projection.Query({1, 0}, {{channel}, at - 1, at + 1, 20});
    if (old.items.size() < 2) old = projection.Query({1, 0}, {{channel}, at - 1, at + 1, 20});
    Check(!old.partial && old.items.size() == 2);
    const auto recent = projection.Query({1, 0}, current);
    Check(!recent.partial && recent.items.size() == 1 && recent.items[0].sample.record.id == next.record.id);
  }
  Check(history.Get(Id(9001)) && history.Get(Id(9002)) && history.Get(next.record.id));
  Scope invalid = current; invalid.to_ms = invalid.from_ms;
  Reject([&] { projection.Query({1, 0}, invalid); });
  // Deletion happens in a scope nobody queries again. A global sweep releases
  // both old cache slots and one bounded Mongo page recovers the ACKed sample.
  history.DeleteRange(channel, at - 1, at + 1);
  const auto recovered = projection.Query({1, 0}, current);
  Check(!recovered.partial && recovered.items.size() == 1 && recovered.items[0].sample.record.id == next.record.id);
  auto visible = history.ReadVisibleFingerprints("pair-v1", {Id(9001), Id(9002), next.record.id});
  Check(visible.size() == 1 && visible.at(next.record.id) == history.Get(next.record.id)->fingerprint);
  Check(history.ReadVisibleFingerprints("other-model", {next.record.id}).empty());
  Reject([&] { history.ReadVisibleFingerprints("pair-v1", {next.record.id, next.record.id}); });
  Reject([&] { history.ReadVisibleFingerprints("pair-v1", {"not-an-id"}); });
  std::vector<std::string> batch;
  for (int n = 0; n < 64; ++n) batch.push_back(Id(9500 + n));
  Check(history.ReadVisibleFingerprints("pair-v1", batch).empty());
  batch.push_back(Id(9564)); Reject([&] { history.ReadVisibleFingerprints("pair-v1", batch); });

  HistoryMongo ttl(uri, database + "_ttl", budget); ttl.Initialize();
  ttl.Put(Make(9101, at)); ttl.Put(Make(9102, at));
  IndexProjection expiring(ttl, "pair-v1", 2, 2); expiring.Rebuild({{channel}, at - 1, at + 1, 20});
  Command(client, database + "_ttl", {{"update", "search_samples"}, {"updates", Json::array({
    {{"q", {{"_id", {{"$in", {Id(9101), Id(9102)}}}}}}, {"u", {{"$set", {{"expires_at", {{"$date", {{"$numberLong", std::to_string(at - 1)}}}}}}}}}, {"multi", true}}
  })}});
  auto fresh = Make(9103, at + 1000); expiring.Put(fresh);
  const auto fresh_result = expiring.Query({1, 0}, current);
  Check(!fresh_result.partial && fresh_result.items.size() == 1 && fresh_result.items[0].sample.record.id == fresh.record.id);

  HistoryMongo slots(uri, database + "_slots", budget); slots.Initialize();
  auto first = Make(9201, at); first.record.vector = {1, 0};
  const auto original = slots.ReplaceTrackSlot(first, 0, "", "original");
  slots.Put(Make(9202, at));
  IndexProjection mutable_cache(slots, "pair-v1", 2, 2);
  mutable_cache.Rebuild({{channel}, at - 1, at + 2001, 20});
  auto changed = first; changed.record.captured_ms = at + 1000; changed.record.vector = {0, 1};
  changed.evidence["frame_id"] = Id(9250); changed.evidence["source_frame_index"] = "9250";
  changed.evidence["source_pts_ns"] = std::to_string((at + 1000) * 1000000LL);
  const auto replacement = slots.ReplaceTrackSlot(changed, 0, original, "changed-outside-cache");
  const auto reranked = mutable_cache.Query({1, 0}, current);
  Check(!reranked.partial && reranked.items.size() == 1 && reranked.items[0].score == 0 &&
    reranked.items[0].sample.fingerprint == replacement);
  mutable_cache.Rebuild({{channel}, at - 1, at + 3001, 20});
  auto latest = changed; auto latest_fingerprint = replacement;
  for (int n = 0; n < 33; ++n) {
    latest.record.captured_ms = at + 1001 + n;
    latest.evidence["frame_id"] = Id(9251 + n); latest.evidence["source_frame_index"] = std::to_string(9251 + n);
    latest.evidence["source_pts_ns"] = std::to_string(latest.record.captured_ms * 1000000LL);
    latest_fingerprint = mutable_cache.ReplaceTrackSlot(latest, 0, latest_fingerprint, "local-" + std::to_string(n));
  }
  const auto local = mutable_cache.Query({1, 0}, {{channel}, latest.record.captured_ms, latest.record.captured_ms + 1, 20});
  Check(!local.partial && local.items.size() == 1 && local.items[0].sample.fingerprint == latest_fingerprint);
  // The maintenance lookup intentionally needs no stored JPEG/vector payload.
  Command(client, database + "_slots", {{"update", "search_samples"}, {"updates", Json::array({
    {{"q", {{"_id", first.record.id}}}, {"u", {{"$unset", {{"jpeg", ""}, {"vector", ""}}}}}}
  })}});
  Check(slots.ReadVisibleFingerprints("pair-v1", {first.record.id}).at(first.record.id) == latest_fingerprint);
  Reject([&] { slots.Get(first.record.id); });

  HistoryMongo pages(uri, database + "_pages", budget); pages.Initialize();
  for (int n = 0; n < 65; ++n) pages.Put(Make(9700 + n, at));
  IndexProjection paging(pages, "pair-v1", 2, 100);
  paging.Rebuild({{Id(9999)}, at - 1, at + 1, 20});
  const Scope all{{channel}, at - 1, at + 1, 100};
  bool complete=false;
  for(int attempt=0;attempt<8;++attempt){
    const auto page = paging.Query({1, 0}, all);
    Check(page.items.size()<=65);
    if(!page.partial){Check(page.items.size()==65);complete=true;break;}
  }
  Check(complete);Check(!paging.Query({1,0},all).partial);
}
void IndexChanges(const std::string& uri, const std::string& database, int64_t at, mongoc_client_t* client) {
  HistoryMongo history(uri, database); history.Initialize();
  const auto first = Make(8300, at), second = Make(8301, at + 1);
  history.Put(first); history.Put(second);
  auto page = history.ScanIndexChanges("pair-v1", {channel}, 0, 1);
  Check(page.items.size() == 1 && page.items[0].channel == channel && page.items[0].captured_ms == at &&
    page.items[0].ordinal == page.checkpoint);
  auto next = history.ScanIndexChanges("pair-v1", {channel}, page.checkpoint, 1);
  Check(next.items.size() == 1 && next.items[0].captured_ms == at + 1 && next.checkpoint > page.checkpoint);
  Check(history.ScanIndexChanges("pair-v1", {channel}, next.checkpoint, 32).items.empty());
  Check(history.ScanIndexChanges("another-model", {channel}, 0, 32).items.empty());
  Check(history.ScanIndexChanges("pair-v1", {Id(999)}, 0, 32).items.empty());
  Reject([&] { history.ScanIndexChanges("pair-v1", {}, 0); });
  Reject([&] { history.ScanIndexChanges("pair-v1", {"invalid"}, 0); });
  Reject([&] { history.ScanIndexChanges("pair-v1", {channel}, -1); });
  Reject([&] { history.ScanIndexChanges("pair-v1", {channel}, 9007199254740992LL); });
  Reject([&] { history.ScanIndexChanges("pair-v1", {channel}, 0, 65); });
  Reject([&] { history.ScanIndexChanges("pair-v1", {channel}, 0, 0); });
  std::set<std::string> many; for (int n = 0; n < 1024; ++n) many.insert(Id(n)); many.insert(channel);
  Reject([&] { history.ScanIndexChanges("pair-v1", many, 0); }); many.erase(channel);
  Check(history.ScanIndexChanges("pair-v1", many, 0).items.empty());
  auto slot = Make(8302, at + 2);
  auto fp = history.ReplaceTrackSlot(slot, 0, "", "initial");
  auto before = history.ScanIndexChanges("pair-v1", {channel}, next.checkpoint);
  Check(before.items.size() == 1);
  slot.record.captured_ms = at + 3; slot.evidence["source_pts_ns"] = std::to_string((at + 3) * 1000000LL);
  slot.evidence["source_frame_index"] = "8303"; slot.evidence["frame_id"] = Id(8303);
  history.ReplaceTrackSlot(slot, 0, fp, "replacement");
  auto updated = history.ScanIndexChanges("pair-v1", {channel}, before.checkpoint);
  Check(updated.items.size() == 1 && updated.items[0].captured_ms == at + 3 && updated.checkpoint > before.checkpoint);
  // Discovery is strictly metadata-only, even while an invalid stored payload
  // will be rejected by the actual vector builder. No CPU/JPEG decoding here.
  Command(client, database, {{"update", "search_samples"}, {"updates", Json::array({{{"q", {{"_id", first.record.id}}},
    {"u", {{"$unset", {{"vector", ""}, {"jpeg", ""}}}}}}})}});
  Check(history.ScanIndexChanges("pair-v1", {channel}, 0).items.size() == 3);
  Reject([&] { history.Scan("pair-v1", {{channel}, at - 1, at + 10, 20}, 0, 10); });
  // An intent committed before physical cleanup still hides this interval.
  Command(client, database, {{"insert", "search_deletions"}, {"documents", Json::array({{{"_id", "index-intent"},
    {"channel", channel}, {"from", at - 1}, {"to", at + 10}, {"expires_at", {{"$date", {{"$numberLong", std::to_string(at + 60000)}}}}}}})}});
  auto hidden = history.ScanIndexChanges("pair-v1", {channel}, 0);
  Check(hidden.items.empty() && hidden.checkpoint == updated.checkpoint);
}

// Rolling retention: a full store evicts its OLDEST evidence (early expiry semantics) instead of
// rejecting new samples; a minimum-age guard keeps the hard 507 cap honest.
void RollingRetention(const std::string& uri, const std::string& database, mongoc_client_t* client) {
  const auto old = Now() - 3600000;
  const auto fresh = [&](int n, int64_t captured) { auto s = Make(n, captured); s.expires_ms = Now() + 3600000; return s; };
  {
    HistoryBudget budget; budget.max_samples = 4; budget.max_bytes = 1024 * 1024; budget.evict_min_age_ms = 60000;
    HistoryMongo history(uri, database + "_rolling", budget); history.Initialize();
    for (int n = 1; n <= 4; ++n) history.Put(fresh(n, old + n * 1000));
    history.PutCoverage(Id(901), "pair-v1", channel, old, old + 10000, false, "sampled", Now() + 3600000);
    history.PutCoverage(Id(902), "pair-v1", channel, Now() - 5000, Now() - 1000, false, "sampled", Now() + 3600000);
    const auto revision = history.ProjectionStamp().revision;
    history.Put(fresh(5, Now() - 1000));                      // full store: must evict, not reject
    Check(!history.Get(Id(1), false));                        // oldest evidence is gone
    Check(history.Get(Id(4), false) && history.Get(Id(5), false));
    Check(history.Usage().at("samples").get<int64_t>() <= 4);
    const auto visible = history.ReadVisibleFingerprints("pair-v1", {Id(1), Id(5)});
    Check(visible.size() == 1 && visible.count(Id(5)) == 1);  // evicted id invisible to the index check
    const Scope everything{{channel}, old - 1000, Now() + 1000, 60};
    for (const auto& row : history.Scan("pair-v1", everything, 0, 20).samples) Check(row.record.id != Id(1));
    Check(history.ProjectionStamp().revision > revision);     // index exhausted-proofs must be invalidated
    const auto coverage = history.Coverage("pair-v1", everything);
    for (const auto& range : coverage) Check(range.at("from").get<int64_t>() > old + 1000);  // evicted span is unknown, not sampled
    Check(!coverage.empty());                                 // newer coverage survives
    const auto capacity = history.Capacity();
    Check(capacity.at("evicted_samples").get<int64_t>() >= 1 && capacity.at("evicted_bytes").get<int64_t>() > 0);
    Check(capacity.at("oldest_retained_captured_ms").get<int64_t>() > old + 1000);
  }
  {  // The minimum-age guard: fresh evidence is never evicted; the hard cap still answers capacity.
    HistoryBudget budget; budget.max_samples = 2; budget.max_bytes = 1024 * 1024; budget.evict_min_age_ms = 600000;
    HistoryMongo history(uri, database + "_guard", budget); history.Initialize();
    history.Put(fresh(1, Now() - 2000)); history.Put(fresh(2, Now() - 1000));
    Reject([&] { history.Put(fresh(3, Now() - 500)); });
    Check(history.Get(Id(1), false) && history.Get(Id(2), false));
    Check(history.Capacity().at("evicted_samples").get<int64_t>() == 0);
  }
  {  // Byte quota evicts too, and an open shortlist keeps its order and offsets over an evicted row.
    HistoryBudget budget; budget.max_samples = 100; budget.max_bytes = 4096; budget.evict_min_age_ms = 60000;
    HistoryMongo history(uri, database + "_bytes", budget); history.Initialize();
    int n = 1;
    for (; n <= 40; ++n) history.Put(fresh(n, old + n * 1000));   // fills 4096 bytes quickly, evicting as it goes
    Check(history.Usage().at("bytes").get<int64_t>() <= 4096);
    Check(!history.Get(Id(1), false) && history.Get(Id(40), false));
    const auto at = old + 1000;
    SearchSessionRequest request{Id(950), "operator", "query", "pair-v1", {{channel}, at, Now(), 60}, false, Now() + 3600000};
    const auto version = history.BeginSearch(request);
    std::vector<SearchSessionCandidate> order{{Id(40), .9}, {Id(39), .8}, {Id(38), .7}};
    Check(history.PublishSearch(request.id, request.actor, version, order, "sampled"));
    for (; n <= 120; ++n) history.Put(fresh(n, old + n * 1000));   // churn evicts the shortlist's rows
    const auto page = history.ReadSearch(request.id, request.actor, 0, 10);
    Check(page && page->published);                               // evicted evidence behaves like expired evidence
    for (const auto& item : page->items) Check(item.sample.record.id != Id(1));
    Check(page->coverage != "sampled");
  }
  Command(client, database + "_rolling", {{"dropDatabase", 1}});
  Command(client, database + "_guard", {{"dropDatabase", 1}});
  Command(client, database + "_bytes", {{"dropDatabase", 1}});
}

int main() {
  if (!std::getenv("AINVR_SEARCH_TEST_MONGO")) { std::cout << "SKIP: isolated Mongo fixture not requested\n"; return 77; }
  const std::string uri = "mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=2000";
  const std::string database = "ainvr_search_test_" + std::to_string(Now());
  mongoc_init();
  std::unique_ptr<mongoc_client_t, decltype(&mongoc_client_destroy)> client(mongoc_client_new(uri.c_str()), mongoc_client_destroy);
  std::vector<std::string> databases = {database, database + "_quota", database + "_capped", database + "_slots", database + "_slots_unique", database + "-long", database + "_scenes", database + "_maintenance", database + "_maintenance_ttl", database + "_maintenance_slots", database + "_maintenance_pages", database + "_index_changes"};
  const auto cleanup = [&] { for (const auto& name : databases) Command(client.get(), name, {{"dropDatabase", 1}}); };
  try {
    auto history = std::make_unique<HistoryMongo>(uri, database); history->Initialize();
    const auto at = Now() - 1000; const auto first = Make(9, at);
    IndexChanges(uri, database + "_index_changes", at, client.get());
    SceneReceipts(uri, database + "_scenes", at);
    ProjectionMaintenance(uri, database + "_maintenance", at, client.get());
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
    IndexProjection working(*history, "pair-v1", 2, 1);
    working.Start(scope);
    Check(working.Query({1, 0}, scope).partial); // Capacity never pretends a full negative.
    auto indexed = history->Scan("pair-v1", scope, 0, 10);
    Check(working.Warm({indexed.samples[0].record}) == 0); // Query already filled bounded cache.
    IndexProjection warmed(*history, "pair-v1", 2, 8); warmed.Start(scope);
    Check(warmed.Warm({indexed.samples[0].record}) == 1);
    auto stale = indexed.samples[0].record; stale.fingerprint = std::string(64, 'a');
    Check(warmed.Warm({stale}) == 0); // A file cannot overwrite a live generation.
    Check(!warmed.Query({1, 0}, scope).partial && warmed.Query({1, 0}, scope).items.size() == 2);
    const auto stamp_before=history->ProjectionStamp();
    Check(!warmed.Query({1, 0}, scope).partial&&history->ProjectionStamp().revision==stamp_before.revision);
    Check(warmed.Resident({indexed.samples[0].record}).has_value());
    auto wrong_model = indexed.samples[0].record; wrong_model.model = "other";
    Check(warmed.Warm({wrong_model}) == 0);
    Scope many_sources = scope; for (int n = 0; n < 100; ++n) many_sources.channels.insert(Id(n));
    warmed.Start(many_sources); // Internal warmup accepts all sources without selecting first 100.
    Check(warmed.Query({1, 0}, scope).items.size() == 2);
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
    Check(!projection.Query({1, 0}, wider).partial); // Wider but authoritatively exhausted.
    history->PutCoverage(Id(40), "pair-v1", channel, at - 1, at + 1, false, "pending", at + 60000);
    history->PutCoverage(Id(40), "pair-v1", channel, at - 1, at + 1, false, "sampled", at + 60000);
    history->PutCoverage(Id(40), "pair-v1", channel, at - 1, at + 1, false, "pending", at + 60000);
    Check(history->Coverage("pair-v1", scope)[0].at("state") == "sampled");
    history->PutCoverage(Id(40), "pair-v1", channel, at - 1, at + 1, false, "gap", at + 60000);
    Check(history->Coverage("pair-v1", scope)[0].at("state") == "gap");
    history->PutCoverage(Id(40), "pair-v1", channel, at - 1, at + 1, false, "sampled", at + 60000);
    Check(history->Coverage("pair-v1", scope)[0].at("state") == "gap");
    Json documents=Json::array();const auto base=at-200000;
    for(int i=0;i<10001;++i)documents.push_back({{"_id",Id(40000+i)},{"model","coverage-large"},{"channel",channel},
      {"from",base+i*10},{"to",base+(i+1)*10},{"scene",false},{"rank",2},
      {"expires_at",{{"$date",{{"$numberLong",std::to_string(at+60000)}}}}}});
    Command(client.get(),database,{{"insert","search_coverage"},{"documents",documents}});
    auto compacted=history->Coverage("coverage-large",{{channel},base,base+100010,20});
    Check(compacted.size()==1&&compacted[0].at("from")==base&&compacted[0].at("to")==base+100010);
    auto boxed=Make(60000,at);boxed.evidence["image_space"]="raw-nv12-crop";boxed.evidence["projection_mode"]="raw_planar";
    boxed.evidence["raw_source_rectangle"]={100,200,400,800};boxed.evidence["target"]={{"raw_bbox",{200,400,200,400}}};
    Check(DisplayBBox(boxed)==std::optional<Json>(Json::array({.25,.25,.5,.5})));
    boxed.record.scene=true;Check(!DisplayBBox(boxed));boxed.record.scene=false;
    boxed.evidence["target"]["raw_bbox"]={0,0,50,50};Check(!DisplayBBox(boxed));
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
    const auto owner=Id(90001);history->BeginSourceWriterEpoch(owner,SourceWriterBootstrap::Denied);
    Check(history->MarkSourceWriterUnknown(owner));
    HistoryMongo reconstructed(uri,database);reconstructed.Initialize();
    Check(!reconstructed.ProjectionStamp().settled);
    reconstructed.BeginSourceWriterEpoch(Id(90002),SourceWriterBootstrap::Denied);
    Check(!reconstructed.ProjectionStamp().settled);
    IndexProjection uncertain(reconstructed,"pair-v1",2,8);uncertain.Start(scope);
    Check(uncertain.Query({1,0},scope).partial);
    RollingRetention(uri, database, client.get());
    cleanup(); std::cout << "history: durability, replay, scope, integrity, deletion, coverage and quotas passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; try { cleanup(); } catch (...) {} return 1;
  }
}
