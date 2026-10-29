#include "runtime_text.hpp"
#include <iostream>
using namespace ainvr::search;
namespace {
void Check(bool condition) { if (!condition) throw std::runtime_error("runtime text contract failed"); }
template<class F> void Reject(F operation) {
  bool rejected = false; try { operation(); } catch (...) { rejected = true; } Check(rejected);
}
// Contract sentinel only. Encode must never execute in these software tests.
class SentinelEncoder final : public TextEncoder {
 public:
  SentinelEncoder(std::string version, size_t dimensions) : version_(std::move(version)), dimensions_(dimensions) {}
  std::string ModelVersion() const override { return version_; }
  size_t Dimensions() const override { return dimensions_; }
  bool Healthy() const override { return healthy; }
  std::vector<float> Encode(const std::string&) override { ++calls; throw std::logic_error("sentinel_must_not_encode"); }
  bool healthy = true; int calls = 0;
 private:
  std::string version_; size_t dimensions_;
};
}
int main() { try {
  EffectiveRuntime runtime;
  runtime.package_id = "siglip2-base-full-int8";
  runtime.access.unavailable_reason.clear();
  const std::string version = "search-v1-" + std::string(64, 'b');
  const RuntimeModelPin old_pin{runtime.package_id,std::string(64,'a'),"search-v1-"+std::string(64,'a')};
  const RuntimeModelPin candidate{runtime.package_id,std::string(64,'b'),version};
  int metadata_reads=0;
  const auto compatible=[&](const std::string& model){++metadata_reads;Check(model==version);return true;};
  RequireRuntimeModelAuthority(runtime,candidate,compatible);Check(metadata_reads==1);
  Reject([&]{RequireRuntimeModelAuthority(runtime,candidate,[](const auto&){return false;});});
  Reject([&]{RequireRuntimeModelAuthority(runtime,candidate,{});});
  Reject([&]{RequireRuntimeModelAuthority(runtime,candidate,[](const auto&)->bool{throw std::runtime_error("unavailable");});});
  runtime.active_model_pin=candidate;RequireRuntimeModelAuthority(runtime,candidate,{});Check(metadata_reads==1);
  runtime.active_model_pin=old_pin;Reject([&]{RequireRuntimeModelAuthority(runtime,candidate,compatible);});Check(metadata_reads==1);
  runtime.approved_model_transition=RuntimeModelTransition{"00000000-0000-4000-8000-000000000001",std::string(64,'c'),1,old_pin,candidate};
  RequireRuntimeModelAuthority(runtime,candidate,{});Check(*runtime.active_model_pin==old_pin);
  auto wrong=candidate;wrong.package_sha256=std::string(64,'d');Reject([&]{RequireRuntimeModelAuthority(runtime,wrong,compatible);});
  wrong=candidate;wrong.package_id="siglip-so400m-i18n-full-int8";Reject([&]{RequireRuntimeModelAuthority(runtime,wrong,compatible);});
  runtime.approved_model_transition->source=candidate;Reject([&]{RequireRuntimeModelAuthority(runtime,candidate,compatible);});
  runtime.approved_model_transition->source=old_pin;runtime.approved_model_transition->target=old_pin;
  Reject([&]{RequireRuntimeModelAuthority(runtime,candidate,compatible);});
  runtime.approved_model_transition->target=candidate;runtime.active_model_pin.reset();
  RequireRuntimeModelAuthority(runtime,candidate,[](const auto&){return false;}); // Accepted mixed-history transition.
  runtime.approved_model_transition.reset();
  auto current=runtime;runtime.version=7;runtime.revision=std::string(64,'a');current=runtime;
  Check(RuntimeAckStillCurrent(runtime,current));current.revision=std::string(64,'b');Check(!RuntimeAckStillCurrent(runtime,current));
  current=runtime;++current.version;Check(!RuntimeAckStillCurrent(runtime,current));
  int allocations=0;const auto construct=[&]()->std::unique_ptr<TextEncoder>{++allocations;return std::make_unique<SentinelEncoder>(version,768);};
  runtime.active_model_pin=old_pin;
  Reject([&]{LoadAuthorizedRuntimeTextEncoder(runtime,candidate,compatible,construct);});Check(allocations==0);
  runtime.active_model_pin=candidate;
  Check(LoadAuthorizedRuntimeTextEncoder(runtime,candidate,{},construct)->ModelVersion()==version&&allocations==1);
  Reject([&]{LoadAuthorizedRuntimeTextEncoder(runtime,candidate,{},[&]()->std::unique_ptr<TextEncoder>{
    return std::make_unique<SentinelEncoder>(old_pin.model_version,768);});});
  Reject([&]{LoadAuthorizedRuntimeTextEncoder(runtime,candidate,{},[&]()->std::unique_ptr<TextEncoder>{
    auto faulted=std::make_unique<SentinelEncoder>(version,768);faulted->healthy=false;return faulted;});});
  runtime.active_model_pin.reset();
  int calls = 0;
  RuntimeTextLoader loader = [&](const std::string& id) {
    Check(id == "siglip2-base-full-int8"); ++calls;
    return std::make_unique<SentinelEncoder>(version, 768);
  };
  Check(!LoadConfiguredTextEncoder(runtime, loader)); Check(calls == 0);
  runtime.access.enabled = true;
  Check(!LoadConfiguredTextEncoder(runtime, loader)); Check(calls == 0);
  runtime.history_ready = true; runtime.access.unavailable_reason = "storage_unavailable";
  Check(!LoadConfiguredTextEncoder(runtime, loader)); Check(calls == 0);
  runtime.access.unavailable_reason.clear();
  Check(!LoadConfiguredTextEncoder(runtime, {})); Check(calls == 0);
  runtime.package_id.clear(); Check(!LoadConfiguredTextEncoder(runtime, loader)); Check(calls == 0);
  runtime.package_id = "siglip2-base-full-int8";
  auto encoder = LoadConfiguredTextEncoder(runtime, loader);
  Check(calls == 1 && encoder->ModelVersion() == version && encoder->Dimensions() == 768);
  for (const auto& identity : {std::make_pair(version, size_t(1152)), std::make_pair(std::string("draft"), size_t(768))})
    Reject([&] { LoadConfiguredTextEncoder(runtime, [&](const auto&) {
      return std::make_unique<SentinelEncoder>(identity.first, identity.second);
    }); });
  Reject([&] { LoadConfiguredTextEncoder(runtime, [](const auto&) -> std::unique_ptr<TextEncoder> { return nullptr; }); });
  Reject([&] { LoadConfiguredTextEncoder(runtime, [](const auto&) -> std::unique_ptr<TextEncoder> {
    throw std::runtime_error("ion_budget_exceeded");
  }); });
  runtime.package_id = "does-not-exist"; Reject([&] { LoadConfiguredTextEncoder(runtime, loader); }); Check(calls == 1);
  runtime.package_id = "siglip2-base-pruned-int8";
  Reject([&] { LoadConfiguredTextEncoder(runtime, loader); }); Check(calls == 1);
  // Constructing a Mongo owner does not connect. A faulted encoder must be
  // rejected before Encode or projection lookup (no database is contacted).
  {
    HistoryMongo unused("mongodb://127.0.0.1:1", "ainvr_search_software_unused");
    SentinelEncoder faulted(version, 768); faulted.healthy = false;
    MatchEngine engine(unused, faulted, 8);
    Check(!engine.Healthy() && !engine.Ready());
    Reject([&] { engine.Match("no computation", {}); });
    Check(faulted.calls == 0);
  }
  runtime.budget.max_samples = 100000;
  Check(RuntimeProjectionCapacity(runtime, 768) == 83333);
  Check(RuntimeProjectionCapacity(runtime, 1152) == 55555);
  runtime.budget.max_samples = 64; Check(RuntimeProjectionCapacity(runtime, 768) == 64);
  Reject([&] { RuntimeProjectionCapacity(runtime, 0); });
  Reject([&] { RuntimeProjectionCapacity(runtime, 4097); });
  runtime.budget.max_samples = 0; Reject([&] { RuntimeProjectionCapacity(runtime, 768); });
  constexpr int64_t now = int64_t(1000) * 86400000;
  Reject([&] { RuntimeProjectionWindow(runtime, now); });
  runtime.access.sources.emplace("00000000-0000-4000-8000-000000000001", ProducerSource{});
  runtime.budget.retention_ms = int64_t(365) * 86400000;
  auto scope = RuntimeProjectionWindow(runtime, now);
  Check(scope.channels.size() == 1 && scope.to_ms == now && scope.from_ms == now - int64_t(31) * 86400000);
  runtime.budget.retention_ms = 86400000; Check(RuntimeProjectionWindow(runtime, now).from_ms == now - 86400000);
  Check(RuntimeProjectionWindow(runtime, 1000).from_ms == 0);
  Reject([&] { RuntimeProjectionWindow(runtime, 0); });
  for (int i = 0; i < 1023; ++i) runtime.access.sources.emplace(std::to_string(i), ProducerSource{});
  Check(RuntimeProjectionWindow(runtime, now).channels.size() == 1024);
  runtime.access.sources.emplace("one-too-many", ProducerSource{});
  Reject([&] { RuntimeProjectionWindow(runtime, now); });
  std::cout << "runtime text: explicit selection, no fallback, disabled/OFF no load, model identity and bounded exact projection passed; no BPU\n";
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; } }
