// Copyright AINVR. Real factory missing-model boundary; never loads hardware.
#include "routes.hpp"
#include <gtest/gtest.h>
#include <openssl/evp.h>
using namespace ainvr::flow;
TEST(FlowStartup,MissingOptionalModelKeepsListenerAlive){
  std::string token(32,'t');
  auto runtime=std::make_shared<Runtime>([&]{return token;},[]{return true;},
    NativeFactory("/proc/self/ainvr-neuflow-intentionally-absent"));
  httplib::Server server;Register(server,runtime);
  server.Get("/livez",[](const auto&,auto& res){res.set_content("alive","text/plain");});
  int port=server.bind_to_any_port("127.0.0.1");ASSERT_GT(port,0);
  std::thread listener([&]{server.listen_after_bind();});
  for(int i=0;i<200&&!server.is_running();++i)std::this_thread::sleep_for(std::chrono::milliseconds(5));
  httplib::Client client("127.0.0.1",port);client.set_read_timeout(3);
  auto before=client.Get("/livez");EXPECT_TRUE(before&&before->status==200);
  const std::vector<uint8_t> jpeg{255,216,255,192,0,8,8,1,128,2,0,3,255,217};
  std::string encoded(4*((jpeg.size()+2)/3)+1,'\0');
  encoded.resize(EVP_EncodeBlock(reinterpret_cast<unsigned char*>(encoded.data()),jpeg.data(),jpeg.size()));
  auto response=client.Post("/internal/ptz/flow",{{"x-service-token",token}},
    Json{{"frame0",encoded},{"frame1",encoded}}.dump(),"application/json");
  EXPECT_TRUE(response&&response->status==503);
  if(response)EXPECT_EQ(Json::parse(response->body)["error"]["code"],"flow_model_missing");
  auto after=client.Get("/livez");EXPECT_TRUE(after&&after->status==200);
  server.stop();listener.join();runtime->Stop();
}
