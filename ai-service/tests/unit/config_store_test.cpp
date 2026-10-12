// Copyright AINVR. Adapted for the S100P service.
// 对应 Python config_store.py 的行为测试:深合并语义、overlay 路径推导、
// 校验失败磁盘不变、原子写、跨进程锁(用两次连续 SaveOverlay 间接验证不
// 会死锁/损坏,而不是真的起两个进程)。
#include <gtest/gtest.h>

#include <fstream>

#include "../../src/config/config_store.hpp"

using namespace ai_service::config;
using nlohmann::json;

TEST(DeepMerge, OverlayOverridesBaseScalar) {
  json base = {{"a", 1}, {"b", 2}};
  json overlay = {{"b", 99}};
  auto merged = DeepMerge(base, overlay);
  EXPECT_EQ(merged["a"], 1);
  EXPECT_EQ(merged["b"], 99);
}

TEST(DeepMerge, NestedObjectsRecurse) {
  json base = {{"outer", {{"x", 1}, {"y", 2}}}};
  json overlay = {{"outer", {{"y", 99}}}};
  auto merged = DeepMerge(base, overlay);
  EXPECT_EQ(merged["outer"]["x"], 1);
  EXPECT_EQ(merged["outer"]["y"], 99);
}

TEST(DeepMerge, ListsReplaceWholesaleNotElementwise) {
  json base = {{"channels", json::array({1, 2, 3})}};
  json overlay = {{"channels", json::array({9})}};
  auto merged = DeepMerge(base, overlay);
  EXPECT_EQ(merged["channels"], json::array({9}));
}

TEST(DeriveOverlayPath, MatchesV1Convention) {
  auto p = DeriveOverlayPath("/home/sunrise/ainvr/ai-service/config/config.yaml");
  EXPECT_EQ(p.string(), "/home/sunrise/ainvr/ai-service/data/config_overlay.json");
}

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
            ("cfgstore_test_" + std::to_string(reinterpret_cast<uintptr_t>(this)))),
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

TEST(ConfigStore, LoadFallsBackToBaseWhenNoOverlay) {
  StoreFixture fx;
  AppConfig cfg = fx.store.Load();
  EXPECT_EQ(cfg.server.port, 8000);
  EXPECT_TRUE(cfg.channels.empty());
}

TEST(ConfigStore, SaveOverlayPersistsAndMergesWithBase) {
  StoreFixture fx;
  json patch = {{"channels", json::array({{{"id", "cam01"},
                                            {"stream", {{"url", "rtmp://x/live/y"}}}}})}};
  AppConfig cfg = fx.store.SaveOverlay(patch);
  ASSERT_EQ(cfg.channels.size(), 1u);
  EXPECT_EQ(cfg.channels[0].id, "cam01");
  EXPECT_EQ(cfg.server.port, 8000);  // 基座值仍然保留

  // 重新从磁盘加载,确认真的落盘了(不是只改了内存)。
  AppConfig reloaded = fx.store.Load();
  ASSERT_EQ(reloaded.channels.size(), 1u);
  EXPECT_EQ(reloaded.channels[0].id, "cam01");
}

TEST(ConfigStore, InvalidPatchLeavesDiskUntouched) {
  StoreFixture fx;
  json good_patch = {{"channels", json::array({{{"id", "cam01"},
                                                 {"stream", {{"url", "rtmp://x/live/y"}}}}})}};
  fx.store.SaveOverlay(good_patch);
  json before = fx.store.LoadOverlayRaw();

  json bad_patch = {{"channels", json::array({{{"id", "cam02"}, {"stream", {{"url", "not-a-url"}}}}})}};
  EXPECT_THROW(fx.store.SaveOverlay(bad_patch), ConfigValidationError);

  json after = fx.store.LoadOverlayRaw();
  EXPECT_EQ(before, after);  // 校验失败,磁盘一个字节不变
}

TEST(ConfigStore, SaveOverlayDeepMergesIntoExistingOverlay) {
  StoreFixture fx;
  fx.store.SaveOverlay(json{{"server", {{"log_level", "debug"}}}});
  fx.store.SaveOverlay(json{{"server", {{"api_key", "secret"}}}});

  json overlay = fx.store.LoadOverlayRaw();
  // 两次 patch 都保留(深合并,不是整体覆盖)。
  EXPECT_EQ(overlay["server"]["log_level"], "debug");
  EXPECT_EQ(overlay["server"]["api_key"], "secret");
}

TEST(ConfigStore, ReplaceOverlayDiscardsPreviousContent) {
  StoreFixture fx;
  fx.store.SaveOverlay(json{{"server", {{"log_level", "debug"}}}});
  fx.store.ReplaceOverlay(json{{"server", {{"api_key", "x"}}}});

  json overlay = fx.store.LoadOverlayRaw();
  EXPECT_FALSE(overlay["server"].contains("log_level"));  // 整体替换,不是合并
  EXPECT_EQ(overlay["server"]["api_key"], "x");
}

TEST(ConfigStore, RealProductionOverlayLoadsUnchanged) {
  // §1.3 的硬约束:v2 必须能原样加载 v1 现网 overlay,不是转写一份新的。
  StoreFixture fx;
  json real_overlay = R"({
    "channels": [{
      "id": "demo-detect",
      "stream": {"url": "rtmp://127.0.0.1:1935/live/phase6_test", "protocol": "rtmp"},
      "publish": {
        "enabled": true,
        "target_url": "rtmp://127.0.0.1:1935/live/phase6_test_ai_out",
        "sei": {"match_window_ms": 0},
        "osd": {"stale_ms": 800, "box_color": [0, 255, 0, 255]}
      },
      "snapshot": {"projection_mode": "erp_equirect", "face_enhance_enabled": true}
    }],
    "server": {"api_key": "test-api-key-not-real"}
  })"_json;

  AppConfig cfg = fx.store.ReplaceOverlay(real_overlay);
  ASSERT_EQ(cfg.channels.size(), 1u);
  EXPECT_EQ(cfg.channels[0].snapshot.face_enhance_model, "gpen");
  EXPECT_EQ(cfg.server.api_key, "test-api-key-not-real");
}
