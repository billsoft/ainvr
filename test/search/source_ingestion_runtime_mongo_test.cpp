// Real HistoryMongo + SourceAdmission orchestration in the existing owned Mongo
// fixture. The report callback is ONLY a PG protocol software oracle, not PG I/O.
#include "source_ingestion_runtime.hpp"
#include "sample_contract.hpp"
#include <mongoc/mongoc.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <vector>
#include <unistd.h>
using namespace ainvr::search;
using Json = nlohmann::json;
namespace {
int checks = 0;
void Check(bool value, const char* reason) { ++checks; if (!value) throw std::runtime_error(reason); }
std::string Id(int n) { char value[37]; std::snprintf(value, sizeof(value), "20000000-0000-4000-8000-%012d", n); return value; }
int64_t Now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
const RuntimeModelPin pin{"siglip2-base-full-int8", std::string(64, 'a'), "search-v1-" + std::string(64, 'a')};
constexpr const char* uri = "mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=1000&retryWrites=false";
Sample Make(int index, int64_t at) {
  const auto channel = Id(900);
  return {{Id(index), channel, "processor", "session", "track" + std::to_string(index), pin.model_version, at, false, {1.f, 0.f}},
    {{"role", "match"}, {"input_path", "/live/input"}, {"output_path", "/live/output"},
     {"source_input_id", channel}, {"output_channel_id", channel}, {"recording_channel_id", channel},
     {"schema_version", "1.0"}, {"stream_session_id", "session"}, {"source_pts_ns", std::to_string(at * 1000000LL)},
     {"source_frame_index", std::to_string(index)}, {"frame_id", Id(index)}, {"frame_width", 1920}, {"frame_height", 1080}},
    {255, 216, 255, 217}, at + 60000};
}
RuntimeIngestionGate Gate(int index, int64_t wall) {
  // Same compact sorted channel-ID JSON digest accepted by runtime_config.hpp.
  const auto source_ids_sha256 = SampleSha256(Json::array({Id(900)}).dump());
  return {Id(1000 + index), Id(2000 + index), Id(3000 + index), source_ids_sha256,
    1, wall + 120000, pin};
}
Json Command(mongoc_client_t* client, const std::string& database, const nlohmann::ordered_json& input) {
  bson_error_t error{}; const auto text = input.dump();
  auto command = bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()), -1, &error);
  if (!command) throw std::runtime_error("fixture_command_parse");
  bson_t reply;
  const bool ok = mongoc_client_command_simple(client, database.c_str(), command, nullptr, &reply, &error);
  bson_destroy(command);
  char* raw = bson_as_relaxed_extended_json(&reply, nullptr);
  const auto result = raw ? Json::parse(raw) : Json();
  bson_free(raw); bson_destroy(&reply);
  if (!ok) throw std::runtime_error("fixture_mongo_command_failed");
  return result;
}
Json Marker(mongoc_client_t* client, const std::string& database) {
  const auto rows = Command(client, database, {{"find", "search_control"}, {"filter", {{"_id", "source_writer_epoch"}}},
    {"limit", 2}}).at("cursor").at("firstBatch");
  if (rows.size() != 1) throw std::runtime_error("fixture_writer_marker_missing");
  return rows.at(0);
}
void FailUpdate(mongoc_client_t* client, bool socket) {
  Json data = {{"failCommands", {"update"}}};
  if (socket) data["closeConnection"] = true;
  else data["writeConcernError"] = {{"code", 64}, {"errmsg", "owned runtime WC unknown"}};
  (void)Command(client, "admin", {{"configureFailPoint", "failCommand"}, {"mode", {{"times", 1}}}, {"data", data}});
}
template<class Action> void ExpectFailure(Action action, const std::string& expected, bool prefix = false) {
  std::string actual;
  try { action(); } catch (const std::exception& error) { actual = error.what(); }
  Check(!actual.empty() && (prefix ? actual.rfind(expected, 0) == 0 : actual == expected), "unexpected_or_missing_runtime_failure");
}
void SeedCleanNamespace(HistoryMongo& history) {
  // Only the fixture has FreshNamespaceAuthority; the runtime always uses Denied.
  const auto seed = history.BeginSourceWriterEpoch(Id(99), SourceWriterBootstrap::FreshNamespaceAuthority);
  Check(seed.durable && seed.migration_safe, "fixture_fresh_authority_failed");
  history.Put(Make(100, Now() - 30));
  Check(history.CleanSourceWriterEpoch(Id(99), true).durable, "fixture_seed_not_clean");
}
Json Extent(const Json& extent) {
  return {{"from_ms", extent.at("from_ms")}, {"to_ms", extent.at("to_ms")}, {"high_watermark", extent.at("high_watermark")}};
}

