#include "runtime_config.hpp"
#include "model_catalog.hpp"
#include "../../llm-service/src/config_center.hpp"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
#include <sys/stat.h>
#include <unistd.h>
using namespace ainvr::search;
using Json = nlohmann::json;
void Check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
template<class F> void Reject(F operation) { bool failed = false; try { operation(); } catch (...) { failed = true; } Check(failed, "invalid boundary accepted"); }
Json Runtime() {
  return {{"desired_version", 7}, {"revision", std::string(64, 'a')},
    {"settings", {{"schema_version", "1.0"}, {"enabled", false}, {"listen", {{"host", "127.0.0.1"}, {"port", 8400}}},
      {"history", {{"source", "ai-history"}}}, {"sampling", {{"track_slots", 8}}}, {"callers", Json::array()},
      {"limits", {{"http_workers", 4}, {"http_queue", 4}, {"image_max_bytes", 8388608}, {"max_samples", 100000},
        {"max_bytes", 1073741824}, {"retention_days", 30}, {"max_coverage", 100000}, {"max_searches", 1000}, {"search_ttl_s", 3600}}}}},
    {"history_connection", {{"uri", nullptr}, {"database", nullptr}, {"source_version", nullptr}}},
    {"sources", Json::array()}, {"dependency_status", "history_unavailable"}};
}
int main() {
  const auto root = std::filesystem::temp_directory_path() / ("ainvr-search-runtime-test-" + std::to_string(getpid()));
  std::filesystem::create_directory(root);
  httplib::Server server; std::thread listener;
  try {
    const std::string token(48, 'm');
    auto config = ReadEffectiveRuntime(Runtime(), token);
    Check(!config.access.enabled && !config.history_ready && config.access.revision.size() == 64, "disabled config needs resources");
    auto bad = Runtime(); bad["revision"] = "draft"; Reject([&] { ReadEffectiveRuntime(bad, token); });
    bad = Runtime(); bad["settings"]["listen"]["host"] = "0.0.0.0"; Reject([&] { ReadEffectiveRuntime(bad, token); });
    bad = Runtime(); bad["settings"]["sampling"]["track_slots"] = 9; Reject([&] { ReadEffectiveRuntime(bad, token); });
    bad = Runtime(); bad["settings"]["limits"]["max_bytes"] = 0; Reject([&] { ReadEffectiveRuntime(bad, token); });
    bad = Runtime(); bad["settings"]["limits"]["max_samples"] = 100.5; Reject([&] { ReadEffectiveRuntime(bad, token); });
    bad = Runtime(); bad["settings"]["callers"] = {{{"name", "console"}, {"scope", "producer"}, {"key", std::string(48, 'p')}}};
    Reject([&] { ReadEffectiveRuntime(bad, token); });
    auto enabled = Runtime(); enabled["settings"]["enabled"] = true;
    Check(ReadEffectiveRuntime(enabled, token).access.unavailable_reason == "storage_unavailable", "missing history falsely ready");
    auto sourced = Runtime();
    const auto channel = "00000000-0000-4000-8000-100000000001";
    sourced["sources"] = Json::array({{{"channel_id", channel}, {"input_stream_id", "00000000-0000-4000-8000-100000000002"},
      {"processor_id", "chained-processor"}, {"recording_channel_id", channel}, {"object", true}, {"scene", true},
      {"input_path", "/live/intermediate_ai"}, {"output_path", "/analysis/final-ai"}}});
    auto managed_source = ReadEffectiveRuntime(sourced, token);
    Check(managed_source.access.sources.at(channel).input_path == "/live/intermediate_ai" &&
      managed_source.access.sources.at(channel).output_path == "/analysis/final-ai", "actual source paths lost");
    for (const char* field : {"input_path", "output_path"}) {
      auto missing = sourced; missing["sources"][0].erase(field);
      Reject([&] { ReadEffectiveRuntime(missing, token); });
      for (const std::string& path : {std::string(""), std::string("rtmp://user:password@localhost/live/raw"),
           std::string("/live/raw?token=private"), std::string("/live/raw#fragment"), std::string("/live/../raw"),
           std::string("/live/raw\n"), std::string("/live/") + std::string(129, 'a'), std::string("/live/raw\\extra")}) {
        auto invalid_path = sourced; invalid_path["sources"][0][field] = path;
        Reject([&] { ReadEffectiveRuntime(invalid_path, token); });
      }
    }
    sourced["sources"][0]["input_path"] = "/" + std::string(128, 'a') + "/" + std::string(128, 'b');
    Check(ReadEffectiveRuntime(sourced, token).access.sources.size() == 1, "valid bounded SRS path rejected");
    // Real local HTTP transport: body size, response envelope and authentication.
    server.Get("/api/v1/config/fixture", [&](const auto& req, auto& res) {
      Check(req.get_header_value("x-service-token") == token, "missing management auth");
      res.set_content(Json{{"code", 0}, {"data", {{"version", 7}}}}.dump(), "application/json");
    });
    server.Get("/api/internal/search/runtime-config", [&](const auto&, auto& res) { res.set_content(Runtime().dump(), "application/json"); });
    server.Post("/api/internal/search/runtime-state", [&](const auto& req, auto& res) {
      Check(Json::parse(req.body).at("revision") == std::string(64, 'a'), "ACK revision changed");
      res.set_content("{}", "application/json");
    });
    server.Get("/api/huge", [](const auto&, auto& res) { res.set_content(std::string(1024 * 1024 + 1, 'x'), "application/json"); });
    server.Get("/api/redirect", [](const auto&, auto& res) { res.set_redirect("http://192.0.2.1/credentials", 302); });
    const int port = server.bind_to_any_port("127.0.0.1"); Check(port > 0, "test bind failed");
    listener = std::thread([&] { server.listen_after_bind(); });
    for (int n = 0; n < 200 && !server.is_running(); ++n) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    Check(server.is_running(), "test listener unavailable");
    const Json bootstrap{{"control_url", "http://127.0.0.1:" + std::to_string(port)}, {"service_token", token}};
    ainvr::config::ConfigTransport transport(bootstrap);
    Check(transport.Request("fixture").at("version") == 7, "shared envelope regression");
    Check(transport.RequestAt("/api/internal/search/runtime-config").at("desired_version") == 7, "effective runtime envelope");
    Json ack{{"revision", std::string(64, 'a')}}; transport.RequestAt("/api/internal/search/runtime-state", &ack);
    Reject([&] { transport.RequestAt("/api/huge"); });
    Reject([&] { transport.RequestAt("/api/redirect"); });
    Reject([&] { transport.RequestAt("http://192.0.2.1/api/"); });
    auto wrong_bootstrap = bootstrap; wrong_bootstrap["control_url"] = "http://192.0.2.1:8000";
    Reject([&] { ainvr::config::ConfigTransport denied(wrong_bootstrap); });
    auto path = root / "private.json";
    { std::ofstream out(path); out << bootstrap.dump(); } chmod(path.c_str(), 0600);
    Check(ainvr::config::ReadPrivateJson(path.string()) == bootstrap, "private bootstrap read");
    chmod(path.c_str(), 0644); Reject([&] { ainvr::config::ReadPrivateJson(path.string()); });
    chmod(path.c_str(), 0600); std::filesystem::create_symlink(path, root / "link");
    Reject([&] { ainvr::config::ReadPrivateJson((root / "link").string()); });
    { std::ofstream out(path); out << std::string(65537, 'x'); }
    Reject([&] { ainvr::config::ReadPrivateJson(path.string()); });
    Check(ModelCatalog(root.string()).at("items").empty(), "missing package fabricated");
    // LLM continues to use the same normalization and the shared transport alias.
    Json llm{{"listen", {{"host", "127.0.0.1"}, {"port", 8300}}}, {"model", {{"package_id", "qwen3vl-4b-review-v3"}, {"load_policy", "resident"}}},
      {"admin_key", std::string(48, 'a')}, {"enabled", false}, {"api_keys", {{{"name", "alarm"}, {"scope", "inference"}, {"key", std::string(48, 'b')}}}},
      {"scheduling", {{"prefill_profile", "s256"}, {"queue_size", 2}, {"queue_timeout_s", 30}, {"exec_timeout_s", 30}, {"submit_time_share_cap_percent", 50}}},
      {"tasks", {{"alarm-review-zh-v1", {{"calibration_temperature", 1.0}, {"aspect_policy", "reject"}}}}}};
    Check(ainvr::llm::NormalizeSettings(llm, 3).at("config_version") == 3, "LLM normalization changed");
    server.stop(); listener.join(); std::filesystem::remove_all(root);
    std::cout << "runtime: private bootstrap, shared config transport, bounded responses, dependency identity, disabled ACK boundary passed\n";
  } catch (const std::exception& error) {
    server.stop(); if (listener.joinable()) listener.join(); std::filesystem::remove_all(root);
    std::cerr << error.what() << '\n'; return 1;
  }
}
