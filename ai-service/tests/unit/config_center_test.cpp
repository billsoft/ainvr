// Copyright AINVR. Adapted for the S100P service.
// 对应 shared/python/config_center_client.py + config_center_apply.py。
// ConfigCenterClient 用一个真实 httplib server 模拟 BFF 端点做端到端
// 测试(轮询 desiredVersion -> 拉快照 -> 应用 -> 上报),比只测内部函数
// 更能捕获协议拼接上的问题。
#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <fstream>
#include <future>
#include <mutex>
#include <httplib.h>
#include <thread>

#include "../../src/config/config_center_apply.hpp"
#include "../../src/config/config_center_client.hpp"

using namespace ai_service::config;
using nlohmann::json;

// ---- ServiceTokenEnvName ----

TEST(ConfigCenter, ServiceTokenEnvNameConvention) {
  EXPECT_EQ(ServiceTokenEnvName("ai-service"), "CONFIG_SERVICE_TOKEN_AI_SERVICE");
  EXPECT_EQ(ServiceTokenEnvName("recorder"), "CONFIG_SERVICE_TOKEN_RECORDER");
}

// ---- ApplyConfigCenterPatch 边界规则 ----

namespace {
std::filesystem::path MakeBasePath(const std::filesystem::path& dir) {
  std::filesystem::create_directories(dir / "config");
  std::filesystem::path base_path = dir / "config" / "config.yaml";
  std::ofstream f(base_path);
  f << "server:\n  port: 8000\nchannels: []\n";
  return base_path;
}

struct StoreFixture {
  std::filesystem::path dir;
  std::filesystem::path base_path;
  std::filesystem::path overlay_path;
  ConfigStore store;

  StoreFixture()
      : dir(std::filesystem::temp_directory_path() /
            ("cctest_" + std::to_string(reinterpret_cast<uintptr_t>(this)))),
        base_path(MakeBasePath(dir)),
        overlay_path(dir / "data" / "config_overlay.json"),
        store(base_path, overlay_path) {}
  // 测试产物不留在 /tmp(之前每跑一次留一个目录)。
  ~StoreFixture() {
    std::error_code ec;
    std::filesystem::remove_all(dir, ec);
  }
};
}  // namespace

TEST(ConfigCenterApply, RejectsChannelsSegment) {
  StoreFixture fx;
  json patch = {{"channels", json::array()}};
  EXPECT_THROW(ApplyConfigCenterPatch(fx.store, patch), ConfigApplyError);
}

TEST(ConfigCenterApply, RejectsUnknownTopLevelSegment) {
  StoreFixture fx;
  json patch = {{"made_up_segment", json::object()}};
  EXPECT_THROW(ApplyConfigCenterPatch(fx.store, patch), ConfigApplyError);
}

TEST(ConfigCenterApply, RejectsServerHostAndPort) {
  StoreFixture fx;
  json patch = {{"server", {{"host", "0.0.0.0"}}}};
  EXPECT_THROW(ApplyConfigCenterPatch(fx.store, patch), ConfigApplyError);

  json patch2 = {{"server", {{"port", 9000}}}};
  EXPECT_THROW(ApplyConfigCenterPatch(fx.store, patch2), ConfigApplyError);
}

TEST(ConfigCenterApply, RejectsUnknownServerField) {
  StoreFixture fx;
  json patch = {{"server", {{"made_up_field", 1}}}};
  EXPECT_THROW(ApplyConfigCenterPatch(fx.store, patch), ConfigApplyError);
}

TEST(ConfigCenterApply, AcceptsLogLevelAndApiKey) {
  StoreFixture fx;
  json patch = {{"server", {{"log_level", "debug"}, {"api_key", "secret"}}}};
  AppConfig cfg = ApplyConfigCenterPatch(fx.store, patch);
  EXPECT_EQ(cfg.server.log_level, "debug");
  EXPECT_EQ(cfg.server.api_key, "secret");
}

