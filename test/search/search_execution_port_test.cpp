// Composition oracle only: synthetic pixels/JPEG/embedding and fake transport.
// No SDK, socket, database, tokenizer or real model is executed.
#include "output/search_execution_port.hpp"
#include "../../search-service/src/model_package.hpp"
#include "search_frame_fixture.hpp"
#include <atomic>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <regex>
#include <limits>
using namespace ai_service::output;
using namespace ai_service::config;
using namespace search_test;
using Json = nlohmann::json;
using Receipt = SearchSamplingReceipt;
namespace {
const std::string input_spec =
  "image-area-rgb-u8-round-before-normalize-mean127.5-div127.5-squash256-l2-v1;"
  "source-yuv-matrix-range-from-frame-metadata;"
  "text-gemma-lower-unicode13-icu70-ageguard-sp-dummy0-eos1-pad0-embedding256000-s64x64-strict63";
// An opaque fixture generation, not a claim to have loaded a hardware package.
const SearchEmbeddingSpace space{"siglip2-base-full-int8", "search-v1-" + std::string(64, 'a'), input_spec};
void DrainWorkerCompletion() {
  struct GateState {
    std::mutex mutex; std::condition_variable cv;
    bool release = false;
    std::atomic<bool> entered{false}, finished{false};
  };
  auto state = std::make_shared<GateState>();
  ArchiveExecutor exclusive(1, 1);
  auto work = exclusive.Submit([state] {
    std::unique_lock<std::mutex> lock(state->mutex);
    state->entered = true; state->cv.notify_all();
    state->cv.wait(lock, [&] { return state->release; });
    state->finished = true;
  });
  Await([&] { return state->entered.load(); });
  Check(!state->finished, "fixture callback was not held");
  auto shutdown = std::async(std::launch::async, [&] { exclusive.DrainAndShutdown(); });
  const bool waited = shutdown.wait_for(std::chrono::milliseconds(20)) == std::future_status::timeout;
  { std::lock_guard<std::mutex> lock(state->mutex); state->release = true; }
  state->cv.notify_all(); work.get(); shutdown.get();
  Check(waited && state->finished, "exclusive shutdown escaped active worker work");
  exclusive.DrainAndShutdown(); // Idempotent, including the later destructor.
}

struct State {
  std::mutex mutex;
  std::vector<std::string> events;
  std::thread::id owner;
  std::atomic<int> prepares{0}, destroyed{0};
  std::atomic<bool> affine_ok{true};
  std::function<void()> preparing;
  void Event(std::string value) { std::lock_guard<std::mutex> lock(mutex); events.push_back(std::move(value)); }
  std::vector<std::string> Events() { std::lock_guard<std::mutex> lock(mutex); return events; }
};
class Hardware final : public SearchHardwareSession {
 public:
  explicit Hardware(std::shared_ptr<State> state) : state_(std::move(state)) {
    state_->owner = std::this_thread::get_id(); state_->Event("load");
  }
  ~Hardware() override {
    if (state_->owner != std::this_thread::get_id()) state_->affine_ok = false;
    ++state_->destroyed; state_->Event("destroy");
  }
  SearchEmbeddingSpace Space() const override { return space; }
  std::function<bool()> HealthReader() const override { return [] { return true; }; }
  SearchHardwareProduct Prepare(const FrozenSearchFrame& frame, const SearchSamplingCurrent& current) override {
    Check(state_->owner == std::this_thread::get_id(), "prepare lost affine ownership");
    Check(current() && frame.Selection().frame.source_frame_index == 7, "wrong/stale frozen frame");
    ++state_->prepares; state_->Event("prepare");
    if (state_->preparing) state_->preparing();
    ainvr::SnapshotPlan plan; plan.width = plan.height = 18; plan.source_rectangle = {0,0,8,4};
    std::vector<float> embedding(768); embedding[0] = 1;
    return {plan, {255,216,255,217}, std::move(embedding), "gles", "jpu", "gles"};
  }
 private:
  std::shared_ptr<State> state_;
};
class Transport final : public SearchProducerHttpTransport {
 public:
  explicit Transport(std::shared_ptr<State> state) : state_(std::move(state)) {}
  std::string fingerprint, frozen_query;
  Json written_sample;
  size_t writes = 0, receipts = 0;
  bool unknown = false, not_found = false;
  size_t expected_slot=0;
  std::string expected_previous;
  std::string revision;
  SearchProducerHttpResponse Post(const SearchProducerLease& lease, const std::string& path,
      const std::string& metadata, const std::vector<uint8_t>* jpeg, const SearchSamplingCurrent& current) override {
    Check(current() && lease.IsCurrent(), "transport saw a revoked action");
    revision = lease.grant->revision;
    const bool receipt = path == "/v1/samples/receipt" || path == "/v1/samples/slot/receipt";
    state_->Event(receipt ? "receipt" : "write");
    const auto body = Json::parse(metadata);
    if (receipt) {
      ++receipts;
      Check(!jpeg && metadata == frozen_query, "receipt changed frozen request or resent JPEG");
      Check(body.at("request_fingerprint") == fingerprint && !body.at("sample").contains("vector"), "receipt lost exact generation");
      return {true, 200, Json{{"status", not_found ? "not_found" : "committed"},
        {"fingerprint", not_found ? Json(nullptr) : Json(fingerprint)}}.dump()};
    }
    ++writes;
    Check(jpeg && *jpeg == std::vector<uint8_t>({255,216,255,217}), "prepared JPEG changed");
    const bool object = path == "/v1/samples/slot";
    Check(object || path == "/v1/samples", "wrong publication route");
    written_sample = object ? body.at("sample") : body;
    auto without_vector = written_sample; without_vector.erase("vector");
    const auto query = Json::parse(frozen_query);
    Check(without_vector == query.at("sample"), "write and receipt have different UUID/expiry/evidence");
    Check(object == query.contains("slot"), "scene and object slot contract confused");
    if (object) Check(body.at("expected_fingerprint") == expected_previous && body.at("slot") == expected_slot && body.at("slot") == query.at("slot") &&
      body.at("replacement_token") == query.at("replacement_token"), "slot/CAS token changed");
    const auto& e = written_sample.at("evidence");
    Check(written_sample.at("vector").size() == 768 && written_sample.at("model_version") == space.model_version, "wrong embedding space");
    Check(e.at("input_spec_version") == input_spec, "full image/text preprocessing contract was shortened");
    Check(e.at("source_input_id") == "00000000-0000-4000-8000-000000000001" &&
      e.at("output_channel_id") == "00000000-0000-4000-8000-000000000002" &&
      e.at("recording_channel_id") == e.at("output_channel_id") && written_sample.at("processor_id") == "processor", "source identities crossed");
    Check(e.at("source_pts_ns") == "7000000000" && e.at("source_frame_index") == "7" &&
      e.at("stream_session_id") == "session-1" && e.at("input_path") == "/live/source" && e.at("output_path") == "/live/result", "raw/analytics frame source confused");
    Check(written_sample.at("captured_ms") == 7000 && written_sample.at("expires_ms") == 7000 + 30LL * 86400000, "capture/retention changed at submit");
    const std::regex uuid8("[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}");
    Check(std::regex_match(written_sample.at("id").get<std::string>(), uuid8) &&
      std::regex_match(e.at("frame_id").get<std::string>(), uuid8), "storage/frame identity not a UUIDv8");
    if (unknown) return {true, 0, ""};
    return {true, 200, Json{{"id", written_sample.at("id")}, {"stored", true}, {"fingerprint", fingerprint}}.dump()};
  }
 private:
  std::shared_ptr<State> state_;
};
struct Case {
  Fixture fixture{space.package_id};
  std::shared_ptr<State> state = std::make_shared<State>();
  std::shared_ptr<Transport> transport = std::make_shared<Transport>(state);
  std::shared_ptr<SearchHardwareOwner> hardware = std::make_shared<SearchHardwareOwner>([s=state](const std::string& package) {
    Check(package == space.package_id, "silently chose another model"); return std::make_unique<Hardware>(s);
  });
  std::shared_ptr<SearchSamplingExecutionPort> port = MakeSearchExecutionPort(hardware, std::make_shared<SearchProducerHttp>(transport));
  SearchWorkBudget budget;
  SearchSamplingPolicy policy;
  SearchSamplingPolicy::Candidate candidate;
  SearchProducerLease lease;
  std::shared_ptr<const FrozenSearchFrame> frame;
  std::atomic<bool> current{true};
  explicit Case(bool scene) {
    fixture.Advance(7, scene); lease = *fixture.authority->Read();
    hardware->Refresh(lease);
    Await([&] { hardware->Tick(); return bool(port->CurrentSpace()); });
    Check(*port->CurrentSpace() == space, "execution port did not expose complete space");
    const auto parsed = SearchSamplingPolicy::FrameFromResult(fixture.result, fixture.input, 7000);
    Check(bool(parsed) && policy.BindSource(parsed->binding), "fixture frame binding failed");
    SearchSamplingPolicy::Proposal proposal;
    if (scene) proposal = policy.ProposeScene(*parsed, {true, true, {}});
    else {
      const auto object = SearchSamplingPolicy::ObjectFromResult(fixture.result, "track-7", true, .5, {});
      Check(bool(object), "fixture object was not confirmed");
      proposal = policy.ProposeObject(*parsed, *object);
    }
    Check(bool(proposal.candidate), "fixture selection was not admitted"); candidate = *proposal.candidate;
    budget.Configure(1, 8 * 1024 * 1024); auto ticket = budget.TryAcquire(fixture.raw->pixels.capacity());
    Check(bool(ticket), "fixture frame budget missing");
    const auto frozen = FreezeSearchFrame(lease, candidate, fixture.result, fixture.capture,
        fixture.capture.fence, fixture.raw, std::move(*ticket));
    Check(bool(frozen), "composition frame could not freeze"); frame = frozen.frame;
  }
  SearchSamplingCurrent Current() { return [this] { return current.load(); }; }
  std::shared_ptr<SearchSamplingOperation> Prepare() {
    auto operation = port->Prepare(*frame, space, lease, Current());
    if (operation) {
      transport->frozen_query = operation->ReceiptQuery();
      transport->fingerprint = Json::parse(transport->frozen_query).at("request_fingerprint");
    }
    return operation;
  }
  void Probe(bool scene){
    frame.reset();candidate.reason=scene?SearchSamplingPolicy::Reason::SceneProbe:SearchSamplingPolicy::Reason::ObjectProbe;
    candidate.probe_reference_fingerprint=std::string(64,'e');candidate.probe_threshold=.25;
    if(!scene){candidate.slot=2;candidate.expected_fingerprint=std::string(64,'d');transport->expected_slot=2;transport->expected_previous=candidate.expected_fingerprint;}
    auto ticket=budget.TryAcquire(fixture.raw->pixels.capacity());Check(bool(ticket),"probe_fixture_budget");
    auto frozen=FreezeSearchFrame(lease,candidate,fixture.result,fixture.capture,fixture.capture.fence,fixture.raw,
      std::move(*ticket));
    Check(bool(frozen),"probe_fixture_freeze");frame=std::move(frozen.frame);
  }
  void Stop() { hardware->Stop(); Check(state->destroyed == 1 && state->affine_ok, "session not destroyed affinely"); }
};
}  // namespace
int main() { try {
  DrainWorkerCompletion();
  const auto& spec = ainvr::search::FindPackageSpec(space.package_id);
  Check(spec.dimensions == 768 && spec.input_spec_version == input_spec && input_spec.size() > 128, "fixture drifted from real full SigLIP2 contract");
  // A grant can retain history/source permission while every live sampling
  // kind is unsupported (e.g. ERP). That must not load a vision model.
  for (int mask : {0, 1, 2, -1}) {
    Fixture fixture(space.package_id);
    if (mask < 0) fixture.doc["sources"] = Json::array();
    else {
      fixture.doc["sources"][0]["object"] = (mask & 1) != 0;
      fixture.doc["sources"][0]["scene"] = (mask & 2) != 0;
    }
    fixture.doc["revision"] = std::string(64, 'c'); fixture.Renew();
    std::atomic<int> factories{0}; auto state = std::make_shared<State>();
    SearchHardwareOwner hardware([&](const std::string&) { ++factories; return std::make_unique<Hardware>(state); });
    const auto status = hardware.Refresh(fixture.authority->Read());
    if (mask <= 0) Check(status == SearchHardwareOwner::State::Disabled && factories == 0 && !hardware.CurrentSpace(), "empty sampling mask loaded vision");
    else {
      Await([&] { hardware.Tick(); return bool(hardware.CurrentSpace()); });
      Check(factories == 1, "supported single sampling kind did not load");
    }
    hardware.Stop();
  }
  for (bool scene : {false, true}) {
    Case c(scene); auto operation = c.Prepare(); Check(bool(operation), "full graph prepare failed");
    Check(c.transport->writes == 0 && c.state->Events() == std::vector<std::string>({"load", "prepare"}), "prepare performed publication");
    Check(operation->Submit(c.Current()).result == Receipt::Result::Committed, "combined graph ACK not committed");
    Check(c.transport->writes == 1 && c.state->prepares == 1 && c.transport->receipts == 0, "submit re-encoded or duplicated write");
    Check(c.transport->written_sample.at("kind") == (scene ? "scene" : "object") &&
      c.transport->written_sample.at("track_id") == (scene ? "" : "track-7"), "scene/object selection crossed");
    Check(c.state->Events() == std::vector<std::string>({"load", "prepare", "write"}), "composition message order changed");
    c.Stop();
  }
  for (int fence = 0; fence < 6; ++fence) {
    Case c(false);
    if (fence == 0) { c.current = false; Check(!c.Prepare(), "revoked current prepared"); }
    if (fence == 1) { c.fixture.authority->Invalidate(); Check(!c.Prepare(), "revoked lease prepared"); }
    if (fence == 2) { auto op = c.Prepare(); Check(bool(op), "missing operation"); c.current = false;
      Check(op->Submit(c.Current()).result == Receipt::Result::Rejected, "stale current submitted"); }
    if (fence == 3) { auto op = c.Prepare(); Check(bool(op), "missing operation"); c.fixture.authority->Invalidate();
      Check(op->Submit(c.Current()).result == Receipt::Result::Rejected, "stale lease submitted"); }
    if (fence == 4) { c.state->preparing = [&] { c.current = false; };
      Check(!c.Prepare(), "revocation during hardware prepare escaped"); }
    if (fence == 5) { c.state->preparing = [&] { c.fixture.authority->Invalidate(); };
      Check(!c.Prepare(), "lease revocation during hardware prepare escaped"); }
    Check(c.transport->writes == 0 && c.transport->receipts == 0, "fence made a network call"); c.Stop();
  }
  for (bool scene : {false, true}) {
    Case c(scene); auto operation = c.Prepare(); Check(bool(operation), "unknown fixture missing operation");
    c.transport->unknown = true;
    const auto key = operation->ReceiptKey(), query = operation->ReceiptQuery();
    Check(operation->Submit(c.Current()).result == Receipt::Result::Unknown, "ambiguous write was made decisive");
    Check(operation->Submit(c.Current()).result == Receipt::Result::Unknown && c.transport->writes == 1, "unknown write was resent");
    c.fixture.doc["revision"] = std::string(64, 'c'); c.fixture.doc["api_token"] = std::string(64, 'd');
    c.fixture.Renew(); const auto lease = *c.fixture.authority->Read(); c.hardware->Refresh(lease);
    c.transport->not_found = true;
    const auto source = lease.grant->sources.at("processor");
    Check(c.port->Reconcile(c.candidate, source, space, key, query, lease, c.Current()).result == Receipt::Result::Unknown, "not_found falsely rejected a possible commit");
    c.transport->not_found = false;
    Check(c.port->Reconcile(c.candidate, source, space, key, query, lease, c.Current()).result == Receipt::Result::Committed, "frozen receipt did not recover commit");
    Check(c.transport->writes == 1 && c.transport->receipts == 2 && c.state->prepares == 1 &&
      c.transport->revision == std::string(64, 'c'), "reconcile resent/re-encoded or used stale credentials");
    c.current = false;
    Check(c.port->Reconcile(c.candidate, source, space, key, query, lease, c.Current()).result == Receipt::Result::Unknown && c.transport->receipts == 2, "revoked receipt queried");
    c.Stop();
  }
  for(bool scene:{false,true})for(bool changed:{false,true}){
    Case c(scene);c.Probe(scene);std::vector<float> baseline(768,0);baseline[changed?1:0]=1;
    const auto prepared=c.port->PrepareProbe(*c.frame,space,c.lease,baseline,c.Current());
    Check(prepared.distance.has_value(),"probe_did_not_compare_real_fixture_descriptor");
    if(!changed){
      Check(prepared.result==SearchSamplingProbePreparation::Result::NoChange&&!prepared.operation&&*prepared.distance<.25,"nochange_operation_not_empty");
      Check(c.transport->writes==0&&c.transport->receipts==0&&c.state->prepares==1,"nochange_wrote_or_reinferred");
    }else{
      Check(prepared.result==SearchSamplingProbePreparation::Result::Write&&prepared.operation&&*prepared.distance>=.25,"changed_probe_not_prepared");
      c.transport->frozen_query=prepared.operation->ReceiptQuery();c.transport->fingerprint=Json::parse(c.transport->frozen_query).at("request_fingerprint");
      Check(prepared.operation->Descriptor().size()==768,"operation_descriptor_borrow_lost");
      Check(prepared.operation->Submit(c.Current()).result==Receipt::Result::Committed,"changed_probe_write_failed");
      const auto audit=c.transport->written_sample.at("evidence").at("appearance");
      Check(audit.at("metric")==kSearchAppearanceMetric&&audit.at("reference_fingerprint")==std::string(64,'e')&&
        audit.at("threshold")==.25&&audit.at("threshold_experimental")==true&&audit.at("distance")==*prepared.distance,"actual_appearance_audit_missing");
    }
    c.Stop();
  }
  for(int invalid=0;invalid<7;++invalid){
    Case c(false);c.Probe(false);std::vector<float> baseline(768,1);
    if(invalid==0)baseline.clear();
    if(invalid==1)baseline.assign(2,1);
    if(invalid==2)baseline.assign(768,0);
    if(invalid==3)baseline[0]=std::numeric_limits<float>::quiet_NaN();
    if(invalid==4)c.current=false;
    if(invalid==5)c.state->preparing=[&]{c.current=false;};
    if(invalid==6)c.state->preparing=[&]{c.fixture.authority->Invalidate();};
    const auto prepared=c.port->PrepareProbe(*c.frame,space,c.lease,baseline,c.Current());
    Check(prepared.result==SearchSamplingProbePreparation::Result::NotReady&&!prepared.operation,"invalid_descriptor_claimed_nochange");
    Check(c.transport->writes==0&&c.transport->receipts==0,"invalid_probe_network");c.Stop();
  }
  std::cout << "search execution composition: " << checks << " checks passed; fake hardware and transport, no SDK/network\n";
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; } }
