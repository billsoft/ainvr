#include "http_service.hpp"
#include <mongoc/mongoc.h>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <future>
#include <iostream>
#include <thread>
using namespace ainvr::search;
using Json = nlohmann::json;
using namespace std::chrono_literals;
int64_t Now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
void Check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
std::string Id(int n) { return "00000000-0000-4000-8000-" + std::to_string(100000000000LL + n); }
const std::string token(48, 't'), channel = Id(1);
const httplib::Headers auth{{"x-service-token", token}};
const httplib::Headers producer{{"x-service-token", std::string(48, 'p')}, {"x-search-config-revision", std::string(64, '0')}};
HttpAccess Access() {
  HttpAccess access; access.console_key = token; access.producer_key = std::string(48, 'p');
  access.management_key = std::string(48, 'm'); access.revision = std::string(64, '0');
  access.enabled = true; access.unavailable_reason.clear(); access.ingestion_model = "fixture-pair-v1";
  access.sources.emplace(channel, ProducerSource{Id(3), "fixture-processor", Id(4), true, true, "/live/raw", "/live/ai"});
  return access;
}

// Synthetic transport/index oracle only: never built into a production service
// and deliberately named as a fixture, not a CPU model fallback.
class FixtureEncoder final : public TextEncoder {
 public:
  std::string ModelVersion() const override { return "fixture-pair-v1"; }
  size_t Dimensions() const override { return 2; }
  std::vector<float> Encode(const std::string& text) override {
    std::unique_lock<std::mutex> lock(mutex);
    if (text == "hold") { entered = true; changed.notify_all(); changed.wait(lock, [&] { return !hold; }); }
    if (text == "too-long") throw QueryTextError(QueryTextError::Reason::TooLong);
    if (text == "unrepresentable") throw QueryTextError(QueryTextError::Reason::Unrepresentable);
    if (text == "runtime-failure") throw std::runtime_error("driver secret never disclose");
    if (text == "invalid-vector") return {0, 0};
    return {1, 0};
  }
  void Wait() { std::unique_lock<std::mutex> lock(mutex); Check(changed.wait_for(lock, 2s, [&] { return entered; }), "encoder never entered"); }
  void Release() { std::lock_guard<std::mutex> lock(mutex); hold = false; changed.notify_all(); }
  std::mutex mutex; std::condition_variable changed; bool hold = true, entered = false;
};
class RunningServer {
 public:
  explicit RunningServer(HttpService& service) {
    service.Register(server); port = server.bind_to_any_port("127.0.0.1"); Check(port > 0, "test bind");
    thread = std::thread([&] { server.listen_after_bind(); });
    for (int i = 0; i < 200 && !server.is_running(); ++i) std::this_thread::sleep_for(5ms);
    Check(server.is_running(), "test server unavailable");
  }
  ~RunningServer() { server.stop(); if (thread.joinable()) thread.join(); }
  httplib::Server server; int port = 0; std::thread thread;
};
Json Expect(const httplib::Result& response, int status) {
  if (!response || response->status != status) throw std::runtime_error("expected HTTP " + std::to_string(status) +
    "; got " + (response ? std::to_string(response->status) + " " + response->body.substr(0, 256) : "transport failure"));
  Check(response->get_header_value("Cache-Control") == "no-store", "cache disclosure");
  Check(response->get_header_value("X-Content-Type-Options") == "nosniff", "missing image protection");
  return Json::parse(response->body);
}
Json ScopeJson(int64_t at) { return {{"channel_ids", {channel}}, {"from_ms", at - 1}, {"to_ms", at + 1}, {"limit", 20}}; }
Json SampleJson(int64_t at) {
  return {{"id", Id(2)}, {"channel_id", channel}, {"processor_id", "fixture-processor"},
    {"stream_session_id", "fixture-session"}, {"track_id", "fixture-track"}, {"model_version", "fixture-pair-v1"},
    {"captured_ms", at}, {"kind", "object"}, {"expires_ms", at + 60000}, {"vector", {1, 0}},
    {"evidence", {{"source_input_id", Id(3)}, {"output_channel_id", channel}, {"recording_channel_id", Id(4)},
      {"input_path", "/live/raw"}, {"output_path", "/live/ai"},
      {"frame_id", Id(5)}, {"role", "match"}, {"schema_version", "1.0"}, {"stream_session_id", "fixture-session"},
      {"source_pts_ns", "123456000"}, {"source_frame_index", "123"}, {"frame_width", 1920}, {"frame_height", 1080}}}};
}
httplib::UploadFormDataItems Parts(const Json& metadata) {
  return {{"metadata", metadata.dump(), "metadata.json", "application/json"},
    {"image", std::string("\xff\xd8\xff\xd9", 4), "frame.jpg", "image/jpeg"}};
}
int main() {
  if (!std::getenv("AINVR_SEARCH_TEST_MONGO")) { std::cout << "SKIP: isolated Mongo fixture not requested\n"; return 77; }
  const std::string uri = "mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=2000";
  const auto database = "ainvr_search_http_test_" + std::to_string(Now());
  mongoc_init();
  const auto cleanup = [&] {
    auto client = mongoc_client_new(uri.c_str()); auto db = mongoc_client_get_database(client, database.c_str());
    bson_error_t error{}; const bool ok = mongoc_database_drop(db, &error);
    mongoc_database_destroy(db); mongoc_client_destroy(client); Check(ok, "fixture cleanup failed");
  };
  try {
    HistoryBudget budget; budget.max_samples = 2;
    HistoryMongo history(uri, database, budget); history.Initialize();
    HttpService pending(&history, Access()); RunningServer pending_server(pending);
    httplib::Client client("127.0.0.1", pending_server.port); client.set_read_timeout(5);
    Expect(client.Get("/v1/status"), 401);
    Expect(client.Get("/v1/status", httplib::Headers{{"x-service-token", std::string(48, 'u')}}), 401);
    Expect(client.Get("/v1/status", httplib::Headers{{"x-service-token", token}, {"x-service-token", token}}), 401);
    Check(Expect(client.Get("/v1/status", auth), 200).at("reason") == "model_pending", "false readiness");
    Expect(client.Get("/v1/status", producer), 403);
    Expect(client.Post("/v1/samples", auth, Parts(SampleJson(Now() - 1000))), 403);
    Expect(client.Get("/v1/models", auth), 403);
    Check(Expect(client.Get("/v1/models", httplib::Headers{{"x-service-token", std::string(48, 'm')}}), 200).at("items").empty(), "catalog auth");
    Expect(client.Post("/v1/searches/cancel", {{"x-service-token", std::string(48, 'm')}}, "{}", "application/json"), 403);
    auto stale = producer; stale.erase("x-search-config-revision");
    Expect(client.Post("/v1/samples", stale, Parts(SampleJson(Now() - 1000))), 409);
    auto disabled_access = Access(); disabled_access.enabled = false;
    HttpService disabled(nullptr, disabled_access); RunningServer disabled_server(disabled);
    httplib::Client off("127.0.0.1", disabled_server.port);
    Check(Expect(off.Get("/v1/status", auth), 200).at("reason") == "disabled", "disabled dependency-free status");
    Check(Expect(off.Get("/health"), 200).at("alive"), "disabled liveness");
    Expect(off.Post("/v1/samples", producer, Parts(SampleJson(Now() - 1000))), 503);
    auto gated_access = Access(); gated_access.admitted->store(false);
    HttpService gated(&history, gated_access); RunningServer gated_server(gated);
    httplib::Client waiting("127.0.0.1", gated_server.port);
    Check(Expect(waiting.Get("/v1/status", auth), 200).at("reason") == "config_pending", "unacknowledged generation admitted");
    Expect(waiting.Post("/v1/samples", producer, Parts(SampleJson(Now() - 1000))), 503);
    gated_access.admitted->store(true);
    Check(Expect(waiting.Get("/v1/status", auth), 200).at("reason") == "model_pending", "ACK did not activate generation");
    const auto at = Now() - 1000; const auto scope = ScopeJson(at);
    const Json query = {{"query", "person in red jacket"}, {"scope", scope}};
    Check(Expect(client.Post("/v1/match", auth, query.dump(), "application/json"), 503).at("error") == "model_pending", "fake model query");
    Expect(client.Post("/v1/match", auth, "{broken", "application/json"), 400);
    auto invalid = query; invalid["scope"]["limit"] = 1.5;
    Expect(client.Post("/v1/match", auth, invalid.dump(), "application/json"), 400);
    invalid = query; invalid["scope"]["channel_ids"].push_back(channel);
    Expect(client.Post("/v1/match", auth, invalid.dump(), "application/json"), 400);
    invalid = query; invalid["scope"]["from_ms"] = 18446744073709551615ULL;
    Expect(client.Post("/v1/match", auth, invalid.dump(), "application/json"), 400);
    auto row = SampleJson(at);
    for (const char* field : {"input_path", "output_path"}) {
      auto wrong_path = row; wrong_path["evidence"][field] = "/live/other";
      Expect(client.Post("/v1/samples", producer, Parts(wrong_path)), 403);
      wrong_path["evidence"].erase(field);
      Expect(client.Post("/v1/samples", producer, Parts(wrong_path)), 403);
      wrong_path["evidence"][field] = nullptr;
      Expect(client.Post("/v1/samples", producer, Parts(wrong_path)), 403);
    }
    auto top_level_path = row; top_level_path["input_path"] = "/live/raw";
    Expect(client.Post("/v1/samples", producer, Parts(top_level_path)), 400);
    Expect(client.Post("/v1/samples", producer, Parts(row)), 200);
    Expect(client.Post("/v1/samples", producer, Parts(row)), 200); // Idempotent retry.
    invalid = row; invalid["vector"] = {0, 1};
    Expect(client.Post("/v1/samples", producer, Parts(invalid)), 409);
    invalid = row; invalid["id"] = Id(20); invalid["evidence"]["stream_session_id"] = "wrong-session";
    Expect(client.Post("/v1/samples", producer, Parts(invalid)), 400);
    auto duplicate = Parts(row); duplicate.push_back(duplicate[0]);
    Expect(client.Post("/v1/samples", producer, duplicate), 400);
    auto deep = row; for (int i = 0; i < 18; ++i) deep = Json{{"nested", deep}};
    Expect(client.Post("/v1/samples", producer, Parts(deep)), 400);
    std::string path = "/v1/samples/" + Id(2) + "?channel_id=" + channel + "&model_version=fixture-pair-v1";
    auto meta = Expect(client.Get(path.c_str(), auth), 200);
    Check(meta.at("evidence").at("recording_channel_id") == Id(4) && !meta.contains("vector"), "provenance or vector leakage");
    auto image = client.Get(("/v1/samples/" + Id(2) + "/image?channel_id=" + channel + "&model_version=fixture-pair-v1").c_str(), auth);
    Check(image && image->status == 200 && image->body.size() == 4 && image->get_header_value("Content-Type") == "image/jpeg", "image not returned");
    Expect(client.Get((path + "&channel_id=" + Id(9)).c_str(), auth), 400);
    Expect(client.Get(("/v1/samples/" + Id(2) + "?channel_id=" + Id(9) + "&model_version=fixture-pair-v1").c_str(), auth), 404);
    Json coverage = {{"id", Id(6)}, {"model_version", "fixture-pair-v1"}, {"channel_id", channel},
      {"from_ms", at - 1}, {"to_ms", at + 1}, {"kind", "object"}, {"state", "sampled"}, {"expires_ms", at + 60000}};
    Expect(client.Put("/v1/coverage/range", producer, coverage.dump(), "application/json"), 200);
    Json coverage_query = {{"model_version", "fixture-pair-v1"}, {"scope", scope}};
    auto ranges = Expect(client.Post("/v1/coverage", auth, coverage_query.dump(), "application/json"), 200);
    Check(ranges.at("ranges").size() == 1, "coverage missing");
    FixtureEncoder encoder; MatchEngine engine(history, encoder, 8);
    HttpService available(&history, Access(), &engine); RunningServer available_server(available);
    httplib::Client compute("127.0.0.1", available_server.port); compute.set_read_timeout(5);
    Check(!Expect(compute.Get("/v1/status", auth), 200).at("ready").get<bool>(), "index falsely ready");
    engine.Rebuild({{channel}, at - 1, at + 1, 20});
    Check(Expect(compute.Get("/v1/status", auth), 200).at("ready"), "fixture not ready");
    auto matches = Expect(compute.Post("/v1/match", auth, query.dump(), "application/json"), 200);
    Check(matches.at("items").size() == 1 && matches.at("items")[0].at("similarity") == 1 && !matches.at("partial").get<bool>(), "match/index projection");
    Json session = {{"id", Id(40)}, {"actor", "fixture-operator"}, {"query", "person in red jacket"},
      {"scope", scope}, {"model_version", "fixture-pair-v1"}, {"verify", true}, {"expires_ms", Now() + 3600000}};
    auto opened = Expect(compute.Post("/v1/searches/begin", auth, session.dump(), "application/json"), 200);
    Check(opened.at("version").get<std::string>().size() == 64, "invalid query generation");
    auto again = Expect(compute.Post("/v1/searches/begin", auth, session.dump(), "application/json"), 200);
    Check(again == opened, "retry replaced query generation");
    auto changed_query = session; changed_query["query"] = "a different person";
    Expect(compute.Post("/v1/searches/begin", auth, changed_query.dump(), "application/json"), 409);
    Json read = {{"id", Id(40)}, {"actor", "fixture-operator"}, {"offset", 0}, {"limit", 20}};
    auto unpublished = Expect(compute.Post("/v1/searches/read", auth, read.dump(), "application/json"), 200);
    Check(!unpublished.at("published").get<bool>(), "query falsely complete");
    Json publish = {{"id", Id(40)}, {"actor", "fixture-operator"}, {"version", opened.at("version")},
      {"coverage", "sampled"}, {"items", Json::array({{{"sample_id", Id(2)}, {"similarity", 1.0}}})}};
    Check(Expect(compute.Post("/v1/searches/publish", auth, publish.dump(), "application/json"), 200).at("published"), "query not committed");
    auto snapshot = Expect(compute.Post("/v1/searches/read", auth, read.dump(), "application/json"), 200);
    Check(snapshot.at("published") && snapshot.at("items").size() == 1 && snapshot.at("items")[0].at("feedback").is_null(), "query response mismatch");
    Json bound_image = {{"id", Id(40)}, {"actor", "fixture-operator"}, {"sample_id", Id(2)}, {"frame_id", Id(5)}};
    auto bound_bytes = compute.Post("/v1/searches/image", auth, bound_image.dump(), "application/json");
    Check(bound_bytes && bound_bytes->status == 200 && bound_bytes->body.size() == 4 && bound_bytes->get_header_value("Content-Type") == "image/jpeg", "snapshot image unavailable");
    auto bad_image = bound_image; bad_image["frame_id"] = Id(6);
    Expect(compute.Post("/v1/searches/image", auth, bad_image.dump(), "application/json"), 404);
    auto wrong_actor = read; wrong_actor["actor"] = "another-operator";
    Expect(compute.Post("/v1/searches/read", auth, wrong_actor.dump(), "application/json"), 404);
    Json feedback = {{"id", Id(40)}, {"actor", "fixture-operator"}, {"sample_id", Id(2)}, {"relevant", false}};
    Expect(compute.Post("/v1/searches/feedback", auth, feedback.dump(), "application/json"), 200);
    snapshot = Expect(compute.Post("/v1/searches/read", auth, read.dump(), "application/json"), 200);
    Check(snapshot.at("items")[0].at("feedback") == false, "feedback not overlaid");
    Json cancel = {{"id", Id(40)}, {"actor", "fixture-operator"}};
    Expect(compute.Post("/v1/searches/cancel", auth, cancel.dump(), "application/json"), 200);
    Expect(compute.Post("/v1/searches/cancel", auth, cancel.dump(), "application/json"), 200);
    Expect(compute.Post("/v1/searches/read", auth, read.dump(), "application/json"), 404);
    Expect(compute.Post("/v1/searches/image", auth, bound_image.dump(), "application/json"), 404);
    Expect(compute.Post("/v1/searches/publish", auth, publish.dump(), "application/json"), 410);
    cancel["id"] = Id(41); Expect(compute.Post("/v1/searches/cancel", auth, cancel.dump(), "application/json"), 200);
    session["id"] = Id(41); Expect(compute.Post("/v1/searches/begin", auth, session.dump(), "application/json"), 410);
    auto multiline = query; multiline["query"] = "person\nin red jacket";
    Expect(compute.Post("/v1/match", auth, multiline.dump(), "application/json"), 200);
    auto bad_encoding = query; bad_encoding["query"] = "invalid-vector";
    // Bad model output is a service failure, not a malformed user request.
    Expect(compute.Post("/v1/match", auth, bad_encoding.dump(), "application/json"), 503);
    for (const auto& entry : std::vector<std::pair<std::string, std::string>>{
        {"too-long", "query_too_long"}, {"unrepresentable", "query_unrepresentable"}}) {
      auto input = query; input["query"] = entry.first;
      Check(Expect(compute.Post("/v1/match", auth, input.dump(), "application/json"), 400).at("error") == entry.second,
        "query text error was swallowed");
    }
    auto runtime_failure = query; runtime_failure["query"] = "runtime-failure";
    Check(Expect(compute.Post("/v1/match", auth, runtime_failure.dump(), "application/json"), 503).at("error") == "service_unavailable",
      "encoder internal error leaked");
    auto held = std::async(std::launch::async, [&] {
      httplib::Client other("127.0.0.1", available_server.port); other.set_read_timeout(5);
      Json hold = query; hold["query"] = "hold";
      return other.Post("/v1/match", auth, hold.dump(), "application/json");
    });
    bool busy = false;
    try { encoder.Wait(); auto response = compute.Post("/v1/match", auth, query.dump(), "application/json"); busy = response && response->status == 429; }
    catch (...) { encoder.Release(); held.wait(); throw; }
    encoder.Release(); Expect(held.get(), 200); Check(busy, "inference queue unbounded");
    // Fill the authoritative quota through the transport.
    row["id"] = Id(7); Expect(client.Post("/v1/samples", producer, Parts(row)), 200);
    row["id"] = Id(8); Expect(client.Post("/v1/samples", producer, Parts(row)), 507);
    Json deletion = {{"channel_id", channel}, {"from_ms", at - 1}, {"to_ms", at + 1}};
    Expect(client.Delete("/v1/history/range", auth, deletion.dump(), "application/json"), 200);
    Expect(client.Delete("/v1/history/range", auth, deletion.dump(), "application/json"), 200);
    Expect(client.Get(path.c_str(), auth), 404);
    auto empty = Expect(compute.Post("/v1/match", auth, query.dump(), "application/json"), 200);
    Check(empty.at("items").empty(), "deleted data resurrected through index");
    row["id"] = Id(2); Expect(client.Post("/v1/samples", producer, Parts(row)), 410);
    // Dedicated bounded slot endpoint: stable ID, new frame and generation,
    // idempotent lost-ACK retry, stale CAS rejection and no old-score/new-image.
    auto slot_sample = SampleJson(at + 1000); slot_sample["id"] = Id(60); slot_sample["track_id"] = "slot-track";
    Json slot = {{"sample", slot_sample}, {"slot", 0}, {"expected_fingerprint", ""}, {"replacement_token", "first-token"}};
    for (const char* field : {"input_path", "output_path"}) {
      auto wrong_path = slot; wrong_path["sample"]["evidence"][field] = "/live/other";
      Expect(client.Post("/v1/samples/slot", producer, Parts(wrong_path)), 403);
      wrong_path["sample"]["evidence"].erase(field);
      Expect(client.Post("/v1/samples/slot", producer, Parts(wrong_path)), 403);
    }
    auto saved = Expect(client.Post("/v1/samples/slot", producer, Parts(slot)), 200);
    const auto original_fingerprint = saved.at("fingerprint").get<std::string>();
    Check(original_fingerprint.size() == 64, "slot ACK generation missing");
    Check(Expect(client.Post("/v1/samples/slot", producer, Parts(slot)), 200) == saved, "slot retry was not idempotent");
    Json slot_scope = ScopeJson(at + 1000); engine.Rebuild({{channel}, at + 999, at + 1002, 20});
    auto slot_query = query; slot_query["scope"] = slot_scope;
    auto slot_match = Expect(compute.Post("/v1/match", auth, slot_query.dump(), "application/json"), 200);
    Check(slot_match.at("items")[0].at("fingerprint") == original_fingerprint, "match omitted scored generation");
    session["id"] = Id(61); session["scope"] = slot_scope; session["expires_ms"] = Now() + 60000;
    auto slot_open = Expect(compute.Post("/v1/searches/begin", auth, session.dump(), "application/json"), 200);
    publish["id"] = Id(61); publish["version"] = slot_open.at("version");
    publish["items"] = Json::array({{{"sample_id", Id(60)}, {"similarity", 1.0}, {"fingerprint", original_fingerprint}}});
    slot["sample"]["captured_ms"] = at + 1000; slot["sample"]["evidence"]["frame_id"] = Id(62);
    slot["sample"]["evidence"]["source_pts_ns"] = "123457000"; slot["sample"]["evidence"]["source_frame_index"] = "124";
    slot["expected_fingerprint"] = original_fingerprint; slot["replacement_token"] = "second-token";
    auto replaced = Expect(client.Post("/v1/samples/slot", producer, Parts(slot)), 200);
    Check(replaced.at("fingerprint") != original_fingerprint, "slot generation did not change");
    // This mutation used the other transport instance, so its score projection
    // is intentionally stale. Both query and publication must refuse new data.
    Expect(compute.Post("/v1/searches/publish", auth, publish.dump(), "application/json"), 200);
    read["id"] = Id(61);
    auto stale_snapshot = Expect(compute.Post("/v1/searches/read", auth, read.dump(), "application/json"), 200);
    Check(stale_snapshot.at("items").empty() && stale_snapshot.at("coverage") == "partial", "old score bound to replacement image");
    slot["replacement_token"] = "late-token";
    Expect(client.Post("/v1/samples/slot", producer, Parts(slot)), 409);
    cleanup();
    std::cout << "HTTP: auth, bounds, real Mongo, images, coverage, matching, contention, quota and deletion passed (synthetic encoder only)\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; try { cleanup(); } catch (...) {} return 1;
  }
}
