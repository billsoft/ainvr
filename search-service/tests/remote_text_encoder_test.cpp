// Search-service side of the Qwen3-VL-Embedding text channel against a fake owner (no BPU, no models).
#include "remote_text_encoder.hpp"
#include <unistd.h>
#include <atomic>
#include <chrono>
#include <cmath>
#include <iostream>
#include <thread>

using namespace ainvr::search;
static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << " " #cond "\n"; ++failures; } } while (0)

static const std::string kVersion = "search-v1-" + std::string(64, 'b');
static const std::string kPackage = "qwen3vl-embedding-2b-o2";

template <class F> static std::string ErrorOf(F&& fn) {
  try { fn(); } catch (const QueryTextError& e) { return e.Code(); } catch (const std::exception& e) { return e.what(); }
  return "";
}

int main() {
  RemoteTextEncoder::Options options;
  options.socket_path = "/tmp/ainvr-remote-text-test-" + std::to_string(getpid()) + ".sock";
  options.load_wait_ms = 3000; options.heartbeat_ms = 50; options.call_timeout_ms = 5000;
  const auto connect = [&](const std::string& package = kPackage, const std::string& version = kVersion, size_t dims = 2048) {
    return RemoteTextEncoder::ConnectIdentity(package, version, dims, options);
  };
  CHECK(ErrorOf([&] { connect(); }) == "search_model_pending");   // owner not running

  std::string mode = "ok";
  std::atomic<int> ensures{0}, loading_polls{0}, releases{0};
  {
    ainvr::EmbedIpcServer server(options.socket_path, [&](const nlohmann::json& request) {
      ainvr::EmbedIpcReply reply;
      const auto op = request.at("op").get<std::string>();
      if(op=="release"){CHECK(!request.at("lease_id").get<std::string>().empty());++releases;return reply;}
      if (op == "ensure") {
        CHECK(!request.at("lease_id").get<std::string>().empty());
        ++ensures;
        if (mode == "loading-then-ready" && loading_polls.fetch_add(1) < 2) { reply.header = {{"state", "loading"}}; return reply; }
        if (mode == "never-ready") { reply.header = {{"state", "loading"}}; return reply; }
        if (mode == "failed") { reply.header = {{"state", "failed"}, {"load_error", "search_bpu_runtime_fault"}}; return reply; }
        reply.header = {{"state", "ready"}, {"package_id", kPackage}, {"dimensions", 2048},
                        {"model_version", mode == "other" ? "search-v1-" + std::string(64, 'c') : kVersion}};
        return reply;
      }
      CHECK(op == "query" && request.at("package_id") == kPackage);
      if (mode == "error") throw std::runtime_error(request.at("text").get<std::string>());   // text carries the code under test
      if (mode == "short") { reply.payload.assign(10, 0.5f); return reply; }
      if (mode == "nan") { reply.payload.assign(2048, NAN); return reply; }
      if (request.at("expect") != kVersion) throw std::runtime_error("search_model_changed");
      reply.payload.assign(2048, 0.0f); reply.payload[7] = 2.0f;
      return reply;
    });
    {
      auto encoder = connect();
      CHECK(encoder->ModelVersion() == kVersion && encoder->Dimensions() == 2048 && encoder->Healthy());
      const auto vector = encoder->Encode("背黑色双肩包的人");
      CHECK(vector.size() == 2048 && vector[7] == 2.0f);
      // The heartbeat keeps the owner's weights resident while this encoder exists.
      const int before = ensures.load();
      std::this_thread::sleep_for(std::chrono::milliseconds(400));
      CHECK(ensures.load() >= before + 3);
      mode = "error";
      CHECK(ErrorOf([&] { encoder->Encode("query_invalid_utf8"); }) == "query_invalid_utf8");
      CHECK(ErrorOf([&] { encoder->Encode("query_too_large"); }) == "query_too_large");
      CHECK(ErrorOf([&] { encoder->Encode("query_too_long"); }) == "query_too_long");
      CHECK(ErrorOf([&] { encoder->Encode("query_unrepresentable"); }) == "query_unrepresentable");
      CHECK(ErrorOf([&] { encoder->Encode("search_model_changed"); }) == "search_model_pending");
      CHECK(ErrorOf([&] { encoder->Encode("search_model_pending"); }) == "search_model_pending");
      CHECK(ErrorOf([&] { encoder->Encode("search_bpu_runtime_fault"); }) == "search_model_pending");
      CHECK(ErrorOf([&] { encoder->Encode("search_busy"); }) == "search_busy");
      CHECK(ErrorOf([&] { encoder->Encode("anything with driver text /dev/bpu"); }) == "search_encoding_failed");   // vendor detail never crosses
      mode = "short";
      CHECK(ErrorOf([&] { encoder->Encode("x"); }) == "search_encoding_failed");
      mode = "nan";
      CHECK(ErrorOf([&] { encoder->Encode("x"); }) == "search_encoding_failed");
      mode = "ok";
    }
    CHECK(releases.load()==1);
    // After destruction the heartbeat is gone.
    const int settled = ensures.load();
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
    CHECK(ensures.load() == settled);
    // A cold owner that is still loading is waited for; one that never finishes is "pending", not a hang.
    mode = "loading-then-ready"; loading_polls = 0;
    CHECK(ErrorOf([&] { auto e = connect(); CHECK(e->ModelVersion() == kVersion); }) == "");
    mode = "never-ready"; options.load_wait_ms = 1200;
    CHECK(ErrorOf([&] { connect(); }) == "search_model_pending");
    mode = "failed";
    CHECK(ErrorOf([&] { connect(); }) == "search_model_pending");
    mode = "other"; options.load_wait_ms = 3000;
    CHECK(ErrorOf([&] { connect(); }) == "search_model_pending");   // owner serves another vector space
    mode = "ok";
    CHECK(ErrorOf([&] { connect("other-package"); }) == "search_model_pending");
    CHECK(ErrorOf([&] { connect(kPackage, kVersion, 1152); }) == "search_model_pending");
  }
  // The owner restarting is a recoverable state, not a load failure of this process.
  CHECK(ErrorOf([&] { connect(); }) == "search_model_pending");
  if (failures) { std::cerr << failures << " failures\n"; return 1; }
  std::cout << "remote text encoder checks passed\n";
  return 0;
}
