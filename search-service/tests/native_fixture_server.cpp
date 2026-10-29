#include "http_service.hpp"
#include <mongoc/mongoc.h>
#include <openssl/evp.h>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdlib>
#include <iostream>
#include <thread>
#include <unistd.h>
using namespace ainvr::search;
using Json = nlohmann::json;
namespace {
volatile std::sig_atomic_t stop_requested = 0;
void Stop(int) { stop_requested = 1; }
int64_t Now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
std::string Id(int n) { return "00000000-0000-4000-8000-" + std::to_string(100000000000LL + n); }
constexpr const char* token = "ainvr-search-isolated-fixture-token-20261028";
// A fixed 2x2 JPEG prepared on the host as test data. No deployed image path or
// CPU model/image fallback is involved in this transport fixture.
std::vector<uint8_t> Jpeg() {
  const std::string input = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD7h+B3wO+HGofBT4f3V18P/C1zcz+HtPllmm0W2d5Ha2jLMzFMkkkkk0UUV8hi/wDeKn+J/mf0zlv+5UP8EfyR/9k=";
  std::vector<uint8_t> out(input.size() * 3 / 4);
  const int size = EVP_DecodeBlock(out.data(), reinterpret_cast<const unsigned char*>(input.data()), input.size());
  if (size < 1) throw std::runtime_error("invalid_fixture_image");
  size_t padding = 0; for (auto i = input.rbegin(); i != input.rend() && *i == '='; ++i) ++padding;
  out.resize(size_t(size) - padding); return out;
}
class FixtureEncoder final : public TextEncoder {
 public:
  std::string ModelVersion() const override { return "fixture-pair-v1"; }
  size_t Dimensions() const override { return 2; }
  std::vector<float> Encode(const std::string&) override { return {1, 0}; }
};
// A stuck test process cannot survive indefinitely even if a transport/library
// regression prevents graceful shutdown. The owning harness also removes only
// its labeled isolated Mongo container and volumes after any failure.
class ProcessDeadline {
 public:
  ProcessDeadline(): worker_([this] {
    std::unique_lock<std::mutex> lock(mutex_);
    if (!done_.wait_for(lock, std::chrono::seconds(60), [this] { return finished_; })) std::_Exit(124);
  }) {}
  ~ProcessDeadline() {
    { std::lock_guard<std::mutex> lock(mutex_); finished_ = true; }
    done_.notify_one(); worker_.join();
  }
 private:
  std::mutex mutex_; std::condition_variable done_; bool finished_ = false; std::thread worker_;
};
void Drop(const std::string& database) {
  if (database.rfind("ainvr_search_fixture_test_", 0) != 0) throw std::runtime_error("invalid_fixture_database");
  auto client = mongoc_client_new("mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=1000&connectTimeoutMS=1000&socketTimeoutMS=2000");
  if (!client) throw std::runtime_error("fixture_cleanup_client");
  auto db = mongoc_client_get_database(client, database.c_str()); bson_error_t error{};
  const bool ok = mongoc_database_drop(db, &error);
  mongoc_database_destroy(db); mongoc_client_destroy(client);
  if (!ok) throw std::runtime_error("fixture_database_cleanup_failed");
}
}  // namespace
int main() {
  if (!std::getenv("AINVR_SEARCH_TEST_MONGO") || std::string(std::getenv("AINVR_SEARCH_TEST_MONGO")) != "1") {
    std::cerr << "SKIP: isolated fixture not requested\n"; return 77;
  }
  std::signal(SIGTERM, Stop); std::signal(SIGINT, Stop); ProcessDeadline hard_limit;
  const auto database = "ainvr_search_fixture_test_" + std::to_string(Now()) + "_" + std::to_string(getpid());
  bool database_touched = false;
  try {
    HistoryBudget budget; budget.max_samples = 64; budget.max_bytes = 2 * 1024 * 1024; budget.max_searches = 64;
    HistoryMongo history("mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=1000", database, budget);
    database_touched = true; history.Initialize();
    const auto at = Now() - 30000; const auto jpeg = Jpeg();
    for (int n = 0; n < 26; ++n) {
      const bool scene = n >= 24;
      Sample sample{{Id(100 + n), Id(1), scene ? "" : "fixture_processor", "fixture_session", scene ? "" : "track_" + std::to_string(n),
        "fixture-pair-v1", at + 100 + n * 700, scene, {1, float(n) / 26}},
        {{"schema_version", "1.0"}, {"role", "match"}, {"source_input_id", Id(2)}, {"output_channel_id", Id(1)},
         {"input_path", "/live/fixture_input"}, {"output_path", "/live/fixture_output"},
         {"recording_channel_id", Id(3)}, {"stream_session_id", "fixture_session"}, {"source_pts_ns", std::to_string(1000000000LL + n * 700000000LL)},
         {"source_frame_index", std::to_string(n)}, {"frame_id", Id(300 + n)}, {"frame_width", 1920}, {"frame_height", 1080}}, jpeg, Now() + 3600000};
      history.Put(sample);
    }
    // Additional views belong to the existing first object group. The query
    // still has 26 grouped candidates (20+6), now backed by 28 sample rows.
    for(int n=0;n<2;++n){const auto captured=at+(n==0?50:500);
      Sample sample{{Id(2000+n),Id(1),"fixture_processor","fixture_session","track_0","fixture-pair-v1",captured,false,{0,1}},
        {{"schema_version","1.0"},{"role","match"},{"source_input_id",Id(2)},{"output_channel_id",Id(1)},
         {"input_path","/live/fixture_input"},{"output_path","/live/fixture_output"},{"recording_channel_id",Id(3)},
         {"stream_session_id","fixture_session"},{"source_pts_ns",std::to_string(500000000LL+n*1000000000LL)},
         {"source_frame_index",std::to_string(2000+n)},{"frame_id",Id(2300+n)},{"frame_width",1920},{"frame_height",1080}},jpeg,Now()+3600000};
      history.Put(sample);
    }
    const Scope scope{{Id(1)}, at, at + 25000, 60};
    history.PutCoverage(Id(20), "fixture-pair-v1", Id(1), at, at + 25000, false, "sampled", Now() + 3600000);
    history.PutCoverage(Id(21), "fixture-pair-v1", Id(1), at, at + 25000, true, "sampled", Now() + 3600000);
    FixtureEncoder encoder; MatchEngine engine(history, encoder, 64); engine.Rebuild(scope);
    HttpAccess access; access.console_key = token; access.producer_key = std::string(48, 'p');
    access.management_key = std::string(48, 'm'); access.revision = std::string(64, '0');
    access.enabled = true; access.unavailable_reason.clear(); access.ingestion_model = "fixture-pair-v1";
    access.sources.emplace(Id(1), ProducerSource{Id(2), "fixture_processor", Id(3), true, true, "/live/fixture_input", "/live/fixture_output"});
    HttpService service(&history, std::move(access), &engine); httplib::Server server; service.Register(server);
    const int port = server.bind_to_any_port("127.0.0.1");
    if (port < 1) throw std::runtime_error("fixture_bind_failed");
    std::thread listener([&] { server.listen_after_bind(); });
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(45);
    try {
      for (int n = 0; n < 200 && !server.is_running(); ++n) std::this_thread::sleep_for(std::chrono::milliseconds(5));
      if (!server.is_running()) throw std::runtime_error("fixture_start_failed");
      std::cout << Json{{"port", port}, {"from_ms", scope.from_ms}, {"to_ms", scope.to_ms}, {"channel_id", Id(1)},
        {"source_input_id", Id(2)}, {"recording_channel_id", Id(3)}, {"model_version", encoder.ModelVersion()}, {"sample_count", 28},
        {"input_path", "/live/fixture_input"}, {"output_path", "/live/fixture_output"}}.dump() << std::endl;
      while (!stop_requested && server.is_running() && std::chrono::steady_clock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    } catch (...) { server.stop(); listener.join(); throw; }
    server.stop(); listener.join(); Drop(database); database_touched = false;
    return stop_requested ? 0 : 124;
  } catch (const std::exception& error) {
    std::cerr << "search fixture failed: " << error.what() << '\n';
    if (database_touched) try { Drop(database); } catch (...) { std::cerr << "fixture cleanup failed\n"; }
    return 1;
  }
}
