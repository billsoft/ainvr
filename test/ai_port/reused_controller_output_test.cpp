// Copyright AINVR. Exercise the reused controller's real HTTP and persistence.
#include <gtest/gtest.h>
#include <httplib.h>
#include <filesystem>
#include <fstream>
#include <thread>
#include <unistd.h>
#include "api/control_server.hpp"
#include "pipeline/unavailable_worker.hpp"
using nlohmann::json;
namespace cfg = ai_service::config;
namespace api = ai_service::api;
namespace fs = std::filesystem;

class OutputConfigTest : public ::testing::Test {
 protected:
  void SetUp() override {
    dir = fs::temp_directory_path() / ("ainvr-output-controller-" + std::to_string(getpid()));
    fs::create_directories(dir);
    cfg::ChannelConfig ch;
    ch.id = "door"; ch.name = "大门"; ch.enabled = true; ch.manually_stopped = true;
    ch.stream.url = "http://127.0.0.1:8080/live/xm.flv"; ch.stream.protocol = "flv";
    ch.model.adapter = "yolo26_end2end"; ch.model.provider = "cpu";
    ch.model.path = "models/yolo26m.onnx";
    json base{{"server",{{"host","127.0.0.1"},{"port",8000},
      {"api_key",std::string(32,'x')}}},{"channels",json::array({cfg::ChannelConfigToJson(ch)})}};
    std::ofstream(dir / "base.json") << base.dump();
    store = std::make_shared<cfg::ConfigStore>(dir / "base.json", dir / "overlay.json");
    manager = MakeManager();
    api::RegisterRoutes(server, manager);
    port = server.bind_to_any_port("127.0.0.1"); ASSERT_GT(port,0);
    thread = std::thread([&]{ server.listen_after_bind(); });
    for(int i=0;i<40&&!server.is_running();++i) std::this_thread::sleep_for(std::chrono::milliseconds(25));
    ASSERT_TRUE(server.is_running());
  }
  std::shared_ptr<api::ChannelManager> MakeManager() {
    return std::make_shared<api::ChannelManager>(store->Load(), store,
      [](const cfg::ChannelConfig& ch,const cfg::SnapshotStoreConfig&){
        return std::make_shared<ai_service::pipeline::UnavailableWorker>(ch);
      },[this]{return licensed;});
  }
  void TearDown() override {
    server.stop(); if(thread.joinable())thread.join(); manager.reset();
    fs::remove_all(dir);
  }
  httplib::Result Save(const json& patch) {
    httplib::Client client("127.0.0.1",port);
    return client.Put("/api/v1/channels/door/config",headers,patch.dump(),"application/json");
  }
  bool licensed = false;
  fs::path dir;
  std::shared_ptr<cfg::ConfigStore> store;
  std::shared_ptr<api::ChannelManager> manager;
  httplib::Server server;
  std::thread thread;
  int port;
  httplib::Headers headers{{"x-api-key",std::string(32,'x')}};
};

TEST_F(OutputConfigTest, SavesSelectedOutputWithStoppedLegacyModelAndSurvivesReload) {
  auto r=Save({{"stream",{{"url","rtmp://127.0.0.1:1935/live/xm"},{"protocol","rtmp"}}},
    {"publish",{{"enabled",true},{"target_url","rtmp://127.0.0.1:1935/live/ai-n2q08c"}}}});
  ASSERT_TRUE(r); ASSERT_EQ(r->status,200) << r->body;
  auto view=json::parse(r->body).at("channel");
  EXPECT_EQ(view["state"],"idle"); EXPECT_TRUE(view["config"]["manually_stopped"]);
  EXPECT_EQ(view["config"]["publish"]["effective_target_url"],"rtmp://127.0.0.1:1935/live/ai-n2q08c");
  auto reloaded=MakeManager()->ListAll();
  ASSERT_EQ(reloaded.size(),1); EXPECT_EQ(reloaded[0]["config"]["publish"],view["config"]["publish"]);
  EXPECT_EQ(reloaded[0]["stats"]["inference_count"],0);
}

TEST_F(OutputConfigTest, RejectsSourceLoopWithoutWritingOverlay) {
  auto before=store->LoadRawMerged();
  auto r=Save({{"publish",{{"enabled",true},{"target_url","rtmp://192.168.100.189:1935/live/xm"}}}});
  ASSERT_TRUE(r); EXPECT_EQ(r->status,422) << r->body;
  EXPECT_EQ(store->LoadRawMerged(),before);
}

TEST_F(OutputConfigTest, UnavailableBpuCannotStartOrClearPersistedStopIntent) {
  auto r=Save({{"model",{{"adapter","yolo26_bpu"},{"provider","bpu"},
    {"path","models/derived/s100p/yolo26m.hbm"}}}});
  ASSERT_TRUE(r); ASSERT_EQ(r->status,200) << r->body;
  licensed=true;
  httplib::Client client("127.0.0.1",port);
  auto started=client.Post("/api/v1/channels/door/start",headers,"","application/json");
  ASSERT_TRUE(started); EXPECT_EQ(started->status,422) << started->body;
  EXPECT_EQ(json::parse(started->body)["error"]["code"],"bpu_model_not_ready");
  EXPECT_TRUE(store->Load().channels.at(0).manually_stopped);
  EXPECT_EQ(manager->Get("door")->State(),ai_service::pipeline::ChannelState::kIdle);
  licensed=false;
}