void DrainFrozenAckAndResume(mongoc_client_t* client, const std::string& database) {
  HistoryMongo history(uri, database); history.Initialize(); SeedCleanNamespace(history);
  auto admission = std::make_shared<SourceAdmission>();
  std::vector<std::string> reports;
  Json expected_extent;
  bool lose_ack = true;
  SourceIngestionRuntime runtime(history, admission, {Id(900)}, [&](const Json& report) {
    // Explicit PG protocol oracle: accept the report, then lose the first reply.
    Check(report.at("action") == "acknowledge_pause", "clean_source_was_rejected");
    const auto epoch = history.ReadSourceWriterEpoch();
    Check(epoch && !epoch->dirty && !epoch->uncertainty, "report_preceded_real_clean");
    Check(report.at("observed_extent") == expected_extent, "ACK_H_not_actual_Mongo_extent");
    reports.push_back(report.dump());
    if (lose_ack) { lose_ack = false; throw std::runtime_error("software_oracle_lost_ack"); }
    Check(reports.front() == reports.back(), "unknown_ACK_body_was_not_frozen");
    return Json{{"acknowledged", true}};
  });
  Check(!admission->TryEnter(), "constructor_did_not_seal");
  const auto start = Now(); runtime.Observe(std::nullopt, start);
  const auto running = history.ReadSourceWriterEpoch();
  Check(running && running->dirty && running->owner_uuid != Id(99) && running->resume_after_ms >= start,
    "runtime_opened_without_durable_new_writer");
  auto permit = admission->TryEnter(); Check(bool(permit), "durable_bootstrap_not_admitted");
  const auto gate = Gate(1, Now());
  runtime.Observe(gate, Now());
  Check(reports.empty() && !admission->TryEnter(), "pause_ACK_before_old_permit_drained");
  const auto before_resume = Marker(client, database);
  runtime.Observe(std::nullopt, Now());
  Check(Marker(client, database) == before_resume && reports.empty() && !admission->TryEnter(),
    "resume_began_before_old_permit_drained");
  // A pre-gate admitted handler finishes its actual DB write before releasing.
  const auto late = Make(101, std::max(Now(), start + 1)); history.Put(late);
  Check(history.Get(late.record.id).has_value(), "draining_handler_write_missing");
  expected_extent = Extent(history.MetadataExtent(pin.model_version, {Id(900)}));
  Check(expected_extent.at("high_watermark") == "2", "fixture_H_did_not_include_both_real_samples");
  permit.reset();
  ExpectFailure([&] { runtime.Observe(gate, Now()); }, "software_oracle_lost_ack");
  Check(reports.size() == 1 && !admission->TryEnter(), "lost_ACK_reopened_source");
  const auto clean_marker = Marker(client, database);
  runtime.Observe(gate, Now());
  Check(reports.size() == 2 && reports[0] == reports[1], "ACK_retry_changed_body");
  Check(Marker(client, database) == clean_marker, "ACK_retry_recomputed_Clean_or_H");
  runtime.Observe(gate, Now()); Check(reports.size() == 2, "acknowledged_pause_reported_twice");
  runtime.Observe(gate, gate.expires_ms + 1);
  Check(!admission->TryEnter() && !admission->TryEnter(std::chrono::steady_clock::now() + std::chrono::hours(24)),
    "expired_gate_automatically_reopened_source");
  Check(reports.size() == 2, "expired_gate_generated_new_ACK");
  const auto resume_at = Now(); runtime.Observe(std::nullopt, resume_at);
  const auto resumed = history.ReadSourceWriterEpoch();
  Check(resumed && resumed->dirty && resumed->owner_uuid != running->owner_uuid && resumed->resume_after_ms >= resume_at,
    "trusted_resume_reused_clean_epoch_or_lost_capture_boundary");
  auto resumed_permit = admission->TryEnter(); Check(bool(resumed_permit), "trusted_durable_resume_remained_closed");
  auto old = Make(102, resumed->resume_after_ms - 1);
  ExpectFailure([&] { history.Put(old); }, "source_frame_before_resume");
  Check(!history.Get(old.record.id), "old_frame_replayed_into_new_epoch");
  const auto fresh = Make(103, resumed->resume_after_ms + 1); history.Put(fresh);
  Check(history.Get(fresh.record.id).has_value(), "new_epoch_rejected_fresh_frame");
  resumed_permit.reset(); runtime.Stop();
  Check(!admission->TryEnter() && !history.ReadSourceWriterEpoch()->dirty, "Stop_not_drained_and_clean");
}

void LegacyCannotAcknowledge(const std::string& database) {
  HistoryMongo history(uri, database); history.Initialize(); history.Put(Make(200, Now() - 20));
  auto admission = std::make_shared<SourceAdmission>();
  std::vector<Json> reports;
  SourceIngestionRuntime runtime(history, admission, {Id(900)}, [&](const Json& report) {
    reports.push_back(report); return Json{{"rejected", true}};
  });
  runtime.Observe(std::nullopt, Now());
  Check(history.ReadSourceWriterEpoch()->previous_unclean, "legacy_namespace_acquired_Fresh_authority");
  const auto gate = Gate(2, Now()); runtime.Observe(gate, Now());
  Check(reports.size() == 1 && reports[0].at("action") == "pause_rejected" &&
    reports[0].at("error_code") == "legacy_bootstrap_required", "legacy_runtime_did_not_report_fixed_negative");
  Check(!reports[0].contains("observed_extent") && !reports[0].contains("high_watermark"), "legacy_negative_fabricated_H");
  Check(!admission->TryEnter() && history.ReadSourceWriterEpoch()->dirty, "legacy_rejection_opened_or_cleaned_source");
  runtime.Stop();
}

