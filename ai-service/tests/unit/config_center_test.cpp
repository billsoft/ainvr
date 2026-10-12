// Copyright AINVR. Adapted for the S100P service.
// 对应 shared/python/config_center_client.py + config_center_apply.py。
// ConfigCenterClient 用一个真实 httplib server 模拟 BFF 端点做端到端
// 测试(轮询 desiredVersion -> 拉快照 -> 应用 -> 上报),比只测内部函数
// 更能捕获协议拼接上的问题。
#include <gtest/gtest.h>

#include <atomic>
#include <chrono>
#include <fstream>
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
