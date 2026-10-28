#include "history_mongo.hpp"
#include <mongoc/mongoc.h>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <thread>
using namespace ainvr::search;
using Json = nlohmann::json;
int64_t Now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
void Check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
void Reject(const std::function<void()>& call) { bool rejected = false; try { call(); } catch (...) { rejected = true; } Check(rejected, "expected rejection"); }
std::string Id(int n) { return "00000000-0000-4000-8000-" + std::to_string(100000000000LL + n); }
const auto channel = Id(1);
Sample Make(int n, int64_t at) {
  return {{Id(n), channel, "processor", "session", "track" + std::to_string(n), "pair-v1", at, false, {1, 0}},
    {{"role", "match"}, {"source_input_id", channel}, {"output_channel_id", channel}, {"recording_channel_id", channel},
     {"schema_version", "1.0"}, {"stream_session_id", "session"}, {"source_pts_ns", std::to_string(at * 1000000LL)},
     {"source_frame_index", std::to_string(n)}, {"frame_id", Id(n)}, {"frame_width", 1920}, {"frame_height", 1080}},
    {255, 216, 255, 217}, at + 60000};
}
void Command(mongoc_client_t* client, const std::string& db, const nlohmann::ordered_json& command) {
  const auto text = command.dump(); bson_error_t error{}; bson_t reply;
  bson_t* input = bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()), text.size(), &error);
  Check(input != nullptr, "invalid fixture command");
  bool ok = mongoc_client_command_simple(client, db.c_str(), input, nullptr, &reply, &error);
  bson_destroy(input); bson_destroy(&reply); Check(ok, "fixture command failed");
}
int main() {
  if (!std::getenv("AINVR_SEARCH_TEST_MONGO")) { std::cout << "SKIP: isolated Mongo fixture not requested\n"; return 77; }
  const std::string uri = "mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=2000";
  const auto database = "ainvr_search_session_test_" + std::to_string(Now());
  mongoc_init();
  std::unique_ptr<mongoc_client_t, decltype(&mongoc_client_destroy)> client(mongoc_client_new(uri.c_str()), mongoc_client_destroy);
  const auto cleanup = [&] { for (const auto& db : {database, database + "_quota"}) Command(client.get(), db, {{"dropDatabase", 1}}); };
  try {
    const auto at = Now() - 1000;
    auto history = std::make_unique<HistoryMongo>(uri, database); history->Initialize();
    for (int n = 10; n < 16; ++n) history->Put(Make(n, at + n));
    SearchSessionRequest request{Id(40), "operator", "背黑色双肩包的人", "pair-v1", {{channel}, at, at + 100, 60}, true, Now() + 3600000};
    const auto version = history->BeginSearch(request);
    Check(history->BeginSearch(request) == version, "duplicate query changed generation");
    auto changed = request; changed.query = "different"; Reject([&] { history->BeginSearch(changed); });
    auto pending = history->ReadSearch(request.id, request.actor);
    Check(pending && !pending->published && pending->items.empty(), "pending snapshot falsely published");
    Check(!history->ReadSearch(request.id, "other-operator"), "owner boundary failed");
    Reject([&] { history->PublishSearch(request.id, request.actor, std::string(64, '0'), {}, "unknown"); });
    Reject([&] { history->PublishSearch(request.id, request.actor, version, {{Id(10), 0.9}, {Id(10), 0.8}}, "sampled"); });
    auto outside = Make(20, at + 200); history->Put(outside);
    Reject([&] { history->PublishSearch(request.id, request.actor, version, {{Id(20), 0.9}}, "sampled"); });
    std::vector<SearchSessionCandidate> order{{Id(15), .99}, {Id(10), .95}, {Id(14), .9}, {Id(11), .8}, {Id(13), .7}, {Id(12), .6}};
    Check(history->PublishSearch(request.id, request.actor, version, order, "sampled"), "shortlist not published");
    std::reverse(order.begin(), order.end());
    Check(!history->PublishSearch(request.id, request.actor, version, order, "partial"), "published order overwritten");
    auto first = history->ReadSearch(request.id, request.actor, 0, 2);
    Check(first && first->published && first->items.size() == 2 && first->next_offset == 2 && first->items[0].sample.record.id == Id(15), "first page unstable");
    Check(history->SearchFeedback(request.id, request.actor, Id(15), false), "feedback not stored");
    Check(!history->SearchFeedback(request.id, "other-operator", Id(15), true), "feedback owner bypass");
    Check(!history->SearchFeedback(request.id, request.actor, Id(20), true), "feedback result bypass");
    history.reset(); history = std::make_unique<HistoryMongo>(uri, database); history->Initialize();
    auto restored = history->ReadSearch(request.id, request.actor, 0, 2);
    Check(restored && restored->items[0].relevant == false && restored->items[0].sample.jpeg.empty(), "snapshot/feedback not durable or copied images");
    Check(bool(history->SearchImage(request.id, request.actor, Id(15), Id(15))), "owned snapshot image missing");
    Check(!history->SearchImage(request.id, request.actor, Id(15), Id(14)), "wrong frame image leaked");
    // Remove the first page's first slot. The following page must still start
    // at original ordinal 2, rather than skipping or duplicating a live result.
    history->DeleteRange(channel, at + 15, at + 16);
    first = history->ReadSearch(request.id, request.actor, 0, 2);
    Check(first && first->coverage == "partial" && first->items.size() == 1 && first->next_offset == 2, "deleted evidence changed page offset");
    auto second = history->ReadSearch(request.id, request.actor, 2, 2);
    Check(second && second->coverage == "partial" && second->items[0].sample.record.id == Id(14) && second->next_offset == 4, "second page shifted or coverage overstated");
    history->CancelSearch(request.id, request.actor); history->CancelSearch(request.id, request.actor);
    Check(!history->ReadSearch(request.id, request.actor), "cancelled snapshot visible");
    Reject([&] { history->PublishSearch(request.id, request.actor, version, order, "sampled"); });
    history->CancelSearch(Id(50), request.actor);
    changed = request; changed.id = Id(50); Reject([&] { history->BeginSearch(changed); });
    changed = request; changed.id = Id(60); changed.actor = "another";
    const auto old_version = history->BeginSearch(changed);
    Command(client.get(), database, {{"update", "search_sessions"}, {"updates", Json::array({
      {{"q", {{"version", old_version}}}, {"u", {{"$set", {{"expires_at", {{"$date", {{"$numberLong", std::to_string(Now() - 1)}}}}}}}}}}
    })}});
    Check(!history->ReadSearch(changed.id, changed.actor), "expired session visible");
    const auto new_version = history->BeginSearch(changed); Check(new_version != old_version, "expired generation reused");
    Reject([&] { history->PublishSearch(changed.id, changed.actor, old_version, {}, "unknown"); });
    changed = request; changed.id = Id(90); const auto missing_version = history->BeginSearch(changed);
    history->PublishSearch(changed.id, changed.actor, missing_version, {{Id(91), .9}}, "sampled");
    history->Put(Make(91, at + 20));
    auto missing = history->ReadSearch(changed.id, changed.actor);
    Check(missing && missing->items.empty() && missing->coverage == "partial", "new record appeared in an old missing slot");
    Check(!history->SearchFeedback(changed.id, changed.actor, Id(91), true), "missing slot accepted feedback for new record");
    history->Put(Make(93, at + 30)); changed.id = Id(92); const auto reused_version = history->BeginSearch(changed);
    history->PublishSearch(changed.id, changed.actor, reused_version, {{Id(93), .9}}, "sampled");
    Command(client.get(), database, {{"delete", "search_samples"}, {"deletes", Json::array({{{"q", {{"_id", Id(93)}}}, {"limit", 1}}})}});
    auto replacement = Make(93, at + 30); replacement.jpeg = {255, 216, 0, 255, 217}; history->Put(replacement);
    auto reused = history->ReadSearch(changed.id, changed.actor);
    Check(reused && reused->items.empty() && reused->coverage == "partial", "reused ID changed an old snapshot image");
    Check(!history->SearchFeedback(changed.id, changed.actor, Id(93), true), "reused reference accepted old feedback");
    Check(!history->SearchImage(changed.id, changed.actor, Id(93), Id(93)), "reused ID image leaked from old snapshot");
    // Concurrent reopen is idempotent and cannot create more than one snapshot.
    changed = request; changed.id = Id(60); changed.actor = "another";
    std::atomic<bool> failed{false}; std::vector<std::thread> calls;
    for (int n = 0; n < 4; ++n) calls.emplace_back([&] { try { if (history->BeginSearch(changed) != new_version) failed = true; } catch (...) { failed = true; } });
    for (auto& call : calls) call.join();
    Check(!failed, "concurrent session admission");
    HistoryBudget budget; budget.max_searches = 1;
    HistoryMongo limited(uri, database + "_quota", budget); limited.Initialize(); limited.BeginSearch(request);
    changed = request; changed.id = Id(70); Reject([&] { limited.BeginSearch(changed); });
    Reject([&] { limited.CancelSearch(Id(80), request.actor); });
    Check(limited.BeginSearch(request).size() == 64, "idempotency failed at quota");
    cleanup(); std::cout << "search session: immutable order, durable feedback, ownership, cancellation, expiry, stale generation and bounds passed\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; try { cleanup(); } catch (...) {} return 1; }
}