void UnknownBeginStaysClosed(mongoc_client_t* client, const std::string& database, bool socket) {
  HistoryMongo history(uri, database); history.Initialize(); SeedCleanNamespace(history);
  auto admission = std::make_shared<SourceAdmission>(); size_t reports = 0;
  SourceIngestionRuntime runtime(history, admission, {Id(900)}, [&](const Json&) { ++reports; return Json{{"acknowledged", true}}; });
  FailUpdate(client, socket);
  ExpectFailure([&] { runtime.Observe(std::nullopt, Now()); }, socket ? "search_history_error_" : "search_history_error_16_64", socket);
  Check(!admission->TryEnter() && reports == 0, "Unknown_Begin_opened_or_ACKed");
  const auto unknown = history.ReadSourceWriterEpoch();
  if (!socket) Check(unknown && unknown->dirty && unknown->owner_uuid != Id(99), "WC_Begin_did_not_actually_commit");
  ExpectFailure([&] { history.Put(Make(300, Now())); }, "source_writer_closed");
  Check(!history.Get(Id(300)), "unknown_Begin_accepted_source_write");
  const auto resume_at = Now(); runtime.Observe(std::nullopt, resume_at);
  const auto confirmed = history.ReadSourceWriterEpoch();
  Check(confirmed && confirmed->dirty && confirmed->owner_uuid != Id(99) && confirmed->resume_after_ms >= resume_at,
    "Begin_recovery_did_not_confirm_new_epoch");
  if (!socket) Check(confirmed->owner_uuid == unknown->owner_uuid, "Begin_unknown_retry_changed_candidate_owner");
  Check(bool(admission->TryEnter()), "durable_Begin_recovery_not_admitted"); runtime.Stop();
}

void UnknownCleanCannotReportH(mongoc_client_t* client, const std::string& database, bool socket) {
  HistoryMongo history(uri, database); history.Initialize(); SeedCleanNamespace(history);
  auto admission = std::make_shared<SourceAdmission>(); std::vector<Json> reports;
  SourceIngestionRuntime runtime(history, admission, {Id(900)}, [&](const Json& report) {
    Check(!history.ReadSourceWriterEpoch()->dirty, "Clean_unknown_reported_before_ACK_recovery");
    reports.push_back(report); return Json{{"acknowledged", true}};
  });
  runtime.Observe(std::nullopt, Now()); const auto gate = Gate(socket ? 4 : 3, Now());
  FailUpdate(client, socket);
  ExpectFailure([&] { runtime.Observe(gate, Now()); }, socket ? "search_history_error_" : "search_history_error_16_64", socket);
  Check(reports.empty() && !admission->TryEnter(), "Unknown_Clean_published_H_or_reopened_admission");
  if (!socket) Check(!history.ReadSourceWriterEpoch()->dirty, "WC_Clean_did_not_commit_before_unknown_ACK");
  ExpectFailure([&] { history.Put(Make(400, Now())); }, "source_writer_closed");
  Check(!history.Get(Id(400)), "Unknown_Clean_accepted_late_source");
  runtime.Observe(gate, Now());
  Check(reports.size() == 1 && reports[0].at("action") == "acknowledge_pause" &&
    reports[0].at("observed_extent") == Extent(history.MetadataExtent(pin.model_version, {Id(900)})),
    "Clean_ACK_recovery_failed_to_report_actual_H");
  Check(!admission->TryEnter(), "Clean_ACK_recovery_reopened_source"); runtime.Stop();
}
} // namespace

int main() {
  if (!std::getenv("AINVR_SEARCH_TEST_MONGO")) return 77;
  try {
    mongoc_init(); auto client = mongoc_client_new(uri); Check(client != nullptr, "fixture_client");
    std::vector<std::string> databases;
    const auto database = [&](const char* suffix) {
      auto name = "ainvr_ingestion_runtime_" + std::to_string(getpid()) + "_" + suffix;
      databases.push_back(name); return name;
    };
    const auto cleanup = [&] {
      for (const auto& name : databases) (void)Command(client, name, {{"dropDatabase", 1}});
      mongoc_client_destroy(client);
    };
    try {
      DrainFrozenAckAndResume(client, database("drain_resume"));
      LegacyCannotAcknowledge(database("legacy"));
      UnknownBeginStaysClosed(client, database("begin_wc"), false);
      UnknownBeginStaysClosed(client, database("begin_socket"), true);
      UnknownCleanCannotReportH(client, database("clean_wc"), false);
      UnknownCleanCannotReportH(client, database("clean_socket"), true);
    } catch (...) { cleanup(); throw; }
    cleanup();
    std::cout << checks << " runtime real-Mongo/admission checks passed across drain/frozen-ACK/expiry/resume, legacy and Begin/Clean WC/socket scenarios; "
      "report callback is a PG protocol software oracle only; no PG/BPU/production\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