TEST(ConfigCenterApply, AcceptsSnapshotStoreNonRestartFields) {
  StoreFixture fx;
  json patch = {{"snapshot_store", {{"mongo_host", "192.168.1.1"}, {"mongo_port", 27018}}}};
  AppConfig cfg = ApplyConfigCenterPatch(fx.store, patch);
  EXPECT_EQ(cfg.snapshot_store.mongo_host, "192.168.1.1");
}

// ---- SnapshotStoreRestartRequired ----

TEST(SnapshotStoreRestartRequired, TrueWhenMongoUriChanges) {
  AppConfig old_cfg;
  old_cfg.snapshot_store.mongo_uri = "mongodb://old/";
  json patch = {{"snapshot_store", {{"mongo_uri", "mongodb://new/"}}}};
  EXPECT_TRUE(SnapshotStoreRestartRequired(old_cfg, patch));
}

TEST(SnapshotStoreRestartRequired, FalseWhenValueUnchanged) {
  // §1.4 强调的一点:按值比较,不是"字段出现在 patch 里就算变了"——控制台
  // 每次保存都会把 snapshot_store 整段重新提交,值没变时不该误报需要重启。
  AppConfig old_cfg;
  old_cfg.snapshot_store.mongo_uri = "mongodb://same/";
  json patch = {{"snapshot_store", {{"mongo_uri", "mongodb://same/"}}}};
  EXPECT_FALSE(SnapshotStoreRestartRequired(old_cfg, patch));
}

TEST(SnapshotStoreRestartRequired, FalseWhenOnlyNonRestartFieldsChange) {
  AppConfig old_cfg;
  json patch = {{"snapshot_store", {{"mongo_host", "1.2.3.4"}}}};
  EXPECT_FALSE(SnapshotStoreRestartRequired(old_cfg, patch));
}

TEST(SnapshotStoreRestartRequired, FalseWhenNoSnapshotStoreSegment) {
  AppConfig old_cfg;
  json patch = {{"server", {{"log_level", "debug"}}}};
  EXPECT_FALSE(SnapshotStoreRestartRequired(old_cfg, patch));
}

// ---- ConfigCenterClient 端到端(模拟 BFF) ----