namespace {
// No decoder/inference/archival execution. This double verifies only the real
// controller's validation-before-persistence order and stop/config semantics.
class SnapshotPatchWorker : public ai_service::pipeline::ChannelWorker {
 public:
  explicit SnapshotPatchWorker(cfg::ChannelConfig c,bool running)
    :config_(std::make_shared<const cfg::ChannelConfig>(std::move(c))),
     state_(running?ai_service::pipeline::ChannelState::kRunning:ai_service::pipeline::ChannelState::kIdle){}
  void Start() override {++starts;state_=ai_service::pipeline::ChannelState::kRunning;}
  void Stop() override {++stops;state_=ai_service::pipeline::ChannelState::kIdle;}
  ai_service::pipeline::ChannelState State() const override {return state_;}
  void SetLicenseCheck(std::function<bool()>) override {}
  void SetSearchProducerLeaseReader(cfg::SearchProducerLeaseReader reader) override {
    ++reader_installs; search_reader = std::move(reader);
  }
  void SetSnapshotSink(std::shared_ptr<ai_service::pipeline::SnapshotSink>) override {}
  std::shared_ptr<const cfg::ChannelConfig> Config() const override {return config_;}
  void ApplyHotPatch(const cfg::ChannelConfig& c,const std::set<std::string>&) override {
    ++patches;config_=std::make_shared<const cfg::ChannelConfig>(c);
  }
  nlohmann::json GetStats() const override {return {{"frame_count",0},{"inference_count",0}};}
  ai_service::ResultBuffer& GetResultBuffer() override {return results_;}
  // Becomes a virtual override when the platform validation hook is present.
  void ValidateSnapshotResources(const cfg::ChannelConfig& c) const {
    ++checks;
    if(c.snapshot.enabled && c.snapshot.face_enhance_model!="none")
      throw api::ApiError(422,"face_model_not_ready","TEST ONLY missing enhancement model");
  }
  mutable int checks=0;int starts=0,stops=0,patches=0;
  int reader_installs=0;
  cfg::SearchProducerLeaseReader search_reader;
 private:
  std::shared_ptr<const cfg::ChannelConfig> config_;
  ai_service::pipeline::ChannelState state_;
  ai_service::ResultBuffer results_{30};
};
struct SnapshotPatchFixture {
  fs::path directory;
  std::shared_ptr<cfg::ConfigStore> store;
  std::shared_ptr<SnapshotPatchWorker> worker;
  std::vector<std::shared_ptr<SnapshotPatchWorker>> created_workers;
  std::shared_ptr<api::ChannelManager> manager;
  bool licensed=false;
  explicit SnapshotPatchFixture(bool running, cfg::SearchProducerLeaseReader reader = {}) {
    directory=fs::temp_directory_path()/("ainvr-snapshot-patch-"+std::to_string(getpid()));
    fs::create_directory(directory);
    cfg::ChannelConfig c;c.id="isolated-snapshot-patch";c.name="TEST ONLY";
    c.manually_stopped=!running;c.stream.url="rtmp://127.0.0.1:1935/live/never-open";
    c.snapshot.enabled=false;c.model.adapter="yoloface_bpu";c.model.provider="bpu";
    c.model.name="face_detector";c.model.path="missing-test-only.hbm";
    std::ofstream(directory/"base.json")<<json{
      {"snapshot_store",{{"mongo_uri","mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=20"},
        {"db_name","ainvr_snapshot_preflight_test_"+std::to_string(getpid())}}},
      {"channels",json::array({cfg::ChannelConfigToJson(c)})}}.dump();
    store=std::make_shared<cfg::ConfigStore>(directory/"base.json",directory/"overlay.json");
    manager=std::make_shared<api::ChannelManager>(store->Load(),store,
      [this,running](const cfg::ChannelConfig& ch,const cfg::SnapshotStoreConfig&){
        worker=std::make_shared<SnapshotPatchWorker>(ch,running);created_workers.push_back(worker);return worker;
      },[this]{return licensed;},
      std::function<void(const cfg::SnapshotStoreConfig&, const std::string&)>{},std::move(reader));
    licensed=true; // Keep this control-only fixture from constructing a real archive.
  }
  ~SnapshotPatchFixture(){manager.reset();worker.reset();fs::remove_all(directory);}
};
}
TEST(SnapshotPatchPreflight, RunningFailurePreservesPersistedAndLiveConfig) {
  SnapshotPatchFixture f(true);const auto before=f.store->LoadRawMerged();
  EXPECT_THROW(f.manager->UpdateChannelConfig("isolated-snapshot-patch",
    {{"name","must-not-save"},{"snapshot",{{"enabled",true},{"face_enhance_model","gpen"}}}}),api::ApiError);
  EXPECT_EQ(f.store->LoadRawMerged(),before);EXPECT_EQ(f.worker->Config()->name,"TEST ONLY");
  EXPECT_EQ(f.worker->checks,1);EXPECT_EQ(f.worker->patches,0);EXPECT_EQ(f.worker->stops,0);
}
TEST(SnapshotPatchPreflight, StoppedChannelCanSaveModelPreparationWithoutStarting) {
  SnapshotPatchFixture f(false);
  EXPECT_NO_THROW(f.manager->UpdateChannelConfig("isolated-snapshot-patch",
    {{"snapshot",{{"enabled",true},{"face_enhance_model","gpen"}}}}));
  EXPECT_TRUE(f.store->Load().channels.at(0).snapshot.enabled);
  EXPECT_TRUE(f.store->Load().channels.at(0).manually_stopped);
  EXPECT_EQ(f.worker->checks,0);EXPECT_EQ(f.worker->starts,0);
}
TEST(SnapshotPatchPreflight, UnrelatedHotFieldsRemainEditable) {
  SnapshotPatchFixture f(true);
  EXPECT_NO_THROW(f.manager->UpdateChannelConfig("isolated-snapshot-patch",{{"name","renamed"}}));
  EXPECT_EQ(f.worker->Config()->name,"renamed");EXPECT_EQ(f.worker->checks,0);
}

