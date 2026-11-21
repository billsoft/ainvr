// Copyright AINVR. Software-only tests; no models or media hardware opened.
#include "routes.hpp"
#include <gtest/gtest.h>
#include <limits>
#include <filesystem>
using namespace ainvr::flow;
namespace {
std::string Encode(const std::vector<uint8_t>& bytes){
  static const char* alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string s;
  for(size_t i=0;i<bytes.size();i+=3){unsigned a=bytes[i],b=i+1<bytes.size()?bytes[i+1]:0,c=i+2<bytes.size()?bytes[i+2]:0;
    s+=alphabet[a>>2];s+=alphabet[((a&3)<<4)|(b>>4)];s+=i+1<bytes.size()?alphabet[((b&15)<<2)|(c>>6)]:'=';
    s+=i+2<bytes.size()?alphabet[c&63]:'=';}
  return s;
}
std::string Body(){
  // Header-only JPEG suffices for metadata tests; fake backend never decodes it.
  auto s=Encode({255,216,255,192,0,8,8,1,128,2,0,3,255,217});
  return Json{{"frame0",s},{"frame1",s}}.dump();
}
Peer Local(){return {"127.0.0.1",std::string(32,'t')};}
struct Fake:Backend{
  std::function<void(const Current&)> work;
  Json Match(const std::vector<uint8_t>&,const std::vector<uint8_t>&,const Current&)override{return Json{{"matched",false},{"schema","ainvr.scene-match.v2"}};}
  Json Run(const std::vector<uint8_t>&,const std::vector<uint8_t>&,const Current& c)override{
    if(work)work(c);return Reduce(std::vector<float>(2*kPixels,0));
  }
};
}
TEST(Flow,Authentication){
  EXPECT_TRUE(Authorized(Local(),std::string(32,'t')));
  EXPECT_FALSE(Authorized({"192.168.100.1",Local().token},Local().token));
  EXPECT_FALSE(Authorized({"127.0.0.1",""},Local().token));
  EXPECT_FALSE(Authorized(Local(),std::string(32,'x')));
}
TEST(Flow,ProductionModelRoot){
  EXPECT_EQ((std::filesystem::path("/home/sunrise/ainvr/ai-service")/kModel).string(),
    "/home/sunrise/ainvr/ai-service/models/search/hbm/neuflow-v2-384x512-i16-o2.hbm");
}
TEST(Flow,StrictPair){
  EXPECT_NO_THROW(Parse(Body()));
  for(auto s:{"", "{}", "[]", "{\"frame0\":2,\"frame1\":3}"})EXPECT_THROW(Parse(s),Error);
  for(auto s:{"data:image/jpeg;base64,/9g=", "////\n", "A===", "AB==", "AAB=", "AA=A", "!!!!"})EXPECT_THROW(DecodeJpeg(s),Error);
  EXPECT_THROW(DecodeJpeg(std::string(kMaxEncoded+4,'A')),Error);
  EXPECT_THROW(Parse(std::string(kMaxBody+1,' ')),Error);
}
TEST(Flow,SignedMeanAndWholeVectorTrim){
  std::vector<float> v(2*kPixels);
  std::fill(v.begin(),v.begin()+kPixels,-7.25f);std::fill(v.begin()+kPixels,v.end(),3.5f);
  for(size_t i=0;i<1000;++i){v[i]=40;v[kPixels+i]=-20;}
  auto r=Reduce(v);EXPECT_DOUBLE_EQ(r["dx"],-7.25);EXPECT_DOUBLE_EQ(r["dy"],3.5);
  EXPECT_EQ(r["inliers"],kPixels-1000);EXPECT_DOUBLE_EQ(r["spread"],0);
  EXPECT_DOUBLE_EQ(r["validRatio"],double(kPixels-1000)/kPixels);
}
TEST(Flow,FiniteAndLowSupport){
  std::vector<float> v(2*kPixels,1);v[0]=std::numeric_limits<float>::quiet_NaN();
  auto r=Reduce(v);EXPECT_EQ(r["inliers"],kPixels-1);
  std::fill(v.begin(),v.end(),std::numeric_limits<float>::infinity());EXPECT_THROW(Reduce(v),Error);
}
TEST(Flow,LazyAndAuthorizationBeforeParsing){
  int loads=0;
  Runtime runtime([]{return Local().token;},[]{return true;},[&]{++loads;return std::make_unique<Fake>();});
  EXPECT_EQ(loads,0);
  try{runtime.Call("not-json",{"127.0.0.1","bad"});FAIL();}catch(const Error& e){EXPECT_EQ(e.status,403);}
  EXPECT_EQ(loads,0);EXPECT_NO_THROW(runtime.Call(Body(),Local()));EXPECT_EQ(loads,1);
  EXPECT_NO_THROW(runtime.Call(Body(),Local()));EXPECT_EQ(loads,1);
}
TEST(Flow,BusyAndDeadlineKeepWorkerOccupied){
  std::promise<void> started,release;auto gate=release.get_future().share();
  Runtime runtime([]{return Local().token;},[]{return true;},[&]{auto p=std::make_unique<Fake>();
    p->work=[&](const Current& c){started.set_value();gate.wait();Check(c);};return p;},std::chrono::milliseconds(80));
  auto first=std::async(std::launch::async,[&]{try{runtime.Call(Body(),Local());return 0;}catch(const Error& e){return e.status;}});
  started.get_future().wait();
  try{runtime.Call(Body(),Local(),true);FAIL();}catch(const Error& e){EXPECT_EQ(e.status,429);}
  try{runtime.Call(Body(),Local());FAIL();}catch(const Error& e){EXPECT_EQ(e.status,429);}
  EXPECT_EQ(first.get(),504);
  try{runtime.Call(Body(),Local());FAIL();}catch(const Error& e){EXPECT_EQ(e.status,429);}
  release.set_value();runtime.Stop();
}
TEST(Flow,RevocationBeforePublication){
  std::atomic<bool> allowed{true};
  Runtime runtime([]{return Local().token;},[&]{return allowed.load();},[&]{auto p=std::make_unique<Fake>();
    p->work=[&](const Current&){allowed=false;};return p;});
  EXPECT_THROW(runtime.Call(Body(),Local()),Error);
}
TEST(Flow,HttpRouteAuthAndPair){
  auto runtime=std::make_shared<Runtime>([]{return Local().token;},[]{return true;},[]{return std::make_unique<Fake>();});
  httplib::Server server;Register(server,runtime);server.set_payload_max_length(kMaxBody);
  int port=server.bind_to_any_port("127.0.0.1");ASSERT_GT(port,0);
  std::thread listener([&]{server.listen_after_bind();});
  for(int i=0;i<200&&!server.is_running();++i)std::this_thread::sleep_for(std::chrono::milliseconds(5));
  httplib::Client client("127.0.0.1",port);client.set_read_timeout(2);
  auto unauthorized=client.Post("/internal/ptz/flow","garbage","application/json");
  EXPECT_TRUE(unauthorized&&unauthorized->status==403);
  auto result=client.Post("/internal/ptz/flow",{{"x-service-token",Local().token}},Body(),"application/json");
  EXPECT_TRUE(result&&result->status==200);
  if(result&&result->status==200){auto j=Json::parse(result->body);for(auto key:{"dx","dy","width","height","inliers","validRatio","spread"})EXPECT_TRUE(std::isfinite(j[key].get<double>()));}
  auto sceneDenied=client.Post("/internal/ptz/scene-match","garbage","application/json");
  EXPECT_TRUE(sceneDenied&&sceneDenied->status==403);
  auto scene=client.Post("/internal/ptz/scene-match",{{"x-service-token",Local().token}},Body(),"application/json");
  EXPECT_TRUE(scene&&scene->status==200);
  if(scene&&scene->status==200){
  EXPECT_EQ(Json::parse(scene->body)["schema"],"ainvr.scene-match.v2");
  EXPECT_FALSE(Json::parse(scene->body)["matched"]);
  }
  server.stop();listener.join();
}