namespace {
// 极简 BFF 模拟:一个 desiredVersion=1 的服务视图,一个包含
// ai-service/system/settings 文档的版本快照,一个记录收到过的上报请求
// 的 /service-states POST 端点。
class FakeBff {
 public:
  void SetUp() {
    server_.Get("/api/v1/config/service-states/ai-service",
               [this](const httplib::Request&, httplib::Response& res) {
                 json body{{"code", 0}, {"data", {{"desiredVersion", desired_version_}}}};
                 res.set_content(body.dump(), "application/json");
               });
    server_.Get("/api/v1/config/versions/1/snapshot",
               [](const httplib::Request&, httplib::Response& res) {
                 json body{{"code", 0},
                           {"data",
                            json::array({{{"service", "ai-service"},
                                          {"group", "system"},
                                          {"name", "settings"},
                                          {"config", {{"server", {{"log_level", "debug"}}}}}}})}};
                 res.set_content(body.dump(), "application/json");
               });
    server_.Post("/api/v1/config/service-states/ai-service",
                [this](const httplib::Request& req, httplib::Response& res) {
                  received_reports_.push_back(json::parse(req.body));
                  received_headers_.push_back(req.get_header_value("X-Service-Token"));
                  json body{{"code", 0}, {"data", json::object()}};
                  res.set_content(body.dump(), "application/json");
                });
    port_ = server_.bind_to_any_port("127.0.0.1");
    thread_ = std::thread([this] { server_.listen_after_bind(); });
    for (int i = 0; i < 50 && !server_.is_running(); ++i) {
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
  }
  void TearDown() {
    server_.stop();
    if (thread_.joinable()) thread_.join();
  }

  std::string BaseUrl() const { return "http://127.0.0.1:" + std::to_string(port_); }

  httplib::Server server_;
  int port_ = 0;
  std::thread thread_;
  int desired_version_ = 1;
  std::vector<json> received_reports_;
  std::vector<std::string> received_headers_;
};
}  // namespace

TEST(ConfigCenterClientEndToEnd, PollsAppliesAndReportsSuccess) {
  FakeBff bff;
  bff.SetUp();

  std::atomic<int> apply_calls{0};
  json last_applied_config;
  ApplyCallback on_apply = [&](const json& cfg) -> ApplyResult {
    apply_calls++;
    last_applied_config = cfg;
    return {true, false};
  };

  ConfigCenterClient client(bff.BaseUrl(), "ai-service", "test-token-123", on_apply,
                            /*poll_interval_seconds=*/1);
  client.Start();

  for (int i = 0; i < 50 && apply_calls.load() == 0; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  client.Stop();

  EXPECT_EQ(apply_calls.load(), 1);
  EXPECT_EQ(last_applied_config["server"]["log_level"], "debug");
  ASSERT_TRUE(client.AppliedVersion().has_value());
  EXPECT_EQ(*client.AppliedVersion(), 1);

  ASSERT_FALSE(bff.received_reports_.empty());
  auto& report = bff.received_reports_.back();
  EXPECT_EQ(report["status"], "applied");
  EXPECT_EQ(report["appliedVersion"], 1);
  EXPECT_FALSE(bff.received_headers_.back().empty());
  EXPECT_EQ(bff.received_headers_.back(), "test-token-123");

  bff.TearDown();
}

TEST(ConfigCenterClientEndToEnd, SkipsReapplyWhenVersionUnchanged) {
  FakeBff bff;
  bff.SetUp();

  std::atomic<int> apply_calls{0};
  ApplyCallback on_apply = [&](const json&) -> ApplyResult {
    apply_calls++;
    return {true, false};
  };

  ConfigCenterClient client(bff.BaseUrl(), "ai-service", "", on_apply, 1);
  client.Start();
  for (int i = 0; i < 50 && apply_calls.load() == 0; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  // 再等一轮:desiredVersion 没变,不应该重复 apply。
  std::this_thread::sleep_for(std::chrono::milliseconds(1500));
  client.Stop();

  EXPECT_EQ(apply_calls.load(), 1);
  bff.TearDown();
}

TEST(ConfigCenterClientEndToEnd, ClientFromEnvReturnsNullWithoutUrl) {
  // 测试环境不太可能设置 CONFIG_CENTER_URL,如实验证禁用路径。
  unsetenv("CONFIG_CENTER_URL");
  auto client = ClientFromEnv("ai-service", [](const json&) -> ApplyResult { return {true, false}; });
  EXPECT_EQ(client, nullptr);
}


// ---- Search producer projection on the SAME configuration owner/poll ----
namespace {
const std::string kProducerSecret = "b" + std::string(63, '7');
std::string ProducerId(int n) { return "00000000-0000-4000-8000-00000000000" + std::to_string(n); }
json ActiveProducerGrant() {
  return {{"enabled", true}, {"reason", nullptr}, {"endpoint", "http://127.0.0.1:8400"},
    {"api_token", kProducerSecret}, {"revision", std::string(64, 'a')}, {"model", {{"package_id", "candidate-package"}}},
    {"valid_for_ms", 30000}, {"limits", {{"producer_queue", 1}, {"producer_bytes", 134217728},
      {"image_max_bytes", 8388608}, {"retention_days", 30}}},
    {"sampling", {{"mode", "all"}, {"channel_ids", json::array()}, {"object", true}, {"scene", true},
      {"object_interval_ms", 1000}, {"scene_active_interval_ms", 10000}, {"scene_static_interval_ms", 60000},
      {"scene_change_min_interval_ms", 3000}, {"track_slots", 8}}},
    {"sources", json::array({{{"channel_id", ProducerId(2)}, {"input_stream_id", ProducerId(1)},
      {"processor_id", "processor"}, {"recording_channel_id", ProducerId(2)},
      {"input_path", "/live/intermediate-ai"}, {"output_path", "/live/result"}, {"object", true}, {"scene", true}}})}};
}
json InactiveProducerGrant(const std::string& reason = "config_pending") {
  return {{"enabled", false}, {"reason", reason}, {"endpoint", nullptr}, {"api_token", nullptr}, {"revision", nullptr},
    {"model", {{"package_id", nullptr}}}, {"sampling", nullptr}, {"sources", json::array()},
    {"valid_for_ms", 0}, {"limits", nullptr}};
}
bool Await(const std::function<bool()>& predicate, int milliseconds = 3500) {
  const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(milliseconds);
  while (std::chrono::steady_clock::now() < until) {
    if (predicate()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  return predicate();
}
class ProducerBff {
 public:
  explicit ProducerBff(std::function<void(int)> before_response = {}): before_response_(std::move(before_response)) {}
  ~ProducerBff() { server_.stop(); if (thread_.joinable()) thread_.join(); }
  void Start() {
    server_.Get(R"(/api/v1/config/service-states/(ai-service|recorder))", [this](const auto&, auto& response) {
      ++config_reads; response.set_content(json{{"code", 0}, {"data", {{"desiredVersion", 1}}}}.dump(), "application/json");
    });
    server_.Get("/api/v1/config/versions/1/snapshot", [](const auto& request, auto& response) {
      response.set_content(json{{"code", 0}, {"data", json::array({{{"service", request.get_param_value("service")},
        {"group", "system"}, {"name", "settings"}, {"config", {{"server", {{"log_level", "debug"}}}}}}})}}.dump(), "application/json");
    });
    server_.Post(R"(/api/v1/config/service-states/(ai-service|recorder))", [](const auto&, auto& response) {
      response.set_content(json{{"code", 0}, {"data", json::object()}}.dump(), "application/json");
    });
    server_.Get("/api/internal/search/producer-config", [this](const auto& request, auto& response) {
      const int call = ++producer_reads;
      { std::lock_guard<std::mutex> lock(mutex_); received_token_ = request.get_header_value("X-Service-Token"); }
      if (request.get_header_value("X-Service-Token") != "ai-config-only") {
        response.status = 403;
        response.set_content("{\"error\":\"private-producer-secret-SENTINEL\"}", "application/json"); return;
      }
      if (before_response_) before_response_(call);
      std::string body, mime;
      { std::lock_guard<std::mutex> lock(mutex_); body = body_; mime = mime_; }
      response.set_content(body, mime.c_str());
    });
    port_ = server_.bind_to_any_port("127.0.0.1");
    if (port_ <= 0) throw std::runtime_error("fixture bind failed");
    thread_ = std::thread([this] { server_.listen_after_bind(); });
    if (!Await([&] { return server_.is_running(); })) throw std::runtime_error("fixture start failed");
  }
  void Set(const json& document) { SetRaw(document.dump(), "application/json"); }
  void SetRaw(std::string body, std::string mime = "application/json") {
    std::lock_guard<std::mutex> lock(mutex_); body_ = std::move(body); mime_ = std::move(mime);
  }
  std::string BaseUrl() const { return "http://127.0.0.1:" + std::to_string(port_); }
  std::string ReceivedToken() { std::lock_guard<std::mutex> lock(mutex_); return received_token_; }
  std::atomic<int> producer_reads{0}, config_reads{0};
 private:
  httplib::Server server_;
  std::thread thread_;
  int port_ = 0;
  std::mutex mutex_;
  std::string body_ = ActiveProducerGrant().dump(), mime_ = "application/json", received_token_;
  std::function<void(int)> before_response_;
};
}  // namespace

TEST(SearchProducerGrant, StrictProjectionAndRootVersusActualPath) {
  auto document = ActiveProducerGrant(); const auto parsed = ParseSearchProducerGrant(document);
  ASSERT_TRUE(parsed.grant); EXPECT_EQ(parsed.valid_for.count(), 30000);
  EXPECT_EQ(parsed.grant->limits.producer_queue, 1); EXPECT_EQ(parsed.grant->limits.producer_bytes, 134217728);
  EXPECT_EQ(parsed.grant->limits.image_max_bytes, 8388608); EXPECT_EQ(parsed.grant->limits.retention_days, 30);
  const auto& source = parsed.grant->sources.at("processor");
  EXPECT_EQ(source.input_stream_id, ProducerId(1)); EXPECT_EQ(source.input_path, "/live/intermediate-ai");
  EXPECT_EQ(source.output_path, "/live/result"); EXPECT_EQ(source.recording_channel_id, source.channel_id);
  auto second = document.at("sources")[0]; second["processor_id"] = "processor-2";
  second["channel_id"] = ProducerId(3); second["recording_channel_id"] = ProducerId(3); second["output_path"] = "/live/result-2";
  document["sources"].push_back(second);
  EXPECT_EQ(ParseSearchProducerGrant(document).grant->sources.size(), 2); // Shared original input is allowed.
  second["processor_id"] = "processor"; document["sources"][1] = second;
  EXPECT_THROW(ParseSearchProducerGrant(document), std::invalid_argument);
  for (const auto& mutate : std::vector<std::function<void(json&)>>{
    [](auto& j) { j["limits"]["producer_queue"] = 5; }, [](auto& j) { j["limits"]["producer_bytes"] = 8388607; },
    [](auto& j) { j["limits"]["image_max_bytes"] = 8388609; }, [](auto& j) { j["limits"]["retention_days"] = 366; },
    [](auto& j) { j["sources"][0]["input_path"] = "rtmp://127.0.0.1/live/a"; },
    [](auto& j) { j["sources"][0]["output_path"] = "/live/a?token=secret"; },
    [](auto& j) { j["endpoint"] = "http://untrusted:8400"; }, [](auto& j) { j["valid_for_ms"] = 30001; },
    [](auto& j) { j["model"]["package_id"] = "../package"; }, [](auto& j) { j["revision"] = "not-a-revision"; },
    [](auto& j) { j["sources"][0]["recording_channel_id"] = ProducerId(1); },
    [](auto& j) { j["sources"][0]["unexpected"] = true; }}) {
    auto bad = ActiveProducerGrant(); mutate(bad); EXPECT_THROW(ParseSearchProducerGrant(bad), std::invalid_argument);
  }
  auto annual = ActiveProducerGrant(); annual["limits"]["retention_days"] = 365;
  EXPECT_EQ(ParseSearchProducerGrant(annual).grant->limits.retention_days, 365);
  for (const auto* reason : {"disabled", "config_pending"}) {
    auto inactive = InactiveProducerGrant(reason); const auto no_grant = ParseSearchProducerGrant(inactive);
    EXPECT_FALSE(no_grant.grant); EXPECT_EQ(no_grant.valid_for.count(), 0);
    inactive["api_token"] = kProducerSecret; EXPECT_THROW(ParseSearchProducerGrant(inactive), std::invalid_argument);
  }
}

TEST(SearchProducerGrant, WorkerReaderRetainsOnlyWeakAuthorityAndSurvivesClientDestruction) {
  ProducerBff bff; bff.Start();
  SearchProducerLeaseReader reader;
  std::optional<SearchProducerLease> retained;
  {
    auto client = std::make_unique<ConfigCenterClient>(bff.BaseUrl(), "ai-service", "ai-config-only",
      [](const json&) { return ApplyResult{true, false}; }, 1);
    reader = client->SearchProducerReader(); ASSERT_TRUE(reader); EXPECT_FALSE(reader());
    client->Start(); ASSERT_TRUE(Await([&] { return reader().has_value(); }));
    retained = reader(); ASSERT_TRUE(retained); EXPECT_TRUE(retained->IsCurrent());
    client->Stop(); EXPECT_FALSE(reader()); EXPECT_FALSE(retained->IsCurrent());
    client->Start(); ASSERT_TRUE(Await([&] { return reader().has_value(); }));
    retained = reader();
  }
  EXPECT_FALSE(reader()); ASSERT_TRUE(retained); EXPECT_FALSE(retained->IsCurrent());
  ConfigCenterClient recorder(bff.BaseUrl(), "recorder", "unrelated", [](const json&) { return ApplyResult{true, false}; }, 1);
  EXPECT_FALSE(recorder.SearchProducerReader());
}

TEST(SearchProducerGrant, SharedAuthorityExpiryRenewalAndPersistentSameRevisionRejection) {
  std::atomic<int64_t> milliseconds{0};
  const auto clock = [&] { return std::chrono::steady_clock::time_point(std::chrono::milliseconds(milliseconds.load())); };
  auto authority = std::make_shared<SearchProducerGrantAuthority>(clock); authority->Start();
  const auto parsed = ParseSearchProducerGrant(ActiveProducerGrant());
  ASSERT_TRUE(authority->Install(parsed, clock())); auto old = authority->Read(); ASSERT_TRUE(old);
  milliseconds = 20000; ASSERT_TRUE(authority->Install(parsed, clock())); auto renewed = authority->Read(); ASSERT_TRUE(renewed);
  EXPECT_EQ(renewed->fence, old->fence); EXPECT_EQ(renewed->grant, old->grant); EXPECT_TRUE(old->IsCurrent());
  milliseconds = 49999; EXPECT_TRUE(old->IsCurrent()); milliseconds = 50000;
  EXPECT_FALSE(old->IsCurrent()); EXPECT_FALSE(authority->Read());
  auto changed = ActiveProducerGrant(); changed["limits"]["producer_bytes"] = 67108864;
  EXPECT_FALSE(authority->Install(ParseSearchProducerGrant(changed), clock()));
  EXPECT_FALSE(authority->Install(ParseSearchProducerGrant(changed), clock()));
  EXPECT_FALSE(authority->Read());
  changed["revision"] = std::string(64, 'c'); ASSERT_TRUE(authority->Install(ParseSearchProducerGrant(changed), clock()));
  auto latest = authority->Read(); ASSERT_TRUE(latest); EXPECT_TRUE(latest->IsCurrent()); EXPECT_NE(latest->fence, old->fence);
  authority->Stop(); EXPECT_FALSE(latest->IsCurrent()); EXPECT_FALSE(authority->Install(parsed, clock()));
  EXPECT_FALSE(authority->Read());
  authority->Start(); ASSERT_TRUE(authority->Install(ParseSearchProducerGrant(changed), clock()));
  const auto before_gap = authority->Read(); ASSERT_TRUE(before_gap);
  milliseconds = 81000; ASSERT_TRUE(authority->Install(ParseSearchProducerGrant(changed), clock()));
  const auto after_gap = authority->Read(); ASSERT_TRUE(after_gap);
  EXPECT_NE(after_gap->fence, before_gap->fence); EXPECT_FALSE(before_gap->IsCurrent());
}

TEST(ConfigSearchProducer, RefreshesWithUnchangedConfigAndUsesOnlyAiConfigurationIdentity) {
  ProducerBff bff; bff.Start(); std::atomic<int> applies{0};
  ConfigCenterClient client(bff.BaseUrl(), "ai-service", "ai-config-only", [&](const json&) { ++applies; return ApplyResult{true, false}; }, 1);
  client.Start(); ASSERT_TRUE(Await([&] { return client.GetSearchProducerGrant().has_value(); }));
  const auto old = client.GetSearchProducerGrant(); ASSERT_TRUE(old);
  ASSERT_TRUE(Await([&] {
    const auto current = client.GetSearchProducerGrant();
    return current && current->valid_until > old->valid_until;
  }));
  const auto next = client.GetSearchProducerGrant(); ASSERT_TRUE(next);
  EXPECT_EQ(next->grant, old->grant); EXPECT_EQ(next->fence, old->fence); EXPECT_GT(next->valid_until, old->valid_until);
  EXPECT_EQ(applies.load(), 1); EXPECT_GE(bff.config_reads.load(), 2); EXPECT_EQ(bff.ReceivedToken(), "ai-config-only");
  EXPECT_NE(bff.ReceivedToken(), kProducerSecret); EXPECT_EQ(next->grant->sources.at("processor").input_path, "/live/intermediate-ai");
  client.Stop(); EXPECT_FALSE(old->IsCurrent()); EXPECT_FALSE(client.GetSearchProducerGrant());
}

TEST(ConfigSearchProducer, DisabledPendingAndMutationImmediatelyRevokeRetainedLeases) {
  ProducerBff bff; bff.Start(); ConfigCenterClient client(bff.BaseUrl(), "ai-service", "ai-config-only", {}, 1);
  client.Start(); ASSERT_TRUE(Await([&] { return client.GetSearchProducerGrant().has_value(); }));
  auto retained = client.GetSearchProducerGrant(); ASSERT_TRUE(retained);
  bff.Set(InactiveProducerGrant("disabled")); ASSERT_TRUE(Await([&] { return !retained->IsCurrent(); }));
  EXPECT_FALSE(client.GetSearchProducerGrant()); bff.Set(ActiveProducerGrant());
  ASSERT_TRUE(Await([&] { return client.GetSearchProducerGrant().has_value(); }));
  retained = client.GetSearchProducerGrant(); bff.Set(InactiveProducerGrant());
  ASSERT_TRUE(Await([&] { return !retained->IsCurrent(); })); EXPECT_FALSE(client.GetSearchProducerGrant());
  bff.Set(ActiveProducerGrant()); ASSERT_TRUE(Await([&] { return client.GetSearchProducerGrant().has_value(); }));
  retained = client.GetSearchProducerGrant(); auto changed = ActiveProducerGrant(); changed["limits"]["producer_bytes"] = 67108864;
  bff.Set(changed); ASSERT_TRUE(Await([&] { return !retained->IsCurrent(); }));
  const int revoked_at = bff.producer_reads.load();
  ASSERT_TRUE(Await([&] { return bff.producer_reads > revoked_at; })); EXPECT_FALSE(client.GetSearchProducerGrant());
  client.Stop();
}

TEST(ConfigSearchProducer, ThirtySecondDeadlineStartsBeforeHttpResponse) {
  std::atomic<int64_t> milliseconds{0};
  ProducerBff bff([&](int) { milliseconds = 20000; }); bff.Start();
  ConfigCenterClient client(bff.BaseUrl(), "ai-service", "ai-config-only", {}, 60, [&] {
    return std::chrono::steady_clock::time_point(std::chrono::milliseconds(milliseconds.load()));
  });
  client.Start(); ASSERT_TRUE(Await([&] { return client.GetSearchProducerGrant().has_value(); }));
  const auto retained = client.GetSearchProducerGrant(); ASSERT_TRUE(retained);
  EXPECT_EQ(std::chrono::duration_cast<std::chrono::milliseconds>(retained->valid_until.time_since_epoch()).count(), 30000);
  milliseconds = 29999; EXPECT_TRUE(retained->IsCurrent()); milliseconds = 30000;
  EXPECT_FALSE(retained->IsCurrent()); EXPECT_FALSE(client.GetSearchProducerGrant()); client.Stop();
}

TEST(ConfigSearchProducer, StopCannotReinstallADelayedResponse) {
  std::promise<void> entered, release; auto gate = release.get_future().share();
  ProducerBff bff([&](int call) { if (call == 2) { entered.set_value(); gate.wait_for(std::chrono::seconds(2)); } }); bff.Start();
  ConfigCenterClient client(bff.BaseUrl(), "ai-service", "ai-config-only", {}, 1); client.Start();
  ASSERT_TRUE(Await([&] { return client.GetSearchProducerGrant().has_value(); })); auto retained = client.GetSearchProducerGrant();
  ASSERT_EQ(entered.get_future().wait_for(std::chrono::seconds(3)), std::future_status::ready);
  auto stopped = std::async(std::launch::async, [&] { client.Stop(); });
  EXPECT_TRUE(Await([&] { return !retained->IsCurrent(); }, 300)); release.set_value(); stopped.get();
  EXPECT_FALSE(client.GetSearchProducerGrant()); EXPECT_FALSE(retained->IsCurrent());
}

TEST(ConfigSearchProducer, NonAiClientNeverFetchesAndWrongIdentityNeverObtainsGrant) {
  ProducerBff bff; bff.Start(); ConfigCenterClient recorder(bff.BaseUrl(), "recorder", "ai-config-only", {}, 1);
  recorder.Start(); ASSERT_TRUE(Await([&] { return bff.config_reads >= 2; })); recorder.Stop();
  EXPECT_EQ(bff.producer_reads.load(), 0); EXPECT_FALSE(recorder.GetSearchProducerGrant());
  ConfigCenterClient wrong(bff.BaseUrl(), "ai-service", "wrong-config-token", {}, 60); wrong.Start();
  ASSERT_TRUE(Await([&] { return bff.producer_reads >= 1; })); wrong.Stop(); EXPECT_FALSE(wrong.GetSearchProducerGrant());
}

TEST(ConfigSearchProducer, BoundedInvalidResponsesAndLogsNeverContainPayloadSecrets) {
  ProducerBff bff; bff.Start(); ConfigCenterClient client(bff.BaseUrl(), "ai-service", "ai-config-only", {}, 1);
  client.Start(); ASSERT_TRUE(Await([&] { return client.GetSearchProducerGrant().has_value(); }));
  auto retained = client.GetSearchProducerGrant();
  bff.SetRaw("{\"api_token\":\"private-producer-secret-SENTINEL\",\"broken\":");
  testing::internal::CaptureStderr(); const bool rejected = Await([&] { return !retained->IsCurrent(); });
  const auto errors = testing::internal::GetCapturedStderr(); EXPECT_TRUE(rejected);
  EXPECT_EQ(errors.find("private-producer-secret-SENTINEL"), std::string::npos);
  EXPECT_EQ(errors.find(kProducerSecret), std::string::npos); EXPECT_EQ(errors.find(bff.BaseUrl()), std::string::npos);
  bff.Set(ActiveProducerGrant()); ASSERT_TRUE(Await([&] { return client.GetSearchProducerGrant().has_value(); })); retained = client.GetSearchProducerGrant();
  bff.SetRaw("{\"x\":" + std::string(18, '[') + "0" + std::string(18, ']') + "}");
  ASSERT_TRUE(Await([&] { return !retained->IsCurrent(); })); EXPECT_FALSE(client.GetSearchProducerGrant());
  bff.Set(ActiveProducerGrant()); ASSERT_TRUE(Await([&] { return client.GetSearchProducerGrant().has_value(); })); retained = client.GetSearchProducerGrant();
  bff.SetRaw("\"" + std::string(8 * 1024 * 1024 + 1, 'x') + "\"");
  ASSERT_TRUE(Await([&] { return !retained->IsCurrent(); })); EXPECT_FALSE(client.GetSearchProducerGrant());
  bff.Set(ActiveProducerGrant()); ASSERT_TRUE(Await([&] { return client.GetSearchProducerGrant().has_value(); })); retained = client.GetSearchProducerGrant();
  bff.SetRaw(ActiveProducerGrant().dump(), "text/plain");
  ASSERT_TRUE(Await([&] { return !retained->IsCurrent(); })); EXPECT_FALSE(client.GetSearchProducerGrant()); client.Stop();
}

TEST(ConfigSearchProducer, ReadTimeoutBoundsShutdownWhenBackendDoesNotReply) {
  std::promise<void> entered;
  ProducerBff bff([&](int call) {
    if (call == 2) { entered.set_value(); std::this_thread::sleep_for(std::chrono::milliseconds(4000)); }
  }); bff.Start();
  ConfigCenterClient client(bff.BaseUrl(), "ai-service", "ai-config-only", {}, 1); client.Start();
  ASSERT_TRUE(Await([&] { return client.GetSearchProducerGrant().has_value(); }));
  const auto old = client.GetSearchProducerGrant(); ASSERT_TRUE(old);
  ASSERT_EQ(entered.get_future().wait_for(std::chrono::seconds(3)), std::future_status::ready);
  const auto before = std::chrono::steady_clock::now(); client.Stop();
  EXPECT_LT(std::chrono::steady_clock::now() - before, std::chrono::milliseconds(4500));
  EXPECT_FALSE(old->IsCurrent()); EXPECT_FALSE(client.GetSearchProducerGrant());
}
