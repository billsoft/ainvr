// Control-only tests: no stream, decoder, model or BPU inference is started.
#include "pipeline/reused_channel_worker.hpp"
#include <gtest/gtest.h>
#include <httplib.h>
#include <filesystem>
#include <fstream>
#include <thread>
#include <unistd.h>
#include "api/control_server.hpp"
using nlohmann::json;
namespace cfg=ai_service::config;
namespace ptzPipeline=ai_service::pipeline;
TEST(PtzAnalyticsReset, ClearsOldResultsIdempotentlyWithoutRestartingMedia){
 cfg::ChannelConfig config;config.id="ptz-reset-only";config.manually_stopped=true;
 ptzPipeline::ReusedChannelWorker worker(config);
 worker.GetResultBuffer().Append(ai_service::FrameResult{});
 EXPECT_TRUE(worker.SupportsAnalyticsReset());
 EXPECT_TRUE(worker.ResetAnalytics("generation-one"));EXPECT_EQ(worker.GetResultBuffer().Size(),0);
 worker.GetResultBuffer().Append(ai_service::FrameResult{});
 EXPECT_TRUE(worker.ResetAnalytics("generation-one"));EXPECT_EQ(worker.GetResultBuffer().Size(),1);
 EXPECT_FALSE(worker.ResetAnalytics(""));EXPECT_FALSE(worker.ResetAnalytics(std::string(129,'x')));
 EXPECT_EQ(worker.GetResultBuffer().Size(),1);
 EXPECT_TRUE(worker.ResetAnalytics("generation-two"));EXPECT_EQ(worker.GetResultBuffer().Size(),0);
 EXPECT_EQ(worker.State(),ptzPipeline::ChannelState::kIdle);
 EXPECT_EQ(worker.GetStats().value("inference_count",0),0);
}
TEST(PtzAnalyticsReset, RealAuthenticatedEndpointValidatesAndAppliesReset){
 namespace fs=std::filesystem;
 const auto dir=fs::temp_directory_path()/("ainvr-ptz-api-"+std::to_string(getpid()));fs::create_directories(dir);
 cfg::ChannelConfig config;config.id="ptz-test";config.name="TEST ONLY";config.manually_stopped=true;config.snapshot.enabled=false;config.stream.url="rtmp://127.0.0.1:1935/live/never-open";config.stream.protocol="rtmp";config.model.adapter="yolo26_bpu";config.model.provider="bpu";config.model.path="missing-test-only.hbm";
 std::ofstream(dir/"base.json")<<json{{"server",{{"host","127.0.0.1"},{"port",8000},{"api_key",std::string(32,'x')}}},{"channels",json::array({cfg::ChannelConfigToJson(config)})}}.dump();
 auto store=std::make_shared<cfg::ConfigStore>(dir/"base.json",dir/"overlay.json");
 auto manager=std::make_shared<ai_service::api::ChannelManager>(store->Load(),store,[](const cfg::ChannelConfig& c,const cfg::SnapshotStoreConfig&){return std::make_shared<ptzPipeline::ReusedChannelWorker>(c);},[]{return false;});
 httplib::Server server;ai_service::api::RegisterRoutes(server,manager);const int port=server.bind_to_any_port("127.0.0.1");ASSERT_GT(port,0);
 std::thread thread([&]{server.listen_after_bind();});
 struct Cleanup{httplib::Server& server;std::thread& thread;fs::path dir;~Cleanup(){server.stop();if(thread.joinable())thread.join();fs::remove_all(dir);}}cleanup{server,thread,dir};
 for(int i=0;i<40&&!server.is_running();i++)std::this_thread::sleep_for(std::chrono::milliseconds(25));ASSERT_TRUE(server.is_running());
 httplib::Client client("127.0.0.1",port);httplib::Headers auth{{"x-api-key",std::string(32,'x')}};
 const std::string path="/api/v1/channels/ptz-test/analytics/reset";
 const json valid{{"reason","ptz_view_change"},{"generation","test-generation-1"}};
 auto denied=client.Post(path.c_str(),valid.dump(),"application/json");ASSERT_TRUE(denied);EXPECT_EQ(denied->status,401);
 const auto before=store->LoadRawMerged();
 for(const auto& invalid:std::vector<json>{json::array(),json{{"reason",5},{"generation","x"}},json{{"reason","other"},{"generation","x"}},json{{"reason","ptz_view_change"},{"generation",""}},json{{"reason","ptz_view_change"},{"generation","x/y"}},json{{"reason","ptz_view_change"},{"generation","x"},{"extra",true}}}){
  auto response=client.Post(path.c_str(),auth,invalid.dump(),"application/json");ASSERT_TRUE(response);EXPECT_EQ(response->status,422)<<response->body;
 }
 auto listed=client.Get("/api/v1/channels",auth);ASSERT_TRUE(listed);ASSERT_EQ(listed->status,200);
 EXPECT_TRUE(json::parse(listed->body).at("channels").at(0).value("analytics_reset_supported",false));
 auto worker=manager->Get("ptz-test");worker->GetResultBuffer().Append(ai_service::FrameResult{});
 for(int i=0;i<2;i++){auto response=client.Post(path.c_str(),auth,valid.dump(),"application/json");ASSERT_TRUE(response);EXPECT_EQ(response->status,200)<<response->body;EXPECT_TRUE(json::parse(response->body).value("reset",false));}
 EXPECT_EQ(worker->GetResultBuffer().Size(),0);EXPECT_EQ(worker->State(),ptzPipeline::ChannelState::kIdle);EXPECT_EQ(store->LoadRawMerged(),before);
}
