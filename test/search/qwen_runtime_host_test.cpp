// Lifecycle of the shared Qwen3-VL-Embedding weight owner without opening the BPU: on-demand background load,
// sharing between the sampler and text queries, keep-alive expiry, and the local socket protocol around it.
#include "output/search_qwen_runtime.hpp"
#include "../../shared/cpp/embed_ipc.hpp"
#include <unistd.h>
#include <atomic>
#include <iostream>
#include <thread>

using namespace ai_service::output;
static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << " " #cond "\n"; ++failures; } } while (0)

static const std::string kPackage = "qwen3vl-embedding-2b-o2";
static const std::string kVersion = "search-v1-" + std::string(64, 'a');

template <class F> static std::string ErrorOf(F&& fn) {
  try { fn(); } catch (const std::exception& e) { return e.what(); }
  return "";
}

int main() {
  auto& host = QwenEmbeddingHost::Instance();
  std::atomic<int> loads{0};
  std::atomic<bool> fail{false};
  host.SetLoaderForTest([&](const std::string& id, const std::optional<ainvr::search::RuntimeModelPin>&, const SearchSamplingCurrent&) {
    ++loads;
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    if (fail) throw std::runtime_error("search_bpu_runtime_fault");
    return QwenEmbeddingHost::FakeForTest({id, kVersion, "spec"});
  });
  const auto wait_ready = [&] {
    for (int i = 0; i < 100; ++i) { if (host.Ensure(kPackage, std::chrono::seconds(2)).ready) return true; std::this_thread::sleep_for(std::chrono::milliseconds(50)); }
    return false;
  };

  // On-demand background load: the first ask starts it and returns at once; later asks share the result.
  auto first = host.Ensure(kPackage, std::chrono::seconds(2));
  CHECK(!first.ready && first.loading);
  CHECK(wait_ready() && loads == 1);
  auto status = host.Ensure(kPackage, std::chrono::seconds(2));
  CHECK(status.ready && status.space.model_version == kVersion && loads == 1);
  // The sampler shares the same weights: Acquire never loads a second copy.
  auto shared = host.Acquire(kPackage, std::nullopt, [] { return true; });
  CHECK(shared && shared == host.Loaded() && loads == 1);
  // A pin that does not match the resident weights is refused instead of loading beside them.
  const ainvr::search::RuntimeModelPin wrong{kPackage, std::string(64, 'f'), "search-v1-" + std::string(64, 'f')};
  CHECK(ErrorOf([&] { host.Acquire(kPackage, wrong, [] { return true; }); }) == "search_hardware_model_pin_mismatch");

  // The local socket: hello identity, ensure state, version fence.
  const std::string path = "/tmp/ainvr-qwen-host-test-" + std::to_string(getpid()) + ".sock";
  host.StartIpc(path);
  auto hello = ainvr::EmbedIpcCall(path, {{"op", "hello"}}, 2000);
  CHECK(hello.header.at("model_version") == kVersion && hello.header.at("dimensions") == 2048 && hello.header.at("package_id") == kPackage);
  auto ensure = ainvr::EmbedIpcCall(path, {{"op", "ensure"}, {"package_id", kPackage}}, 2000);
  CHECK(ensure.header.at("state") == "ready" && ensure.header.at("model_version") == kVersion);
  CHECK(ErrorOf([&] { ainvr::EmbedIpcCall(path, {{"op", "ensure"}, {"package_id", "siglip2-base-full-int8"}}, 2000); }) == "invalid_request");
  CHECK(ErrorOf([&] { ainvr::EmbedIpcCall(path, {{"op", "ensure"}}, 2000); }) == "invalid_request");
  CHECK(ErrorOf([&] { ainvr::EmbedIpcCall(path, {{"op", "query"}, {"text", "x"}, {"expect", "search-v1-" + std::string(64, 'z')}}, 2000); }) == "search_model_changed");
  CHECK(ErrorOf([&] { ainvr::EmbedIpcCall(path, {{"op", "bogus"}}, 2000); }) == "invalid_request");

  // Nobody holds the weights any more: a query that finds nothing resident answers pending and restarts the load.
  shared.reset();
  host.ResetForTest();
  CHECK(!host.Loaded());
  CHECK(ErrorOf([&] { ainvr::EmbedIpcCall(path, {{"op", "hello"}}, 2000); }) == "search_model_pending");
  const int before = loads;
  CHECK(ErrorOf([&] { ainvr::EmbedIpcCall(path, {{"op", "query"}, {"text", "x"}, {"package_id", kPackage}}, 2000); }) == "search_model_pending");
  CHECK(wait_ready() && loads == before + 1);

  // A failed load is reported and retried on the next ask.
  host.ResetForTest(); fail = true;
  host.Ensure(kPackage, std::chrono::seconds(2));
  std::this_thread::sleep_for(std::chrono::milliseconds(600));
  auto failed = host.Ensure(kPackage, std::chrono::seconds(2));
  CHECK(!failed.ready && failed.error == "search_bpu_runtime_fault");
  fail = false;
  std::this_thread::sleep_for(std::chrono::milliseconds(600));
  CHECK(wait_ready());

  // Keep-alive expiry: with no holder the reaper drops the weights.
  host.ResetForTest();
  CHECK(wait_ready());
  host.Ensure(kPackage, std::chrono::seconds(0));
  for (int i = 0; i < 40 && host.Loaded(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(250));
  CHECK(!host.Loaded());

  if (failures) { std::cerr << failures << " failures\n"; return 1; }
  std::cout << "qwen runtime host checks passed\n";
  return 0;
}