TEST(SnapshotPatchPreflight, LicenseRecoveryRestoresStoppedHistoryWithoutStartingInference) {
  SnapshotPatchFixture f(false);
  const auto before = f.store->LoadRawMerged();
  ASSERT_EQ(f.manager->GetSnapshotStore("isolated-snapshot-patch"), nullptr);
  f.manager->ScheduleAllEnabled();
  for (int i = 0; i < 100 && !f.manager->GetSnapshotStore("isolated-snapshot-patch"); ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  ASSERT_NE(f.manager->GetSnapshotStore("isolated-snapshot-patch"), nullptr);
  f.manager->ScheduleAllEnabled();
  EXPECT_EQ(f.worker->starts, 0);
  EXPECT_TRUE(f.store->Load().channels.at(0).manually_stopped);
  EXPECT_EQ(f.store->LoadRawMerged(), before);
  // The fixture deliberately uses a closed database port. Creating the store
  // is not evidence of Mongo connectivity or permission to claim readiness.
  EXPECT_FALSE(f.manager->GetSnapshotStore("isolated-snapshot-patch")->GetStats().value("connected", false));
  f.manager->StopAll();
  EXPECT_EQ(f.manager->GetSnapshotStore("isolated-snapshot-patch"), nullptr);
}

TEST(SearchProducerWiring, InjectsReaderForInitialAddedAndRebuiltWorkersWithoutStartingThem) {
  auto lifetime = std::make_shared<int>(0);
  cfg::SearchProducerLeaseReader reader = [weak = std::weak_ptr<int>(lifetime)]() -> std::optional<cfg::SearchProducerLease> {
    if (const auto live = weak.lock()) ++*live;
    return std::nullopt;
  };
  SnapshotPatchFixture f(false, reader); f.licensed = false; // No archives, decoder or inference.
  ASSERT_EQ(f.created_workers.size(), 1);
  const auto original = f.worker;
  ASSERT_TRUE(original->search_reader); EXPECT_EQ(original->reader_installs, 1);
  EXPECT_FALSE(original->search_reader()); EXPECT_EQ(*lifetime, 1);
  auto added = *original->Config(); added.id = "isolated-search-added"; added.name = "TEST added";
  added.enabled = false; added.stream.url = "rtmp://127.0.0.1:1935/live/never-open-added";
  auto creation = cfg::ChannelConfigToJson(added); creation.erase("manually_stopped"); creation.erase("deletion_pending");
  EXPECT_NO_THROW(f.manager->CreateChannel(creation));
  ASSERT_EQ(f.created_workers.size(), 2); ASSERT_TRUE(f.created_workers[1]->search_reader);
  EXPECT_NO_THROW(f.manager->UpdateChannelConfig("isolated-snapshot-patch",
    {{"stream", {{"url", "rtmp://127.0.0.1:1935/live/never-open-rebuilt"}}}}));
  ASSERT_EQ(f.created_workers.size(), 3);
  EXPECT_NE(f.manager->Get("isolated-snapshot-patch"), original);
  for (const auto& worker : f.created_workers) {
    ASSERT_TRUE(worker->search_reader); EXPECT_EQ(worker->reader_installs, 1);
    EXPECT_FALSE(worker->search_reader()); EXPECT_EQ(worker->starts, 0);
  }
  EXPECT_EQ(*lifetime, 4);
  lifetime.reset(); // Retained old workers cannot dereference a destroyed provider owner.
  for (const auto& worker : f.created_workers) EXPECT_FALSE(worker->search_reader());
}

TEST(SearchProducerWiring, DefaultReaderKeepsExistingWorkerSubstitutesInert) {
  SnapshotPatchFixture f(false);
  EXPECT_EQ(f.worker->reader_installs, 1);
  EXPECT_FALSE(f.worker->search_reader);
  EXPECT_EQ(f.worker->starts, 0);
}
